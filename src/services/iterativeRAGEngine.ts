import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { query } from '../config/db.js';
import type { RAGSource, RAGResult } from './ragEngine.js';

export class IterativeRAGEngine {
  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private options: { maxContextParagraphs?: number } = {}
  ) {}

  async query(
    userQuery: string,
    topDocs = 5,
    topParagraphs = 3
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
      const subSources = await this.searchParagraphs(candidateIds, highQueryVector, topParagraphs);
      initialSourcesList.push(...subSources);
    }

    // Mezclar y deduplicar fuentes iniciales
    let sources = this.mergeSources([], initialSourcesList, maxCtx);
    if (sources.length === 0) {
      return { answer: 'No se encontraron documentos relacionados con tu consulta.', sources: [], iterations: 1 };
    }

    // 4. Formatear contexto enriquecido para la evaluación del LLM
    const formatContext = (srcs: RAGSource[]) => srcs
      .map((p, i) => `[Fuente ${i + 1} - ${p.doc_title} (docId: ${(p as any).document_id}, paragraphIndex: ${(p as any).paragraph_index})]:\n${p.contextualized_text}`)
      .join('\n\n');

    const initialContextText = formatContext(sources);

    // 5. Evaluar si el contexto es suficiente o requiere expansión
    const evaluation = await this.llm.evaluateContext(userQuery, initialContextText);

    let iterations = 1;
    if (evaluation.decision === 'expand' && evaluation.expand_requests && evaluation.expand_requests.length > 0) {
      iterations = 2;
      const expanded: RAGSource[] = [];

      for (const req of evaluation.expand_requests) {
        // Resolver robustamente el docId (puede venir como título o UUID)
        let resolvedDocId = req.docId;
        const matching = sources.find(s => 
          (s as any).document_id === req.docId ||
          s.doc_title === req.docId ||
          `Fuente ${sources.indexOf(s) + 1}`.includes(req.docId)
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

      sources = this.mergeSources(sources, expanded, maxCtx);
    }

    const finalContextText = sources
      .map((p, i) => `[Fuente ${i + 1} - ${p.doc_title}]:\n${p.contextualized_text}`)
      .join('\n\n');

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
    limit: number
  ): Promise<RAGSource[]> {
    const res = await query<RAGSource & { document_id: string; paragraph_index: number }>(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title,
              d.r2_key, d.r2_url, p.document_id, p.paragraph_index
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = ANY($1::uuid[])
       ORDER BY p.embedding_high <=> $2::vector LIMIT $3`,
      [docIds, JSON.stringify(queryVector), limit]
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

