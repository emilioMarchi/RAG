import { describe, it, expect } from 'vitest'
import { ChunkingService } from './chunkingService.js'

const c = new ChunkingService()

describe('splitIntoParagraphs', () => {
  it('split by double newlines', () => {
    const r = c.splitIntoParagraphs('First paragraph is long enough.\n\nSecond paragraph also long enough.\n\nThird long paragraph.')
    expect(r).toHaveLength(3)
    expect(r[0]).toBe('First paragraph is long enough.')
  })

  it('filter short paragraphs', () => {
    const r = c.splitIntoParagraphs('Hi\n\nThis is a long enough paragraph to pass the filter.')
    expect(r).toHaveLength(1)
  })

  it('return empty for no content', () => {
    const r = c.splitIntoParagraphs('   \n\n   ')
    expect(r).toHaveLength(0)
  })
})

describe('generateSummary', () => {
  it('return full text if shorter than max', () => {
    expect(c.generateSummary('hello', 100)).toBe('hello')
  })

  it('truncate long text with ellipsis', () => {
    const long = 'a '.repeat(200)
    const s = c.generateSummary(long, 50)
    expect(s.length).toBeLessThan(long.length)
    expect(s.endsWith('...')).toBe(true)
  })
})
