import { describe, it, expect } from 'vitest'
import { mapConcurrent } from './concurrency.js'

describe('mapConcurrent', () => {
  it('should process all items in order', async () => {
    const result = await mapConcurrent([1, 2, 3], async (n) => n * 2)
    expect(result).toEqual([2, 4, 6])
  })

  it('should handle empty array', async () => {
    const result = await mapConcurrent([], async (n) => n)
    expect(result).toEqual([])
  })
})
