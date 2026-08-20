import { Router, Request, Response } from 'express';
import { AgentService } from '../agent/agentService.js';

// Watchdog total del stream SSE: si el motor no termina en este tiempo (modelos
// :free en cola, DB lenta, etc.), se fuerza el cierre con un error para que el
// estado del chat nunca quede pegado en "Generando respuesta…".
const AGENT_STREAM_TOTAL_MS = Number(process.env.AGENT_STREAM_TOTAL_MS ?? 7 * 60_000);

function validBody(req: Request): { query: string; sessionId: string } | null {
  const { query: userQuery, sessionId } = req.body;
  if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) return null;
  if (!sessionId || typeof sessionId !== 'string') return null;
  return { query: userQuery.trim(), sessionId };
}

function withTotalTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (límite ${Math.round(ms / 1000)}s)`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export function createAgentRouter(agentService: AgentService): Router {
  const router = Router();

  /**
   * POST /api/agent/chat
   * Envía un mensaje al agente conversacional.
   */
  router.post('/agent/chat', async (req: Request, res: Response) => {
    try {
      const body = validBody(req);
      if (!body) {
        res.status(400).json({ error: 'Se requiere una consulta y sessionId válidos' });
        return;
      }

      const result = await agentService.chat(body.sessionId, body.query);
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
   * POST /api/agent/chat/stream
   * Igual que /agent/chat pero por SSE: emite las fases internas
   * (route/decompose/search/rerank/answer) y luego los tokens de la
   * respuesta final a medida que se generan (efecto typewriter).
   */
  router.post('/agent/chat/stream', async (req: Request, res: Response) => {
    const body = validBody(req);
    if (!body) {
      res.status(400).json({ error: 'Se requiere una consulta y sessionId válidos' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await withTotalTimeout(
        agentService.chat(body.sessionId, body.query, {
          phase: (phase: string) => send({ type: 'phase', phase }),
          token: (text: string) => send({ type: 'token', text }),
        }),
        AGENT_STREAM_TOTAL_MS,
        'La generación de la respuesta superó el tiempo máximo'
      );
      send({
        type: 'done',
        content: result.answer,
        sources: result.sources ?? [],
        iterations: result.iterations ?? 0,
        intent: result.intent,
        cragDecision: result.cragDecision ?? null,
      });
    } catch (error) {
      console.error('[Agent Stream Route Error]:', error);
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'Error desconocido',
      });
    } finally {
      res.end();
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
