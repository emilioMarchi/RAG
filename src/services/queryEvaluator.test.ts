import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../config/db.js');
const { QueryEvaluator } = await import('./queryEvaluator.js');

function mockLLM(content: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      choices: [{ message: { content } }],
    }),
  };
}

describe('QueryEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persiste el registro base y lanza evaluación en background', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'eval-1' }] });

    const evaluator = new QueryEvaluator(mockLLM('{}') as any);

    const id = await evaluator.recordAndEvaluate({
      queryText: '¿qué es?',
      answerText: 'respuesta',
      contextText: 'contexto',
      sourcesCount: 3,
      cragDecision: 'RELEVANT',
      iterations: 2,
      latencyMs: 150,
    });

    expect(id).toBe('eval-1');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO query_evaluations'),
      ['¿qué es?', 'respuesta', 3, 'RELEVANT', 2, 150]
    );
  });

  it('calcula y guarda los scores de fidelidad y relevancia en background', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const evaluator = new QueryEvaluator(
      mockLLM('{"faithfulness": 0.9, "answer_relevance": 0.8, "notes": "ok"}') as any
    );

    await evaluator.recordAndEvaluate({
      queryText: '¿qué es?',
      answerText: 'respuesta',
      contextText: 'contexto',
      sourcesCount: 1,
    });

    // Esperar a que termine la tarea en background
    await new Promise(r => setTimeout(r, 50));

    const updateCall = query.mock.calls.find(c => String(c[0]).includes('UPDATE query_evaluations'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([0.9, 0.8, 'eval-1']);
  });
});