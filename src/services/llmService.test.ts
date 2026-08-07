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
  env: { LLM_API_URL: 'http://test', LLM_API_KEY: 'key', LLM_MODEL: 'test-model' }
}))

const { LLMService } = await import('./llmService.js')

describe('LLMService', () => {
  let llm
  beforeEach(() => {
    vi.clearAllMocks()
    llm = new LLMService()
  })

  it('enrichChunk returns parsed JSON', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        contextualized_text: 'ctx',
        keywords: ['k1'],
        category: 'cat'
      }) } }]
    })
    const res = await llm.enrichChunk('Doc', 'Summary', 'Chunk text')
    expect(res.contextualized_text).toBe('ctx')
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
})