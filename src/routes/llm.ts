import { Router } from 'express';
import type { LLMService } from '../services/llmService.js';

export function createLLMRouter(llm: LLMService) {
  const router = Router();

  router.get('/llm/models', (_req, res) => {
    res.json({ active: llm.getActiveModels(), catalog: llm.getModelCatalog() });
  });

  router.post('/llm/models', (req, res) => {
    const model: unknown = req.body?.model;
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({ error: 'Falta el campo "model".' });
    }
    try {
      llm.setPreferredModel(model.trim());
      res.json({ active: llm.getActiveModels() });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'Modelo inválido.' });
    }
  });

  return router;
}