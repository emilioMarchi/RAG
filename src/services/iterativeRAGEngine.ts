import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { query } from '../config/db.js';
import type { RAGSource, RAGResult } from './ragEngine.js';

export class IterativeRAGEngine {
  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private options: {
      maxContextParagraphs?: number;
      maxIterations?: number;
    } = {}
  ) {}

  private get maxIterations(): number {
    return this.options.maxIterations ?? 4;
  }

  async query(
    userQuery: string,
    topDocs = 5,
    topParagraphs = 3,
    similarityThreshold = 0
  ): Promise<RAGResult & { iterations: number }> {
    const maxCtx = this.options.maxContextParagraphs ?? 20;

    // 1. Descomponer la query original en sub-consultas
    const subQueries = await this.llm.decomposeQuery(userQuery);
    
    // 2. Buscar documentos candidatos para cada sub-consulta
    const candidateIdsSet = new Set<string>();
    for (const subQ of subQueries) {
      const baseQueryVector = await this.embedder.generateEmbedding(subQ, 768);
      const candidateDocsRes = await query<{ id: string; title: string }>(
        `SELECT id, title FROM documents
         ORDER BY embedding_base <=> $1::vector LIMIT $2`,
        [JSON.stringify(baseQueryVector), topDocs]
      );
      for (const row of candidateDocsRes.rows) {
        candidateIdsSet.add(row.id);
      }
    }

    const candidateIds = Array.from(candidateIdsSet);
    if (candidateIds.length === 0) {
      return { answer: 'No se encontraron documentos relacionados con tu consulta.', sources: [], iterations: 0 };
    }

    // 3. Buscar párrafos candidatos para cada sub-consulta
    const initialSourcesList: RAGSource[] = [];
    for (const subQ of subQueries) {
      const highQueryVector = await this.embedder.generateEmbedding(subQ, 1536);
      const subSources = await this.searchParagraphs(candidateIds, highQueryVector, topParagraphs, similarityThreshold);
      initialSourcesList.push(...subSources);
    }

    // Mezclar y deduplicar fuentes iniciales
    let sources = this.mergeSources([], initialSourcesList, maxCtx);
    if (sources.length === 0) {
      return { answer: 'No se encontraron documentos relacionados con tu consulta.', sources: [], iterations: 1 };
    }

    // 4. Formatear contexto enriquecido para la evaluación del LLM
    const formatContext = (srcs: RAGSource[]) => srcs
      .map((p, i) => `[Fuente ${i + 1} - ${p.doc_title} (fragmento ${(p as any).paragraph_index})]:\n${p.contextualized_text}`)
      .join('\n\n');

    // 5. Bucle iterativo: evaluar si el contexto es suficiente; si pide expandir,
    //    recuperar y volver a evaluar, hasta que el LLM diga "answer", no haya más
    //    información nueva que agregar, o se alcance el tope de iteraciones.
    let iterations = 0;
    let previousCount = -1;

    while (iterations < this.maxIterations) {
      iterations += 1;

      const contextText = formatContext(sources);
      const evaluation = await this.llm.evaluateContext(userQuery, contextText);

      // El LLM considera el contexto suficiente (o la info no está disponible).
      if (evaluation.decision !== 'expand' || !evaluation.expand_requests?.length) {
        break;
      }

      // Recuperar los párrafos solicitados.
      const expanded: RAGSource[] = [];
      for (const req of evaluation.expand_requests) {
        let resolvedDocId = req.docId;
        const matching = sources.find(s =>
          (s as any).document_id === req.docId ||
          s.doc_title === req.docId ||
          s.doc_title.includes(req.docId) ||
          req.docId.includes(s.doc_title)
        );
        if (matching) {
          resolvedDocId = (matching as any).document_id;
        }

        if (resolvedDocId && req.paragraphIndex !== undefined) {
          const adj = await this.adjacentParagraphs(
            resolvedDocId,
            req.paragraphIndex,
            req.direction,
            req.count || 1
          );
          expanded.push(...adj);
        }
      }

      const newSources = this.mergeSources(sources, expanded, maxCtx);

      // No hay información nueva → detenerse (no hay más que recuperar).
      if (newSources.length === previousCount || newSources.length === sources.length) {
        sources = newSources;
        break;
      }

      previousCount = sources.length;
      sources = newSources;
    }

    const finalContextText = formatContext(sources);

    const answer = await this.llm.generateRAGAnswer(userQuery, finalContextText);

    return {
      answer,
      sources,
      iterations,
    };
  }

  private async searchParagraphs(
    docIds: string[],
    queryVector: number[],
    limit: number,
    similarityThreshold = 0
  ): Promise<RAGSource[]> {
    const thresholdClause = similarityThreshold > 0
      ? `AND (1 - (p.embedding_high <=> $2::vector) / 2) >= $3`
      : '';

    const res = await query<RAGSource & { document_id: string; paragraph_index: number }>(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title,
              d.r2_key, d.r2_url, p.document_id, p.paragraph_index,
              (1 - (p.embedding_high <=> $2::vector) / 2) as similarity
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = ANY($1::uuid[])
       ${thresholdClause}
       ORDER BY p.embedding_high <=> $2::vector LIMIT $${thresholdClause ? '4' : '3'}`,
      thresholdClause
        ? [docIds, JSON.stringify(queryVector), similarityThreshold, limit]
        : [docIds, JSON.stringify(queryVector), limit]
    );
    return res.rows;
  }

  private async adjacentParagraphs(
    docId: string,
    paragraphIndex: number,
    direction: 'before' | 'after',
    count: number
  ): Promise<RAGSource[]> {
    const res = await query<RAGSource & { paragraph_index: number; document_id: string }>(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title,
              d.r2_key, d.r2_url, p.document_id, p.paragraph_index
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = $1::uuid
         AND p.paragraph_index ${direction === 'before' ? '<' : '>'} $2
       ORDER BY p.paragraph_index ${direction === 'before' ? 'DESC' : 'ASC'}
       LIMIT $3`,
      [docId, paragraphIndex, count]
    );
    return res.rows;
  }

  private mergeSources(existing: RAGSource[], newSources: RAGSource[], max: number): RAGSource[] {
    const seen = new Set<string>();
    const merged = [...existing, ...newSources].filter((s) => {
      const key = `${(s as any).document_id}-${(s as any).paragraph_index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return merged.slice(0, max);
  }
}

