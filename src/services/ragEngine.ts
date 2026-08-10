import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { HybridSearchService, type ScoredChunk } from './hybridSearchService.js';
import { RerankingService } from './rerankingService.js';
import { query } from '../config/db.js';

export interface RAGSource {
  id?: string;
  doc_title: string;
  raw_content: string;
  contextualized_text: string;
  /** Texto del parent chunk (contexto amplio) — presente si se usó chunking jerárquico */
  parent_content?: string;
  r2_key: string;
  r2_url: string | null;
  document_id?: string;
  paragraph_index?: number;
  similarity?: number;
}

export interface RAGResult {
  answer: string;
  sources: RAGSource[];
  /** Decisión del evaluador CRAG (solo disponible via IterativeRAGEngine) */
  cragDecision?: string;
}

interface ParentChunk {
  id: string;
  content: string;
}

export class HierarchicalRAGModule {
  private hybridSearch: HybridSearchService;
  private reranker: RerankingService;

  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private options: {
      /** Candidatos iniciales para el retriever antes del re-ranking (default 20) */
      retrievalCandidates?: number;
      /** Fragmentos finales pasados al LLM tras re-ranking (default 7) */
      finalTopK?: number;
      /** Peso del ranking vectorial en RRF (default 0.6) */
      vectorWeight?: number;
      /** Peso del ranking BM25 en RRF (default 0.4) */
      bm25Weight?: number;
      /** Activar re-ranking con LLM (default true) */
      enableReranking?: boolean;
      /** Activar recuperación de parent chunks (default true) */
      enableParentChunks?: boolean;
    } = {}
  ) {
    this.hybridSearch = new HybridSearchService();
    this.reranker = new RerankingService(llm);
  }

  async query(userQuery: string, topDocs = 5, _topParagraphs = 10, _similarityThreshold = 0): Promise<RAGResult> {
    const {
      retrievalCandidates = 20,
      finalTopK = 7,
      vectorWeight = 0.6,
      bm25Weight = 0.4,
      enableReranking = true,
      enableParentChunks = true,
    } = this.options;

    // ── CAPA 1: Filtro de documentos candidatos (768d) ──────────────────────
    const baseQueryVector = await this.embedder.generateEmbedding(userQuery, 768);

    const candidateDocsRes = await query<{ id: string; title: string }>(
      `SELECT id, title FROM documents
       ORDER BY embedding_base <=> $1::vector LIMIT $2`,
      [JSON.stringify(baseQueryVector), topDocs]
    );

    const candidateIds = candidateDocsRes.rows.map((row) => row.id);
    if (candidateIds.length === 0) {
      return { answer: 'No se encontraron documentos relacionados con tu consulta.', sources: [] };
    }

    // ── CAPA 2: Búsqueda Híbrida (vectorial 1536d + BM25) ───────────────────
    const highQueryVector = await this.embedder.generateEmbedding(userQuery, 1536);

    const hybridCandidates: ScoredChunk[] = await this.hybridSearch.search(
      candidateIds,
      highQueryVector,
      userQuery,
      retrievalCandidates,
      vectorWeight,
      bm25Weight
    );

    if (hybridCandidates.length === 0) {
      return { answer: 'No se encontraron fragmentos relevantes para tu consulta.', sources: [] };
    }

    // ── CAPA 3: Re-ranking con LLM (cross-encoder) ───────────────────────────
    const reranked = enableReranking
      ? await this.reranker.rerank(userQuery, hybridCandidates, finalTopK)
      : hybridCandidates.slice(0, finalTopK);

    // ── CAPA 4: Recuperar Parent Chunks para contexto enriquecido ────────────
    const sources: RAGSource[] = await this.enrichWithParents(reranked, enableParentChunks);

    // ── CAPA 5: Generación de respuesta ──────────────────────────────────────
    const contextText = sources
      .map((p, i) => {
        const contextBody = p.parent_content ?? p.contextualized_text;
        return `[Fuente ${i + 1} - ${p.doc_title} (fragmento ${p.paragraph_index}) | id:${p.id ?? ''}]:\n${contextBody}`;
      })
      .join('\n\n');

    const answer = await this.llm.generateRAGAnswer(userQuery, contextText);

    return { answer, sources };
  }

  /**
   * Enriquece los fragmentos recuperados con el contenido de su parent chunk
   * (bloque grande de 1200-2000 chars) si está disponible.
   */
  private async enrichWithParents(chunks: ScoredChunk[], enabled: boolean): Promise<RAGSource[]> {
    if (!enabled) {
      return chunks.map(c => this.toRAGSource(c, undefined));
    }

    // Recopilar IDs de parent chunks únicos
    const parentIds = [...new Set(chunks.map(c => c.parent_chunk_id).filter(Boolean))] as string[];

    const parentMap = new Map<string, string>();
    if (parentIds.length > 0) {
      const parentRes = await query<ParentChunk>(
        `SELECT id, content FROM document_parent_chunks WHERE id = ANY($1::uuid[])`,
        [parentIds]
      );
      for (const row of parentRes.rows) {
        parentMap.set(row.id, row.content);
      }
    }

    return chunks.map(c => {
      const parentContent = c.parent_chunk_id ? parentMap.get(c.parent_chunk_id) : undefined;
      return this.toRAGSource(c, parentContent);
    });
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
}
