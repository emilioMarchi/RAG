import { Router, Request, Response } from 'express';
import { HierarchicalRAGModule } from '../services/ragEngine.js';
import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import { EmbeddingService } from '../services/embeddingService.js';
import { LocalEmbeddingService } from '../services/localEmbeddingService.js';
import { LLMService } from '../services/llmService.js';
import { QueryEvaluator } from '../services/queryEvaluator.js';
import { query } from '../config/db.js';
import { env } from '../config/env.js';

export function createQueryRouter(
  rag: HierarchicalRAGModule,
  iterativeRag?: IterativeRAGEngine,
  llm?: LLMService
): Router {
  const router = Router();
  const embedder =
    env.EMBEDDING_PROVIDER === 'local'
      ? new LocalEmbeddingService(env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS)
      : new EmbeddingService();
  const embedDims = env.EMBEDDING_PROVIDER === 'local' ? env.EMBEDDING_DIMENSIONS : 1536;
  const evaluator = llm ? new QueryEvaluator(llm) : null;

  router.post('/query', async (req: Request, res: Response) => {
    try {
      const { query: userQuery, topDocs, topParagraphs, similarityThreshold } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida' });
        return;
      }

      const threshold = typeof similarityThreshold === 'number' ? similarityThreshold : 0;

      // Si el engine iterativo está disponible, es el default (incluye hybrid search + reranking)
      const engine = iterativeRag ?? rag;
      const result = await engine.query(
        userQuery.trim(),
        topDocs || 5,
        topParagraphs || 20,
        threshold
      );

      res.json(result);
    } catch (error) {
      console.error('Query error:', error);
      res.status(500).json({
        error: 'Error al procesar la consulta',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/query/simple
   * Motor RAG jerárquico básico sin descomposición de queries ni expansión iterativa.
   */
  router.post('/query/simple', async (req: Request, res: Response) => {
    try {
      const { query: userQuery, topDocs, topParagraphs, similarityThreshold } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida' });
        return;
      }

      const threshold = typeof similarityThreshold === 'number' ? similarityThreshold : 0;

      const result = await rag.query(
        userQuery.trim(),
        topDocs || 5,
        topParagraphs || 20,
        threshold
      );

      res.json(result);
    } catch (error) {
      console.error('Simple query error:', error);
      res.status(500).json({
        error: 'Error al procesar la consulta',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/query/scores
   * Devuelve puntuaciones de similitud de TODOS los párrafos vs. la consulta.
   * Usado por el grafo de nodos para resaltar fragmentos relevantes.
   */
  router.post('/query/scores', async (req: Request, res: Response) => {
    try {
      const { query: userQuery } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida' });
        return;
      }

      // Embed con la dimensión del provider (1536d Gemini | 384d local)
      const highVector = await embedder.generateEmbedding(userQuery.trim(), embedDims);

      // Calculamos la similitud coseno (1 - distancia coseno) para los párrafos más
      // similares. pgvector: <=> devuelve distancia coseno (0 = idénticos, 2 = opuestos);
      // score = 1 - distancia/2 → rango 0-1. Ordenamos por el operador de distancia
      // directo y con LIMIT para que el planificador use el índice HNSW.
      const LIMIT_SCORES = 1000;
      const result = await query<{ id: string; score: number }>(
        `SELECT id,
                GREATEST(0, 1 - (embedding_high <=> $1::vector) / 2) AS score
         FROM document_paragraphs
         ORDER BY embedding_high <=> $1::vector
         LIMIT $2`,
        [JSON.stringify(highVector), LIMIT_SCORES]
      );

      res.json({ scores: result.rows.map(r => ({ paragraph_id: r.id, score: Number(r.score) })) });
    } catch (error) {
      console.error('Scores error:', error);
      res.status(500).json({
        error: 'Error al calcular puntuaciones',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  if (iterativeRag) {
    router.post('/query/iterative', async (req: Request, res: Response) => {
      try {
        const { query: userQuery, topDocs, topParagraphs, similarityThreshold } = req.body;

        if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
          res.status(400).json({ error: 'Se requiere una consulta válida' });
          return;
        }

        const threshold = typeof similarityThreshold === 'number' ? similarityThreshold : 0;
        const t0 = Date.now();

        const result = await iterativeRag.query(
          userQuery.trim(),
          topDocs || 5,
          topParagraphs || 10,
          threshold
        );

        const latencyMs = Date.now() - t0;

        // Registrar y evaluar en background (fire-and-forget)
        if (evaluator) {
          const contextText = result.sources
            .map((s, i) => `[${i+1}] ${s.doc_title}: ${s.raw_content.substring(0, 300)}`)
            .join('\n');

          evaluator.recordAndEvaluate({
            queryText: userQuery.trim(),
            answerText: result.answer,
            contextText,
            sourcesCount: result.sources.length,
            cragDecision: result.cragDecision,
            iterations: result.iterations,
            latencyMs,
          }).catch(err => console.error('[QueryEvaluator] recordAndEvaluate error:', err));
        }

        res.json(result);
      } catch (error) {
        console.error('Iterative query error:', error);
        res.status(500).json({
          error: 'Error al procesar la consulta iterativa',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  /**
   * GET /api/evaluations/stats
   * Estadísticas agregadas de calidad del sistema (Fase 4 - Ragas backend).
   */
  router.get('/evaluations/stats', async (_req: Request, res: Response) => {
    try {
      const result = await query<{
        total: number;
        evaluated: number;
        pending: number;
        avg_faithfulness: number | null;
        avg_relevance: number | null;
        avg_latency_ms: number | null;
        avg_iterations: number | null;
      }>(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE evaluated)::int AS evaluated,
           COUNT(*) FILTER (WHERE NOT evaluated)::int AS pending,
           ROUND(AVG(faithfulness_score) FILTER (WHERE evaluated)::numeric, 3) AS avg_faithfulness,
           ROUND(AVG(answer_relevance_score) FILTER (WHERE evaluated)::numeric, 3) AS avg_relevance,
           ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
           ROUND(AVG(iterations)::numeric, 2) AS avg_iterations
         FROM query_evaluations`
      );
      const row = result.rows[0];
      res.json({
        total: row?.total ?? 0,
        evaluated: row?.evaluated ?? 0,
        pending: row?.pending ?? 0,
        avg_faithfulness: row?.avg_faithfulness !== null ? Number(row.avg_faithfulness) : null,
        avg_relevance: row?.avg_relevance !== null ? Number(row.avg_relevance) : null,
        avg_latency_ms: row?.avg_latency_ms !== null ? Number(row.avg_latency_ms) : null,
        avg_iterations: row?.avg_iterations !== null ? Number(row.avg_iterations) : null,
      });
    } catch (error) {
      console.error('Eval stats error:', error);
      res.status(500).json({ error: 'Error al obtener estadísticas de evaluación' });
    }
  });

  /**
   * GET /api/evaluations
   * Lista las evaluaciones más recientes para visualización.
   */
  router.get('/evaluations', async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const result = await query<{
        id: string;
        query_text: string;
        sources_count: number;
        crag_decision: string | null;
        iterations: number;
        latency_ms: number | null;
        faithfulness_score: number | null;
        answer_relevance_score: number | null;
        evaluated: boolean;
        created_at: string;
      }>(
        `SELECT id, query_text, sources_count, crag_decision, iterations, latency_ms,
                faithfulness_score, answer_relevance_score, evaluated, created_at
         FROM query_evaluations
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json(result.rows);
    } catch (error) {
      console.error('List evaluations error:', error);
      res.status(500).json({ error: 'Error al listar evaluaciones' });
    }
  });

  /**
   * POST /api/query/relations
   * Devuelve las relaciones semánticas cruzadas (similitud >= threshold)
   * entre un conjunto de IDs de fragmentos seleccionados.
   *
   * `maxRelations` (default 400) acota la cantidad devuelta: el grafo con
   * physics de vis-network no escala bien con miles de aristas, y limita el
   * número a pintar para que el slider pueda graduar la densidad sin congelar
   * la interfaz.
   *
   * `centerId` (opcional) activa el "modo fragmento" (ego-graph): devuelve
   * SOLO las relaciones del fragmento indicado con el resto del conjunto,
   * ordenadas por similitud. Pensado para visualizar un fragmento unitario
   * y sus relaciones uno-a-uno.
   *
   * `crossDoc` (opcional) filtra SOLO relaciones entre documentos distintos
   * (capa inter-documental).
   */
  router.post('/query/relations', async (req: Request, res: Response) => {
    try {
      const { paragraphIds, threshold, maxRelations, centerId, crossDoc } = req.body;

      if (!Array.isArray(paragraphIds) || paragraphIds.length === 0) {
        res.status(400).json({ error: 'Se requiere una lista de paragraphIds válida' });
        return;
      }

      const simThreshold = typeof threshold === 'number' ? threshold : 0.75;
      const limit = Math.min(
        Math.max(typeof maxRelations === 'number' ? Math.floor(maxRelations) : 400, 1),
        2000
      );

      const isEgo = typeof centerId === 'string' && centerId.length > 0;
      // Ego: solo relaciones del centro con cada vecino (todos los ids, sin
      // restricción de orden). Normal: pares únicos con p1.id < p2.id.
      const pairFilter = isEgo
        ? 'p1.id = $4 AND p2.id <> $4'
        : 'p1.id < p2.id';
      const crossDocFilter = crossDoc === true ? 'AND p1.document_id <> p2.document_id' : '';

      const result = await query<{ source_id: string; target_id: string; similarity: number }>(
        `WITH subset AS MATERIALIZED (
            SELECT id, document_id, embedding_high
            FROM document_paragraphs
            WHERE id = ANY($1::uuid[])
         )
         SELECT
            p1.id as source_id,
            p2.id as target_id,
            (1 - (p1.embedding_high <=> p2.embedding_high)) as similarity
         FROM subset p1
         CROSS JOIN subset p2
         WHERE ${pairFilter}
           AND (1 - (p1.embedding_high <=> p2.embedding_high)) >= $2
           ${crossDocFilter}
         ORDER BY similarity DESC
         LIMIT $3`,
        isEgo ? [paragraphIds, simThreshold, limit, centerId] : [paragraphIds, simThreshold, limit]
      );

      res.json({ relations: result.rows, ego: isEgo ? centerId : null });
    } catch (error) {
      console.error('Relations error:', error);
      res.status(500).json({
        error: 'Error al calcular relaciones semánticas',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/query/debug
   * Devuelve los chunks que el hybrid search recupera (sin reranking ni expansión),
   * para comparar con lo almacenado en /documents/:id/chunks.
   */
  router.post('/query/debug', async (req: Request, res: Response) => {
    try {
      const { query: userQuery, limit, vectorWeight, bm25Weight } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida' });
        return;
      }

      const { HybridSearchService } = await import('../services/hybridSearchService.js');
      const hybridSearch = new HybridSearchService();

      const highVector = await embedder.generateEmbedding(userQuery.trim(), embedDims);
      const hits = await hybridSearch.search(
        [],
        highVector,
        userQuery.trim(),
        limit || 20,
        vectorWeight ?? 0.6,
        bm25Weight ?? 0.4
      );

      // Enriquecer con texto original y contexto para ver qué se está buscando
      const ids = hits.map(h => h.id);
      const full = await query<{
        id: string;
        document_id: string;
        paragraph_index: number;
        raw_content: string;
        contextualized_text: string;
        parent_chunk_id: string | null;
        doc_title: string;
        metadata: { contextPath?: string; location?: Record<string, unknown> };
      }>(
        `SELECT p.id, p.document_id, p.paragraph_index, p.raw_content,
                p.contextualized_text, p.parent_chunk_id,
                d.title as doc_title, p.metadata
         FROM document_paragraphs p
         JOIN documents d ON p.document_id = d.id
         WHERE p.id = ANY($1::uuid[])`,
        [ids]
      );

      const fullMap = new Map(full.rows.map(r => [r.id, r]));
      const enriched = hits.map(h => {
        const f = fullMap.get(h.id);
        return {
          id: h.id,
          score: h.hybrid_score,
          docTitle: f?.doc_title,
          paragraphIndex: f?.paragraph_index,
          parentChunkId: f?.parent_chunk_id,
          contextPath: f?.metadata?.contextPath ?? null,
          location: f?.metadata?.location ?? null,
          rawPreview: f?.raw_content?.substring(0, 300),
          ctxPreview: f?.contextualized_text?.substring(0, 300),
        };
      });

      res.json({ query: userQuery.trim(), results: enriched });
    } catch (error) {
      console.error('Debug query error:', error);
      res.status(500).json({
        error: 'Error en debug query',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
