import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('./embeddingService.js', () => ({
  EmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
  }))
}))
vi.mock('./llmService.js', () => ({
  LLMService: vi.fn(() => ({
    generateRAGAnswer: vi.fn().mockResolvedValue('Answer from RAG')
  }))
}))
vi.mock('../config/db.js', () => ({
  query: vi.fn()
}))
const { query } = await import('../config/db.js')
const { HierarchicalRAGModule } = await import('./ragEngine.js')
describe('HierarchicalRAGModule', () => {
  let rag, embedder, llm
  beforeEach(() => {
    vi.clearAllMocks()
    embedder = { generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) }
    llm = { generateRAGAnswer: vi.fn().mockResolvedValue('Answer from RAG') }
    rag = new HierarchicalRAGModule(embedder, llm)
  })
  it('query returns answer with sources when docs found', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 'doc-1', title: 'Doc 1' }]
    })
    query.mockResolvedValueOnce({
      rows: [
        { id: 'p1', document_id: 'doc-1', paragraph_index: 0, parent_chunk_id: null,
          raw_content: 'r1', contextualized_text: 'ctx1', doc_title: 'Doc 1', r2_key: 'k1', r2_url: 'url1' }
      ]
    })
    // Default: bm25 y resto de consultas (enrich parents) devuelven vacío.
    query.mockResolvedValue({ rows: [] })
    const res = await rag.query('test query', 5, 3)
    expect(res.answer).toBe('Answer from RAG')
    expect(res.sources).toHaveLength(1)
    expect(embedder.generateEmbedding).toHaveBeenCalledTimes(2)
    expect(llm.generateRAGAnswer).toHaveBeenCalled()
  })
  it('query returns no sources message when no docs', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    const res = await rag.query('test')
    expect(res.answer).toContain('No se encontraron')
    expect(res.sources).toHaveLength(0)
  })
})
