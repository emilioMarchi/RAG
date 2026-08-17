import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../config/env.js', () => ({
  env: { GEMINI_API_KEY: 'key', LLM_API_URL: 'u', LLM_API_KEY: 'k', LLM_MODEL: 'm', R2_BUCKET_NAME: 'b', CLOUDFLARE_ACCOUNT_ID: 'i', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk', R2_PUBLIC_DOMAIN: null, INGESTION_CONCURRENCY: 2, INGESTION_ENABLE_GRAPH_RAG: false, INGESTION_DETERMINISTIC_ENRICH: true }
}))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn()
}))
vi.mock('../config/db.js', () => ({
  getClient: vi.fn(() => Promise.resolve({
    query: vi.fn().mockResolvedValue({ rows: [{ id: 'doc-1' }] }),
    release: vi.fn()
  }))
}))
vi.mock('./embeddingService.js', () => ({
  EmbeddingService: vi.fn(() => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
  }))
}))
vi.mock('./llmService.js', () => ({
  LLMService: vi.fn(() => ({
    enrichChunk: vi.fn().mockResolvedValue({
      contextualized_text: 'ctx',
      keywords: ['k1'],
      category: 'cat'
    })
  }))
}))
const { IngestionPipeline } = await import('./ingestionPipeline.js')
describe('IngestionPipeline', () => {
  let pipeline, embedder, llm, storage
  beforeEach(() => {
    vi.clearAllMocks()
    embedder = { generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) }
    llm = { enrichChunk: vi.fn().mockResolvedValue({ contextualized_text: 'ctx', keywords: ['k1'], category: 'cat' }) }
    storage = { uploadFile: vi.fn().mockResolvedValue({ r2Key: 'key', publicUrl: 'url' }) }
    pipeline = new IngestionPipeline(embedder, llm, storage)
  })
  it('process and store document (deterministic enrichment, no LLM)', async () => {
    const res = await pipeline.processAndStoreDocument({
      title: 'Test',
      fileBuffer: Buffer.from('data'),
      fileName: 'test.txt',
      mimeType: 'text/plain',
      fullContentText: 'Full content here.',
      paragraphs: ['Para 1.', 'Para 2.']
    })
    expect(res.docId).toBe('doc-1')
    expect(typeof res.childChunksStored).toBe('number')
    expect(embedder.generateEmbedding).toHaveBeenCalled()
    expect(llm.enrichChunk).not.toHaveBeenCalled()
    expect(storage.uploadFile).toHaveBeenCalled()
  })
})
