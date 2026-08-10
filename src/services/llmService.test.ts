import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()

vi.mock('../utils/retry.js', () => ({ withRetry: (fn) => fn() }))

vi.mock('openai', () => {
  class MockOpenAI {
    constructor() {
      this.chat = { completions: { create: mockCreate } }
    }
  }
  return { default: MockOpenAI }
})

vi.mock('../config/env.js', () => ({
  env: { LLM_API_URL: 'http://test', LLM_API_KEY: 'key', LLM_MODEL: 'test-model', LLM_BACKUP_MODEL: 'backup-model' }
}))

const { LLMService } = await import('./llmService.js')

describe('LLMService', () => {
  let llm
  beforeEach(() => {
    vi.clearAllMocks()
    llm = new LLMService()
  })

  it('enrichChunk returns parsed JSON and assembles contextualized', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        context_prefix: 'contexto del doc',
        keywords: ['k1'],
        category: 'cat'
      }) } }]
    })
    const res = await llm.enrichChunk('Doc', 'Summary', 'Chunk text')
    expect(res.contextualized_text).toBe('contexto del doc - Fragmento: Chunk text')
    expect(res.keywords).toEqual(['k1'])
    expect(res.category).toBe('cat')
  })

  it('generateRAGAnswer returns answer text', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'RAG answer' } }]
    })
    const res = await llm.generateRAGAnswer('query', 'context')
    expect(res).toBe('RAG answer')
  })

  it('throws on empty LLM response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: null } }]
    })
    await expect(llm.enrichChunk('d', 's', 'c')).rejects.toThrow('empty response')
  })

  it('falls back to backup model on 429 and succeeds', async () => {
    const rateLimitError = new Error('429 Provider returned error')
    rateLimitError.status = 429
    mockCreate
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({
          context_prefix: 'ok',
          keywords: ['k'],
          category: 'c'
        }) } }]
      })
    const res = await llm.enrichChunk('Doc', 'Summary', 'Chunk')
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockCreate.mock.calls[0][0].model).toBe('test-model')
    expect(mockCreate.mock.calls[1][0].model).toBe('backup-model')
    expect(res.contextualized_text).toBe('ok - Fragmento: Chunk')
  })

  it('rethrows non-rate-limit errors immediately without fallback', async () => {
    const serverError = new Error('500 Internal Server Error')
    mockCreate.mockRejectedValue(serverError)
    await expect(llm.enrichChunk('d', 's', 'c')).rejects.toThrow('500 Internal Server Error')
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})