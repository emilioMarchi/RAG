import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry.js'

describe('withRetry', () => {
  it('should return result on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('should retry on failure and succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('success')
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 })
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('should throw after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent'))
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 10 })
    ).rejects.toThrow('persistent')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('should use longer delay for rate limit errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'))
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 100, rateLimitDelay: 50 })
    ).rejects.toThrow('429')
  })
})
