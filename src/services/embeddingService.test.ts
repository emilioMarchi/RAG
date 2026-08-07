import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../config/env.js', () => ({ env: { GEMINI_API_KEY: 'test-key' } }))
vi.mock('../utils/retry.js', () => ({ withRetry: (fn) => fn() }))
const { EmbeddingService } = await import('./embeddingService.js')
describe('EmbeddingService', () => {
  let embedder
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = vi.fn()
    embedder = new EmbeddingService()
  })
  it('generateEmbedding returns vector on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: { values: [0.1, 0.2] } })
    })
    const vec = await embedder.generateEmbedding('test text', 768)
    expect(vec).toEqual([0.1, 0.2])
  })
  it('throws on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'API Error' } })
    })
    await expect(embedder.generateEmbedding('test')).rejects.toThrow('API Error')
  })
  it('throws when no embedding values returned', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embedding: {} })
    })
    await expect(embedder.generateEmbedding('test')).rejects.toThrow('no embedding values')
  })
})
