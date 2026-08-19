import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { HybridSearchService, type ScoredChunk } from './hybridSearchService.js';
import { RerankingService, type RerankStrategy } from './rerankingService.js';
import { CRAGEvaluator } from './cragEvaluator.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { query } from '../config/db.js';
import type { RAGSource, RAGResult } from './ragEngine.js';

/** Lanza la ejecución de una consulta que superó el presupuesto de latencia. */
export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`La consulta RAG superó el presupuesto de ${timeoutMs}ms.`);
    this.name = 'QueryTimeoutError';
  }
}

export class IterativeRAGEngine {
  private hybridSearch: HybridSearchService;
  private reranker: RerankingService;
  private crag: CRAGEvaluator;

  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private options: {
      maxContextParagraphs?: number;
      maxIterations?: number;
      retrievalCandidates?: number;
      finalTopK?: number;
      vectorWeight?: number;
      bm25Weight?: number;
      enableReranking?: boolean;
      rerankStrategy?: RerankStrategy;
      enableParentChunks?: boolean;
      /** Corrective RAG: nº máximo de pases de re-búsqueda (0 = off). Default: 0 */
      cragMaxPasses?: number;
      /** Bucle de expansión de contexto con LLM (evaluateContext). Default: false */
      enableContextExpansion?: boolean;
      /** Usar decomposición de query con LLM. Default: true */
      enableDecompose?: boolean;
      /** Presupuesto global de latencia en ms (0 = sin límite). Default: 0 */
      timeoutMs?: number;
    } = {}
  ) {
    this.hybridSearch = new HybridSearchService();
    this.reranker = new RerankingService(llm, options.rerankStrategy ?? 'hybrid');
    this.crag = new CRAGEvaluator(llm);
  }

  private get maxIterations(): number {
    return this.options.maxIterations ?? 4;
  }

  async query(
    userQuery: string,
    topDocs = 5,
    _topParagraphs = 10,
    _similarityThreshold = 0
  ): Promise<RAGResult & { iterations: number }> {
    const timeoutMs = this.options.timeoutMs ?? 0;
    if (!timeoutMs || timeoutMs <= 0) {
      return this.runQuery(userQuery, topDocs);
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.runQuery(userQuery, topDocs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new QueryTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runQuery(
    userQuery: string,
    topDocs = 5
  ): Promise<RAGResult & { iterations: number }> {
    const {
      maxContextParagraphs = 20,
      retrievalCandidates = 20,
      finalTopK = 7,
      vectorWeight = 0.6,
      bm25Weight = 0.4,
      enableReranking = true,
      enableParentChunks = true,
      cragMaxPasses = 0,
      enableContextExpansion = false,
      enableDecompose = true,
    } = this.options;

    // ── 1. Descomponer la query en sub-consultas ─────────────────────────────
    let subQueries: string[];
    if (enableDecompose) {
      subQueries = await this.llm.decomposeQuery(userQuery);
    } else {
      subQueries = [userQuery];
    }

    // ── 2+3. Búsqueda Híbrida por sub-query + fusión RRF multi-query ────────
    // Cada sub-query se embebe (1536d) y busca en paralelo; se omiten los docIds
    // ([] = todos los párrafos), evitando el doble embedding 768d + filtro de docs.
    const perQueryRankings = await mapConcurrent(
      subQueries,
      async (subQ) => {
        const highVector = await this.embedder.generateEmbedding(subQ, 1536);
        return this.hybridSearch.search(
          [],
          highVector,
          subQ,
          retrievalCandidates,
          vectorWeight,
          bm25Weight
        );
      },
      Math.max(1, Math.min(subQueries.length, 4))
    );

    // RRF multi-query: fusionar todos los rankings de sub-queries
    let sources = this.rrfMergeMultiQuery(perQueryRankings, maxContextParagraphs);

    if (sources.length === 0) {
      return { answer: 'No se encontraron fragmentos relevantes para tu consulta.', sources: [], iterations: 1 };
    }

    // ── 4. Re-ranking ────────────────────────────────────────────────────────
    if (enableReranking) {
      sources = await this.reranker.rerank(userQuery, sources, finalTopK);
    } else {
      sources = sources.slice(0, finalTopK);
    }

    // ── 5. Bucle iterativo de expansión de contexto ──────────────────────────
    const formatContext = (srcs: RAGSource[]) =>
      srcs
        .map((p, i) => {
          const body = p.parent_content ?? p.contextualized_text;
          return `[Fuente ${i + 1} - ${p.doc_title} (fragmento ${p.paragraph_index}) | id:${p.id ?? ''}]:\n${body}`;
        })
        .join('\n\n');

    let iterations = 0;
    let ragSources: RAGSource[] = await this.enrichWithParents(sources as ScoredChunk[], enableParentChunks);

    if (enableContextExpansion) {
      let previousCount = -1;
      while (iterations < this.maxIterations) {
        iterations += 1;

        const contextText = formatContext(ragSources);
        const evaluation = await this.llm.evaluateContext(userQuery, contextText);

        if (evaluation.decision !== 'expand' || !evaluation.expand_requests?.length) break;

        const expanded: RAGSource[] = [];
        for (const req of evaluation.expand_requests) {
          let resolvedDocId = req.docId;
          const matching = ragSources.find(
            s =>
              (s as any).document_id === req.docId ||
              s.doc_title === req.docId ||
              s.doc_title.includes(req.docId) ||
              req.docId.includes(s.doc_title)
          );
          if (matching) resolvedDocId = (matching as any).document_id;

          if (resolvedDocId && req.paragraphIndex !== undefined) {
            const adj = await this.adjacentParagraphs(resolvedDocId, req.paragraphIndex, req.direction, req.count || 1);
            expanded.push(...adj);
          }
        }

        const merged = this.mergeRAGSources(ragSources, expanded, maxContextParagraphs);
        if (merged.length === previousCount || merged.length === ragSources.length) {
          ragSources = merged;
          break;
        }

        previousCount = ragSources.length;
        ragSources = merged;
      }
    }

    // ── 6. Corrective RAG (CRAG) con presupuesto de pases ────────────────────
    let cragDecision = 'RELEVANT';

    if (cragMaxPasses > 0) {
      let budget = cragMaxPasses;
      let currentSources = ragSources;

      while (budget > 0) {
        budget -= 1;
        const evaluation = await this.crag.evaluate(userQuery, currentSources);
        cragDecision = evaluation.decision;
        console.log(`[CRAG] Decision: ${evaluation.decision} | ${evaluation.reason}`);

        if (evaluation.decision === 'RELEVANT' || !evaluation.reformulated_query) break;

        const reformulated = evaluation.reformulated_query;
        console.log(`[CRAG] Re-searching with reformulated query: "${reformulated}"`);

        // Re-búsqueda sin filtro de docs ni doble embedding (1536d único).
        const refVector = await this.embedder.generateEmbedding(reformulated, 1536);
        const refChunks = await this.hybridSearch.search(
          [], refVector, reformulated,
          retrievalCandidates, vectorWeight, bm25Weight
        );
        const refReranked = enableReranking
          ? await this.reranker.rerank(reformulated, refChunks, finalTopK)
          : refChunks.slice(0, finalTopK);

        const refSources = await this.enrichWithParents(refReranked as ScoredChunk[], enableParentChunks);

        // Fusionar con el contexto original (el nuevo tiene prioridad)
        currentSources = this.mergeRAGSources(refSources, currentSources, maxContextParagraphs);
      }

      ragSources = currentSources;
    }

    // ── 7. Respuesta final ──────────────────────────────────────────
    const finalContextText = formatContext(ragSources);
    const answer = await this.llm.generateRAGAnswer(userQuery, finalContextText);

    return { answer, sources: ragSources, iterations, cragDecision };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Fusiona múltiples rankings de sub-queries usando RRF.
   * Cada posición en cada ranking contribuye 1/(k + rank+1) al score final.
   */
  private rrfMergeMultiQuery(
    rankings: ScoredChunk[][],
    maxResults: number,
    k = 60
  ): ScoredChunk[] {
    const scores = new Map<string, number>();
    const chunkMap = new Map<string, ScoredChunk>();

    for (const ranking of rankings) {
      ranking.forEach((chunk, rank) => {
        const prev = scores.get(chunk.id) ?? 0;
        scores.set(chunk.id, prev + 1 / (k + rank + 1));
        if (!chunkMap.has(chunk.id)) chunkMap.set(chunk.id, chunk);
      });
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxResults)
      .map(([id, score]) => ({ ...chunkMap.get(id)!, hybrid_score: score }));
  }

  private async enrichWithParents(chunks: ScoredChunk[], enabled: boolean): Promise<RAGSource[]> {
    if (!enabled) return chunks.map(c => this.toRAGSource(c, undefined));

    const parentIds = [...new Set(chunks.map(c => c.parent_chunk_id).filter(Boolean))] as string[];
    const parentMap = new Map<string, string>();

    if (parentIds.length > 0) {
      const res = await query<{ id: string; content: string }>(
        `SELECT id, content FROM document_parent_chunks WHERE id = ANY($1::uuid[])`,
        [parentIds]
      );
      for (const row of res.rows) parentMap.set(row.id, row.content);
    }

    return chunks.map(c => this.toRAGSource(c, c.parent_chunk_id ? parentMap.get(c.parent_chunk_id) : undefined));
  }

  private toRAGSource(chunk: ScoredChunk, parentContent: string | undefined): RAGSource {
    return {
      id: chunk.id,
      doc_title: chunk.doc_title,
      raw_content: chunk.raw_content,
      contextualized_text: chunk.contextualized_text,
      parent_content: parentContent,
      r2_key: chunk.r2_key,
      r2_url: chunk.r2_url,
      document_id: chunk.document_id,
      paragraph_index: chunk.paragraph_index,
      similarity: chunk.hybrid_score,
    };
  }

  private async adjacentParagraphs(
    docId: string,
    paragraphIndex: number,
    direction: 'before' | 'after',
    count: number
  ): Promise<RAGSource[]> {
    const res = await query<RAGSource & { paragraph_index: number; document_id: string; parent_chunk_id: string | null }>(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title,
              d.r2_key, d.r2_url, p.document_id, p.paragraph_index, p.parent_chunk_id
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

  private mergeRAGSources(existing: RAGSource[], incoming: RAGSource[], max: number): RAGSource[] {
    const seen = new Set<string>();
    return [...existing, ...incoming]
      .filter(s => {
        const key = `${(s as any).document_id}-${(s as any).paragraph_index}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, max);
  }
}
