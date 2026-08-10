import { query } from '../config/db.js';

/**
 * Un fragmento recuperado junto con su score de relevancia.
 */
export interface ScoredChunk {
  id: string;
  document_id: string;
  paragraph_index: number;
  raw_content: string;
  contextualized_text: string;
  doc_title: string;
  r2_key: string;
  r2_url: string | null;
  parent_chunk_id: string | null;
  /** Score combinado final (0–1) luego de RRF */
  hybrid_score: number;
}

interface VectorHit {
  id: string;
  document_id: string;
  paragraph_index: number;
  raw_content: string;
  contextualized_text: string;
  doc_title: string;
  r2_key: string;
  r2_url: string | null;
  parent_chunk_id: string | null;
  vector_distance: number;
}

interface BM25Hit {
  id: string;
  bm25_rank: number;
}

/**
 * Reciprocal Rank Fusion: combina dos rankings por posición.
 * score_rrf(doc) = Σ 1 / (k + rank_i)   donde k=60 (constante estándar)
 *
 * Pesos adicionales:
 *   - vectorWeight (default 0.6) pondera el aporte del ranking vectorial
 *   - bm25Weight   (default 0.4) pondera el aporte del ranking BM25
 */
function reciprocalRankFusion(
  vectorHits: VectorHit[],
  bm25Hits: BM25Hit[],
  vectorWeight = 0.6,
  bm25Weight = 0.4,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();

  vectorHits.forEach((hit, rank) => {
    const prev = scores.get(hit.id) ?? 0;
    scores.set(hit.id, prev + vectorWeight * (1 / (k + rank + 1)));
  });

  bm25Hits.forEach((hit, rank) => {
    const prev = scores.get(hit.id) ?? 0;
    scores.set(hit.id, prev + bm25Weight * (1 / (k + rank + 1)));
  });

  return scores;
}

/**
 * HybridSearchService
 *
 * Combina búsqueda densa (vectorial pgvector) con búsqueda léxica (BM25 / ts_vector Postgres)
 * usando Reciprocal Rank Fusion para producir un ranking unificado de alta calidad.
 */
export class HybridSearchService {
  /**
   * Busca párrafos relevantes combinando vectores + BM25.
   *
   * @param docIds       IDs de documentos candidatos (pre-filtrados por embedding_base 768d)
   * @param queryVector  Vector 1536d de la consulta
   * @param queryText    Texto original de la consulta (para BM25)
   * @param limit        Número de resultados finales a devolver
   * @param vectorWeight Peso del ranking vectorial (default 0.6)
   * @param bm25Weight   Peso del ranking BM25 (default 0.4)
   * @param candidateMultiplier Multiplicador para ampliar candidatos iniciales antes de re-rankear
   */
  async search(
    docIds: string[],
    queryVector: number[],
    queryText: string,
    limit: number,
    vectorWeight = 0.6,
    bm25Weight = 0.4,
    candidateMultiplier = 3
  ): Promise<ScoredChunk[]> {
    const candidateLimit = limit * candidateMultiplier;

    // ── 1. Búsqueda vectorial (Dense Retrieval) ───────────────────────────────
    const vectorRes = await query<VectorHit>(
      `SELECT
         p.id,
         p.document_id,
         p.paragraph_index,
         p.raw_content,
         p.contextualized_text,
         p.parent_chunk_id,
         d.title AS doc_title,
         d.r2_key,
         d.r2_url,
         (p.embedding_high <=> $2::vector) AS vector_distance
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = ANY($1::uuid[])
       ORDER BY p.embedding_high <=> $2::vector
       LIMIT $3`,
      [docIds, JSON.stringify(queryVector), candidateLimit]
    );

    const vectorHits = vectorRes.rows;

    // ── 2. Búsqueda léxica BM25 (Sparse Retrieval via ts_rank) ───────────────
    // ts_rank_cd usa tf*idf con normalización por densidad del documento
    const sanitizedQuery = this.sanitizeForTsQuery(queryText);
    let bm25Hits: BM25Hit[] = [];

    if (sanitizedQuery) {
      const bm25Res = await query<BM25Hit>(
        `SELECT
           p.id,
           ts_rank_cd(p.tsv_content, to_tsquery('spanish', $2)) AS bm25_rank
         FROM document_paragraphs p
         WHERE p.document_id = ANY($1::uuid[])
           AND p.tsv_content @@ to_tsquery('spanish', $2)
         ORDER BY bm25_rank DESC
         LIMIT $3`,
        [docIds, sanitizedQuery, candidateLimit]
      );
      bm25Hits = bm25Res.rows;
    }

    // ── 3. Reciprocal Rank Fusion ─────────────────────────────────────────────
    const rrfScores = reciprocalRankFusion(vectorHits, bm25Hits, vectorWeight, bm25Weight);

    // ── 4. Construir mapa de metadatos de todos los hits únicos ──────────────
    const hitMap = new Map<string, VectorHit>();
    for (const h of vectorHits) hitMap.set(h.id, h);

    // Para hits BM25 que no estén en los vectoriales, los recuperamos de DB
    const missingIds = bm25Hits.map(h => h.id).filter(id => !hitMap.has(id));
    if (missingIds.length > 0) {
      const extraRes = await query<VectorHit>(
        `SELECT
           p.id, p.document_id, p.paragraph_index, p.raw_content,
           p.contextualized_text, p.parent_chunk_id,
           d.title AS doc_title, d.r2_key, d.r2_url,
           0 AS vector_distance
         FROM document_paragraphs p
         JOIN documents d ON p.document_id = d.id
         WHERE p.id = ANY($1::uuid[])`,
        [missingIds]
      );
      for (const row of extraRes.rows) hitMap.set(row.id, row);
    }

    // ── 5. Ordenar por score RRF y tomar los top `limit` ─────────────────────
    const ranked = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return ranked
      .map(([id, score]) => {
        const hit = hitMap.get(id);
        if (!hit) return null;
        return {
          ...hit,
          hybrid_score: score,
        } as ScoredChunk;
      })
      .filter((c): c is ScoredChunk => c !== null);
  }

  /**
   * Convierte texto libre en un tsquery válido para Postgres.
   * - Tokeniza por palabras, elimina stopwords muy cortas y caracteres especiales
   * - Une con el operador OR (|) para recuperar documentos que contengan cualquier término
   */
  private sanitizeForTsQuery(text: string): string {
    const tokens = text
      .toLowerCase()
      .replace(/[^\w\sáéíóúüñ]/gi, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .map(t => t.replace(/'/g, ''));

    if (tokens.length === 0) return '';
    return tokens.join(' | ');
  }
}
