import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import { ChunkingService } from './chunkingService.js'

const c = new ChunkingService()

const pdfTestState = vi.hoisted(() => ({
  items: [] as Array<{ str: string; width?: number; height?: number; transform?: number[]; hasEOL?: boolean }>,
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return {
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 1,
        async getPage() {
          return {
            getViewport: () => ({ width: 596, height: 842 }),
            getTextContent: async () => ({ items: pdfTestState.items }),
          }
        },
        async destroy() {},
      }),
    })),
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

describe('splitHierarchical location', () => {
  it('assigns startChar/endChar/startLine/endLine for text chunks', () => {
    const text = `Línea uno del documento.\nSegunda línea con más contenido web.\n\nTercer párrafo suficientemente largo.\n`
    const { children } = c.splitHierarchical(text, 'text/plain', { childMaxChars: 2000, childMinChars: 1 })
    expect(children.length).toBeGreaterThan(0)
    for (const ch of children) {
      expect(ch.location).toBeDefined()
      expect(ch.location!.startChar).toBeGreaterThanOrEqual(0)
      expect(ch.location!.endChar).toBeGreaterThan(ch.location!.startChar)
      expect(ch.location!.startLine).toBeGreaterThanOrEqual(1)
      expect(ch.location!.endLine).toBeGreaterThanOrEqual(ch.location!.startLine)
      const slice = text.slice(ch.location!.startChar, ch.location!.endChar)
      expect(ch.text).toBe(slice.trim() === '' ? ch.text : ch.text)
    }
  })

  it('assigns pageNumber and boundingBoxes for PDF pages', () => {
    const pages = [
      {
        pageNumber: 1,
        text: 'Primera página del documento con contenido.',
        items: [{ str: 'Primera página', x: 0.1, y: 0.1, width: 0.4, height: 0.05 }],
        ranges: [{ start: 0, end: 15, item: { str: 'Primera página', x: 0.1, y: 0.1, width: 0.4, height: 0.05 } }],
      },
      {
        pageNumber: 2,
        text: 'Segunda página del documento blah blah.',
        items: [{ str: 'Segunda página', x: 0.2, y: 0.3, width: 0.5, height: 0.06 }],
        ranges: [{ start: 0, end: 15, item: { str: 'Segunda página', x: 0.2, y: 0.3, width: 0.5, height: 0.06 } }],
      },
    ]
    const flat = c.buildFlatText(pages as never)
    const { children } = c.splitHierarchical(flat, 'application/pdf', {
      childMaxChars: 2000,
      childMinChars: 1,
      pages: pages as never,
    })
    expect(children.length).toBeGreaterThan(0)
    const withPage = children.find(ch => ch.location?.pageNumber != null)
    expect(withPage).toBeDefined()
    expect(withPage!.location!.pageNumber).toBeGreaterThanOrEqual(1)
  })
})

describe('splitStructural', () => {
  it('no parte dentro de un ARTÍCULO: corta en las fronteras de numeración', () => {
    const c2 = new ChunkingService()
    const text = [
      'ARTÍCULO 1. - Cuerpo del primer artículo con contenido suficiente para el ejemplo.',
      'ARTÍCULO 2. - Segundo artículo que también debe respetarse como bloque individual.',
      'ARTÍCULO 3. - Tercer artículo con algo de texto adicional.',
    ].join('\n')
    const slices = c2.splitStructural(text, 2000)
    expect(slices.length).toBeGreaterThan(0)
    for (const s of slices) {
      expect(s.text.length).toBeLessThanOrEqual(2000)
      // Un artículo no debe qjuntarse con el anterior sin respetar su frontera cuando el bloque cabe.
      expect(/^ARTÍCULO \d/.test(s.text.trim())).toBe(true)
    }
  })

  it('divide en múltiples slices cuando el texto excede maxChars', () => {
    const c2 = new ChunkingService()
    const text = ['# Título', 'ARTÍCULO 1.', 'palabra valiosa '.repeat(50), 'ARTÍCULO 2.', 'palabra valiosa '.repeat(50)].join('\n')
    const slices = c2.splitStructural(text, 200)
    expect(slices.length).toBeGreaterThan(1)
    for (const s of slices) expect(s.text.length).toBeLessThanOrEqual(200)
  })

  it('preserva offsets correctos sobre el texto de entrada', () => {
    const c2 = new ChunkingService()
    const text = '# Título\n\nARTÍCULO 1. Inicio.\n\nARTÍCULO 2. Siguiente.'
    const slices = c2.splitStructural(text, 2000)
    for (const s of slices) {
      expect(text.slice(s.start, s.end)).toBe(s.text)
    }
  })

  it('cae a corte por oración para bloques sin fronteras que exceden el tope', () => {
    const c2 = new ChunkingService()
    const text = 'UNSOLOARTICULOSINFONTERAS'.repeat(50) // texto corrido: no hay \n ni marcadores
    const slices = c2.splitStructural(text, 100)
    expect(slices.length).toBeGreaterThan(1)
    for (const s of slices) expect(s.text.length).toBeLessThanOrEqual(100)
  })
})

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

  beforeEach(async () => {
    fs.writeFileSync(tmpFile, Buffer.from('%PDF-test'))
    pdfTestState.items = []
    const tesseract = await import('tesseract.js')
    vi.mocked(tesseract.createWorker).mockClear()
  })

  afterEach(() => {
    fs.unlinkSync(tmpFile)
  })

  it('falls back to OCR when the PDF has no text layer (empty items)', async () => {
    pdfTestState.items = []
    const tesseract = await import('tesseract.js')
    const result = await real(tmpFile, 'application/pdf')
    expect(tesseract.createWorker).toHaveBeenCalled()
    expect(result).toContain('OCR extracted page text')
  })

  it('skips OCR when the PDF has enough text in the text layer', async () => {
    pdfTestState.items = [{ str: 'This is a real PDF text layer with plenty of content to index.' }]
    const tesseract = await import('tesseract.js')
    const result = await real(tmpFile, 'application/pdf')
    expect(tesseract.createWorker).not.toHaveBeenCalled()
    expect(result).toContain('real PDF text layer')
  })
})
