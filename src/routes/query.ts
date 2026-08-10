import { Router, Request, Response } from 'express';
import { HierarchicalRAGModule } from '../services/ragEngine.js';
import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import { EmbeddingService } from '../services/embeddingService.js';
import { LLMService } from '../services/llmService.js';
import { QueryEvaluator } from '../services/queryEvaluator.js';
import { query } from '../config/db.js';

export function createQueryRouter(
  rag: HierarchicalRAGModule,
  iterativeRag?: IterativeRAGEngine,
  llm?: LLMService
): Router {
  const router = Router();
  const embedder = new EmbeddingService();
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

      // Embed con dimensión high (1536d) para comparar con los fragmentos
      const highVector = await embedder.generateEmbedding(userQuery.trim(), 1536);

      // Calculamos la similitud coseno (1 - distancia coseno) para todos los párrafos
      // pgvector: <=> devuelve distancia coseno (0 = idénticos, 2 = opuestos)
      // score = 1 - distancia/2  → rango 0-1
      const result = await query<{ id: string; score: number }>(
        `SELECT id,
                GREATEST(0, 1 - (embedding_high <=> $1::vector) / 2) AS score
         FROM document_paragraphs
         ORDER BY score DESC`,
        [JSON.stringify(highVector)]
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
   */
  router.post('/query/relations', async (req: Request, res: Response) => {
    try {
      const { paragraphIds, threshold } = req.body;

      if (!Array.isArray(paragraphIds) || paragraphIds.length === 0) {
        res.status(400).json({ error: 'Se requiere una lista de paragraphIds válida' });
        return;
      }

      const simThreshold = typeof threshold === 'number' ? threshold : 0.75;

      const result = await query<{ source_id: string; target_id: string; similarity: number }>(
        `SELECT 
            p1.id as source_id,
            p2.id as target_id,
            (1 - (p1.embedding_high <=> p2.embedding_high)) as similarity
         FROM document_paragraphs p1
         CROSS JOIN document_paragraphs p2
         WHERE p1.id = ANY($1::uuid[]) 
           AND p2.id = ANY($1::uuid[])
           AND p1.id < p2.id -- Evita duplicados y autorelaciones
           AND (1 - (p1.embedding_high <=> p2.embedding_high)) >= $2
         ORDER BY similarity DESC`,
        [paragraphIds, simThreshold]
      );

      res.json({ relations: result.rows });
    } catch (error) {
      console.error('Relations error:', error);
      res.status(500).json({
        error: 'Error al calcular relaciones semánticas',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
