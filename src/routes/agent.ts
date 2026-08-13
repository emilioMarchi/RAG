import { Router, Request, Response } from 'express';
import { AgentService } from '../agent/agentService.js';

export function createAgentRouter(agentService: AgentService): Router {
  const router = Router();

  /**
   * POST /api/agent/chat
   * Envía un mensaje al agente conversacional.
   */
  router.post('/agent/chat', async (req: Request, res: Response) => {
    try {
      const { query: userQuery, sessionId } = req.body;

      if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
        res.status(400).json({ error: 'Se requiere una consulta válida (query)' });
        return;
      }

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'Se requiere un sessionId válido' });
        return;
      }

      const result = await agentService.chat(sessionId, userQuery.trim());
      res.json(result);
    } catch (error) {
      console.error('[Agent Route Error]:', error);
      res.status(500).json({
        error: 'Error al procesar el chat con el agente',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/agent/reset
   * Resetea el historial de conversación para un sessionId específico.
   */
  router.post('/agent/reset', async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'Se requiere un sessionId válido' });
        return;
      }

      await agentService.reset(sessionId);
      res.json({ success: true, message: 'Sesión reseteada correctamente' });
    } catch (error) {
      console.error('[Agent Reset Route Error]:', error);
      res.status(500).json({
        error: 'Error al resetear la sesión del agente',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/agent/history
   * Obtiene el historial de conversación de la sesión.
   */
  router.get('/agent/history', async (req: Request, res: Response) => {
    try {
      const sessionId = req.query.sessionId;

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'Se requiere un sessionId válido en la query' });
        return;
      }

      const history = await agentService.getHistory(sessionId);
      res.json(history);
    } catch (error) {
      console.error('[Agent History Route Error]:', error);
      res.status(500).json({
        error: 'Error al recuperar el historial de la sesión',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
