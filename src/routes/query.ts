import { Router, Request, Response } from 'express';
import { HierarchicalRAGModule } from '../services/ragEngine.js';
import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import { EmbeddingService } from '../services/embeddingService.js';
import { query } from '../config/db.js';

export function createQueryRouter(
  rag: HierarchicalRAGModule,
  iterativeRag?: IterativeRAGEngine
): Router {
  const router = Router();
  const embedder = new EmbeddingService();

  router.post('/query', async (req: Request, res: Response) => {
    try {
      const { query: userQuery, topDocs, topParagraphs } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida' });
        return;
      }

      const result = await rag.query(
        userQuery.trim(),
        topDocs || 5,
        topParagraphs || 3
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
        const { query: userQuery, topDocs, topParagraphs } = req.body;

        if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
          res.status(400).json({ error: 'Se requiere una consulta válida' });
          return;
        }

        const result = await iterativeRag.query(
          userQuery.trim(),
          topDocs || 5,
          topParagraphs || 3
        );

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
