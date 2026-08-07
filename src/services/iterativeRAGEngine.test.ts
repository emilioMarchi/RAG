import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./embeddingService.js', () => ({
  EmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  })),
}));

vi.mock('./llmService.js', () => ({
  LLMService: vi.fn(() => ({
    generateRAGAnswer: vi.fn().mockResolvedValue('Answer from RAG'),
    decomposeQuery: vi.fn().mockResolvedValue(['test query']),
    evaluateContext: vi.fn().mockResolvedValue({ decision: 'answer', reason: 'context is good' }),
  })),
}));

vi.mock('../config/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../config/db.js');
const { IterativeRAGEngine } = await import('./iterativeRAGEngine.js');

describe('IterativeRAGEngine', () => {
  let engine, embedder, llm;

  beforeEach(() => {
    vi.clearAllMocks();
    embedder = {
      generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    llm = {
      generateRAGAnswer: vi.fn().mockResolvedValue('Final answer'),
      decomposeQuery: vi.fn().mockResolvedValue(['subquery 1', 'subquery 2']),
      evaluateContext: vi.fn().mockResolvedValue({ decision: 'answer', reason: 'sufficient' }),
    };
    engine = new IterativeRAGEngine(embedder, llm);
  });

  it('queries successfully with decomposition and single iteration', async () => {
    // Para candidateDocsRes de la primera subquery
    query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', title: 'Doc 1' }],
    });
    // Para candidateDocsRes de la segunda subquery
    query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', title: 'Doc 1' }],
    });
    
    // Para searchParagraphs de la primera subquery
    query.mockResolvedValueOnce({
      rows: [
        { raw_content: 'p1', contextualized_text: 'ctx1', doc_title: 'Doc 1', r2_key: 'k1', r2_url: 'url1', document_id: 'doc-1', paragraph_index: 0 },
      ],
    });
    // Para searchParagraphs de la segunda subquery
    query.mockResolvedValueOnce({
      rows: [
        { raw_content: 'p2', contextualized_text: 'ctx2', doc_title: 'Doc 1', r2_key: 'k1', r2_url: 'url1', document_id: 'doc-1', paragraph_index: 1 },
      ],
    });

    const res = await engine.query('composite query', 5, 3);
    
    expect(llm.decomposeQuery).toHaveBeenCalledWith('composite query');
    expect(embedder.generateEmbedding).toHaveBeenCalledTimes(4); // 2 de base + 2 de high
    expect(llm.evaluateContext).toHaveBeenCalled();
    expect(res.iterations).toBe(1);
    expect(res.answer).toBe('Final answer');
    expect(res.sources).toHaveLength(2);
  });

  it('performs second iteration when evaluateContext returns expand', async () => {
    // subqueries
    llm.decomposeQuery.mockResolvedValueOnce(['query']);
    
    // docs
    query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', title: 'Doc 1' }],
    });
    // paragraphs
    query.mockResolvedValueOnce({
      rows: [
        { raw_content: 'p1', contextualized_text: 'ctx1', doc_title: 'Doc 1', r2_key: 'k1', r2_url: 'url1', document_id: 'doc-1', paragraph_index: 1 },
      ],
    });

    // Cambiar la evaluación para forzar expand
    llm.evaluateContext.mockResolvedValueOnce({
      decision: 'expand',
      reason: 'need surrounding info',
      expand_requests: [
        { docId: 'doc-1', paragraphIndex: 1, direction: 'after', count: 1 },
      ],
    });

    // mock adjacentParagraphs response
    query.mockResolvedValueOnce({
      rows: [
        { raw_content: 'p2', contextualized_text: 'ctx2', doc_title: 'Doc 1', r2_key: 'k1', r2_url: 'url1', document_id: 'doc-1', paragraph_index: 2 },
      ],
    });

    const res = await engine.query('single query', 5, 3);

    expect(res.iterations).toBe(2);
    expect(res.sources).toHaveLength(2); // original p1 + expand p2
    expect(res.sources[1].raw_content).toBe('p2');
  });
});
