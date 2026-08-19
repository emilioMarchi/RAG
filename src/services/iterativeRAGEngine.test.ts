import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./embeddingService.js', () => ({
  EmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}));

vi.mock('./llmService.js', () => ({
  LLMService: vi.fn(() => ({
    generateRAGAnswer: vi.fn().mockResolvedValue('Final answer'),
    decomposeQuery: vi.fn().mockResolvedValue(['test query']),
    evaluateContext: vi.fn().mockResolvedValue({ decision: 'answer', reason: 'context is good' }),
  })),
}));

vi.mock('../config/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../config/db.js');
const { IterativeRAGEngine } = await import('./iterativeRAGEngine.js');

/** Fila de párrafo válida que sobrevive al pipeline (incluye id/document_id/paragraph_index). */
function paragraphRow(id, documentId, index, raw = 'texto') {
  return {
    id,
    document_id: documentId,
    paragraph_index: index,
    raw_content: raw,
    contextualized_text: `ctx-${raw}`,
    parent_chunk_id: null,
    doc_title: 'Doc 1',
    r2_key: 'k1',
    r2_url: 'url1',
  };
}

describe('IterativeRAGEngine', () => {
  let engine, embedder, llm;

  beforeEach(() => {
    vi.clearAllMocks();
    embedder = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    llm = {
      generateRAGAnswer: vi.fn().mockResolvedValue('Final answer'),
      decomposeQuery: vi.fn().mockResolvedValue(['subquery 1']),
      evaluateContext: vi.fn().mockResolvedValue({ decision: 'answer', reason: 'sufficient' }),
    };
    engine = new IterativeRAGEngine(embedder, llm, {
      rerankStrategy: 'hybrid',
      cragMaxPasses: 1,
    });

    // Default: búsquedas vectoriales devuelven 1 párrafo; el resto consultas vacías.
    query.mockImplementation((text: string) => {
      if (text.includes('embedding_high')) {
        return Promise.resolve({ rows: [paragraphRow('p1', 'doc-1', 0)] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('queries successfully with decomposition and single iteration', async () => {
    llm.decomposeQuery.mockResolvedValue(['subquery 1', 'subquery 2']);
    // Habilitar expansión explícitamente para ejercitar evaluateContext.
    engine = new IterativeRAGEngine(embedder, llm, {
      rerankStrategy: 'hybrid',
      cragMaxPasses: 1,
      enableContextExpansion: true,
    });
    query.mockImplementation((text: string) => {
      if (text.includes('embedding_high')) {
        return Promise.resolve({ rows: [paragraphRow('p1', 'doc-1', 0)] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await engine.query('composite query', 5, 3);

    expect(llm.decomposeQuery).toHaveBeenCalledWith('composite query');
    // 1 embedding 1536d por sub-query (ya no un embed 768d por sub-query).
    expect(embedder.generateEmbedding).toHaveBeenCalledTimes(2);
    expect(llm.evaluateContext).toHaveBeenCalled();
    expect(res.iterations).toBe(1);
    expect(res.answer).toBe('Final answer');
    // Ambos sub-queries devuelven el mismo párrafo -> se deduplica con RRF.
    expect(res.sources.length).toBe(1);
  });

  it('performs second iteration when evaluateContext returns expand', async () => {
    llm.decomposeQuery.mockResolvedValueOnce(['query']);
    engine = new IterativeRAGEngine(embedder, llm, {
      rerankStrategy: 'hybrid',
      cragMaxPasses: 0,
      enableContextExpansion: true,
    });
    // Primera evaluación pide expandir hacia adelante un párrafo.
    llm.evaluateContext
      .mockResolvedValueOnce({
        decision: 'expand',
        reason: 'need surrounding info',
        expand_requests: [
          { docId: 'doc-1', paragraphIndex: 0, direction: 'after', count: 1 },
        ],
      })
      .mockResolvedValueOnce({ decision: 'answer', reason: 'sufficient now' });

    // adjacentParagraphs devuelve el párrafo siguiente.
    query.mockImplementation((text: string) => {
      if (text.includes('embedding_high')) {
        return Promise.resolve({ rows: [paragraphRow('p1', 'doc-1', 0)] });
      }
      if (text.includes('paragraph_index') && text.includes('LIMIT')) {
        // consulta de párrafos adyacentes
        return Promise.resolve({ rows: [paragraphRow('p2', 'doc-1', 1, 'vecino')] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await engine.query('single query', 5, 3);

    expect(res.iterations).toBe(2);
    // original p1 + expand p2
    expect(res.sources.length).toBe(2);
    expect(res.sources.some(s => s.raw_content === 'vecino')).toBe(true);
  });
});