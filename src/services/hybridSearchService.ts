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
 * Bonus de ranking fijo para coincidencias léxicas exactas de referencias normativas.
 * Supera ampliamente el score máximo teórico de RRF (~0.02) para que una consulta de
 * navegación como "ARTICULO 29" posicione el chunk correcto en primer lugar.
 */
const ARTICLE_REF_BONUS = 0.5;

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
    // docIds vacío = buscar en TODOS los párrafos (sin filtro por documento).
    const filtered = docIds && docIds.length > 0;
    const vectorParams: any[] = [JSON.stringify(queryVector), candidateLimit];
    if (filtered) vectorParams.unshift(docIds);

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
         (p.embedding_high <=> $1::vector) AS vector_distance
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       ${filtered ? 'WHERE p.document_id = ANY($1::uuid[])' : ''}
       ORDER BY p.embedding_high <=> ${filtered ? '$2' : '$1'}::vector
       LIMIT ${filtered ? '$3' : '$2'}`,
      vectorParams
    );

    const vectorHits = vectorRes.rows;

    // ── 2. Búsqueda léxica BM25 (Sparse Retrieval via ts_rank) ───────────────
    // ts_rank_cd usa tf*idf con normalización por densidad del documento
    const sanitizedQuery = this.sanitizeForTsQuery(queryText);
    let bm25Hits: BM25Hit[] = [];

    if (sanitizedQuery) {
      const bm25Params: any[] = [sanitizedQuery, candidateLimit];
      if (filtered) bm25Params.unshift(docIds);
      const bm25Res = await query<BM25Hit>(
        `SELECT
           p.id,
           ts_rank_cd(p.tsv_content, to_tsquery('spanish', $${filtered ? 2 : 1})) AS bm25_rank
         FROM document_paragraphs p
         WHERE ${filtered ? 'p.document_id = ANY($1::uuid[]) AND ' : ''}p.tsv_content @@ to_tsquery('spanish', $${filtered ? 2 : 1})
         ORDER BY bm25_rank DESC
         LIMIT $${filtered ? 3 : 2}`,
        bm25Params
      );
      bm25Hits = bm25Res.rows;
    }

    // ── 3. Coincidencia exacta de referencia normativa ("ARTICULO 29") ──────
    // Una consulta de navegación como "ARTICULO 29" falla en semántica (señal débil)
    // y BM25 pierde el número (token corto). Buscamos el marcador "ART... 29" de forma
    // literal y lo rankeamos con un bonus fijo dominante.
    const hitMap = new Map<string, VectorHit>();
    for (const h of vectorHits) hitMap.set(h.id, h);

    const exactIds: string[] = [];
    const articleRef = this.extractArticleRef(queryText);

    if (articleRef) {
      const exactPattern = `art(?:ículo|iculo)?\\.?\\s*${articleRef}([^0-9]|$)`;
      const exactParams: any[] = [exactPattern];
      if (filtered) exactParams.unshift(docIds);
      const exactRes = await query<VectorHit>(
        `SELECT
           p.id, p.document_id, p.paragraph_index, p.raw_content,
           p.contextualized_text, p.parent_chunk_id,
           d.title AS doc_title, d.r2_key, d.r2_url,
           0 AS vector_distance
         FROM document_paragraphs p
         JOIN documents d ON p.document_id = d.id
         WHERE ${filtered ? 'p.document_id = ANY($1::uuid[]) AND ' : ''}p.raw_content ~* $${filtered ? 2 : 1}
         LIMIT 50`,
        exactParams
      );
      for (const row of exactRes.rows) {
        exactIds.push(row.id);
        hitMap.set(row.id, row);
      }
    }

    // ── 4. Reciprocal Rank Fusion ─────────────────────────────────────────────
    const rrfScores = reciprocalRankFusion(vectorHits, bm25Hits, vectorWeight, bm25Weight);

    // ── 5. Recuperar metadatos de hits BM25 que no estén en el vectorial ──────
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

    // ── 6. Ranking final: RRF + bonus de referencia exacta, top `limit` ──────
    const exactSet = new Set(exactIds);
    const ranked = [...rrfScores.entries()]
      .map(([id, score]) => [id, score + (exactSet.has(id) ? ARTICLE_REF_BONUS : 0)] as const)
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
   * - Tokeniza por palabras, elimina stopwords muy cortas (excepto tokens numéricos
   *   como "29", imprescindibles para referencias a artículos) y caracteres especiales
   * - Une con el operador OR (|) para recuperar documentos que contengan cualquier término
   */
  private sanitizeForTsQuery(text: string): string {
    const tokens = text
      .toLowerCase()
      .replace(/[^\w\sáéíóúüñ]/gi, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 || /^\d+$/.test(t))

    if (tokens.length === 0) return '';
    return tokens.join(' | ');
  }

  /**
   * Extrae el número de un artículo citado en una referencia normativa
   * ("ARTICULO 29", "Artículo 29", "art. 104"). Devuelve null si no hay
   * referencia explícita a un artículo numerado.
   */
  private extractArticleRef(text: string): string | null {
    const m = text.match(/art(?:ículo|iculo)?\.?\s*(\d+)/i);
    return m ? m[1] : null;
  }
}
