import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import { ChunkingService } from './chunkingService.js'

const c = new ChunkingService()

vi.mock('pdf-parse', () => {
  const state: { text: string } = { text: '' }
  return {
    __state: state,
    PDFParse: class {
      async getText() {
        return { text: state.text }
      }
      async destroy() {}
    },
  }
})

vi.mock('pdf-to-img', () => ({
  pdf: vi.fn(async () => {
    const pages: Buffer[] = [Buffer.from('page1'), Buffer.from('page2')]
    return {
      length: pages.length,
      async *[Symbol.asyncIterator]() {
        for (const p of pages) yield p
      },
      async destroy() {},
    }
  }),
}))

vi.mock('tesseract.js', () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: 'OCR extracted page text' } })),
    terminate: vi.fn(async () => undefined),
  })),
}))

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

describe('extractText PDF', () => {
  const real = c.extractText.bind(c)
  const tmpFile = 'test-scanned.pdf'
  let parseState: { text: string }

  beforeEach(async () => {
    fs.writeFileSync(tmpFile, Buffer.from('%PDF-test'))
    parseState = vi.mocked((await import('pdf-parse'))['__state'])
    parseState.text = ''
    const tesseract = await import('tesseract.js')
    vi.mocked(tesseract.createWorker).mockClear()
  })

  afterEach(() => {
    fs.unlinkSync(tmpFile)
  })

  it('falls back to OCR when pdf-parse returns empty text', async () => {
    parseState.text = ''
    const tesseract = await import('tesseract.js')
    const result = await real(tmpFile, 'application/pdf')
    expect(tesseract.createWorker).toHaveBeenCalled()
    expect(result).toContain('OCR extracted page text')
  })

  it('skips OCR when pdf-parse has enough text', async () => {
    parseState.text = 'This is a real PDF text layer with plenty of content to index.'
    const tesseract = await import('tesseract.js')
    const result = await real(tmpFile, 'application/pdf')
    expect(tesseract.createWorker).not.toHaveBeenCalled()
    expect(result).toContain('real PDF text layer')
  })
})
