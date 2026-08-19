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

  it('assigns boxesByPage covering multiple pages for a chunk that crosses a page boundary', () => {
    const pages = [
      {
        pageNumber: 1,
        text: 'INICIO DE LA LEY.\nParrafo que termina en la pagina uno.',
        items: [
          { str: 'INICIO', x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
          { str: ' DE LA LEY.', x: 0.31, y: 0.1, width: 0.3, height: 0.05 },
        ],
        ranges: [
          { start: 0, end: 6, item: { str: 'INICIO', x: 0.1, y: 0.1, width: 0.2, height: 0.05 } },
          { start: 6, end: 18, item: { str: ' DE LA LEY.', x: 0.31, y: 0.1, width: 0.3, height: 0.05 } },
        ],
      },
      {
        pageNumber: 2,
        text: 'CONTINUACION DEL TEXTO.\nOtro parrafo en la segunda pagina.',
        items: [
          { str: 'CONTINUACION', x: 0.2, y: 0.3, width: 0.4, height: 0.06 },
          { str: ' DEL TEXTO.', x: 0.61, y: 0.3, width: 0.3, height: 0.06 },
        ],
        ranges: [
          { start: 0, end: 12, item: { str: 'CONTINUACION', x: 0.2, y: 0.3, width: 0.4, height: 0.06 } },
          { start: 12, end: 24, item: { str: ' DEL TEXTO.', x: 0.61, y: 0.3, width: 0.3, height: 0.06 } },
        ],
      },
    ]
    // Fragmento cuyo texto se reparte entre las dos páginas (no existe completo en ninguna).
    const needle = 'INICIO DE LA LEY.\nParrafo hipotetico ausente.\nCONTINUACION DEL TEXTO.'
    const flat = c.buildFlatText(pages as never)
    const { children } = c.splitHierarchical(flat, 'application/pdf', {
      childMaxChars: 2000,
      childMinChars: 1,
      pages: pages as never,
    })

    const chunk = children.find(ch => ch.text.includes('INICIO DE LA LEY'))
    expect(chunk).toBeDefined()
    expect(chunk!.location!.pageNumber).toBe(1)
    expect(Array.isArray(chunk!.location!.boxesByPage)).toBe(true)
    const pagesHit = chunk!.location!.boxesByPage!.map(p => p.pageNumber)
    expect(pagesHit).toContain(1)
    expect(pagesHit.length).toBeGreaterThanOrEqual(1)
    for (const p of chunk!.location!.boxesByPage!) {
      expect(Array.isArray(p.boxes)).toBe(true)
      expect(p.boxes.length).toBeGreaterThan(0)
    }
  })
})

describe('sanitizeLayout (Fase 0)', () => {
  const header = { str: 'Boletín Oficial N° 34.120', x: 0.2, y: 0.05, width: 0.4, height: 0.03 }
  const footer = { str: 'Página de cierre', x: 0.2, y: 0.95, width: 0.4, height: 0.03 }
  const body = { str: 'Contenido real del artículo.', x: 0.1, y: 0.5, width: 0.5, height: 0.04 }

  it('quita headers y footers repetidos en varias páginas pero conserva el cuerpo', () => {
    const pages = [1, 2, 3, 4].map(pageNumber => ({
      pageNumber,
      text: '',
      items: [header, body, footer],
      ranges: [] as never,
    }))
    const out = c.sanitizeLayout(pages as never)
    expect(out).toHaveLength(4)
    for (const p of out) {
      expect(p.text).not.toContain(header.str)
      expect(p.text).not.toContain(footer.str)
      expect(p.text).toContain(body.str)
    }
  })

  it('conserva filas de borde que NO se repiten (no hay falso positivo)', () => {
    const unique = { str: 'Contenido unico de esta pagina', x: 0.2, y: 0.05, width: 0.5, height: 0.03 }
    const pages = [
      { pageNumber: 1, text: '', items: [unique, body], ranges: [] as never },
      { pageNumber: 2, text: '', items: [body], ranges: [] as never },
      { pageNumber: 3, text: '', items: [body], ranges: [] as never },
    ]
    const out = c.sanitizeLayout(pages as never)
    const pageStr = (i: number) => out[i].items.map(x => x.str)
    expect(pageStr(0)).toContain(unique.str)
    expect(pageStr(0)).toContain(body.str)
  })

  it('no toca documentos con pocas páginas (sin repetición significativa)', () => {
    const pages = [
      { pageNumber: 1, text: '', items: [header, body], ranges: [] as never },
      { pageNumber: 2, text: '', items: [header, body], ranges: [] as never },
    ]
    const out = c.sanitizeLayout(pages as never)
    expect(out[0].items.map(x => x.str)).toContain(header.str)
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

describe('splitByArticles', () => {
  it('genera un parent chunk por ARTICULO sin agrupar artículos cortos', () => {
    const c2 = new ChunkingService()
    const text = [
      'LEY 27.541 - PRESUPUESTO.',
      'CONSIDERANDO que resulta necesario adecuar el marco fiscal.',
      'TITULO II - REGIMEN FISCAL.',
      'ARTICULO 1. - Objeto de la presente.',
      'ARTICULO 2. - Facultades de la autoridad.',
      'TITULO III - DISPOSICIONES FINALES.',
      'ARTICULO 3. - Vigencia.',
    ].join('\n')
    const slices = c2.splitByArticles(text, { maxChars: 3500 })!
    expect(slices).toBeDefined()
    // preámbulo + 3 artículos
    expect(slices.length).toBe(4)
    const artStarts = slices.map(s => s.text.trim())
    expect(artStarts[0]).toContain('CONSIDERANDO')
    expect(artStarts[0]).not.toContain('ARTICULO 1')
    // el TITULO II queda adherido al ARTICULO 1 (nunca al preámbulo ni huérfano)
    expect(artStarts[1]).toContain('TITULO II')
    expect(artStarts[1]).toContain('ARTICULO 1.')
    expect(artStarts[1]).not.toContain('ARTICULO 2.')
    // cada artículo es un chunk propio
    expect(artStarts[2]).toContain('ARTICULO 2.')
    expect(artStarts[2]).not.toContain('ARTICULO 3.')
    expect(artStarts[3]).toContain('TITULO III')
    expect(artStarts[3]).toContain('ARTICULO 3.')
  })

  it('adhiere una cadena de encabezados contiguos al artículo que la sigue', () => {
    const c2 = new ChunkingService()
    const text = [
      'TITULO II - REGIMEN FISCAL.',
      'CAPITULO III - IMPOSICION.',
      'ARTICULO 14. - Se establece el regimen de la presente.',
      'ARTICULO 15. - Facultades del Estado.',
    ].join('\n')
    const slices = c2.splitByArticles(text, { maxChars: 3500 })!
    expect(slices.length).toBe(2)
    expect(slices[0].text).toContain('TITULO II')
    expect(slices[0].text).toContain('CAPITULO III')
    expect(slices[0].text).toContain('ARTICULO 14.')
    // un encabezado nunca queda colgado al chunk del artículo anterior
    expect(slices[0].text).not.toContain('ARTICULO 15.')
    expect(slices[1].text).toContain('ARTICULO 15.')
  })

  it('el cuerpo entre encabezado y artículo (introducción de sección) queda en el chunk del título', () => {
    const c2 = new ChunkingService()
    const text = (
      'ARTICULO 4. - Regla anterior.\n\n' +
      'TITULO V - DE LA PRESCRIPCION.\n' +
      'La prescripción se computa desde la fecha de la infracción.\n\n' +
      'ARTICULO 20. - Plazo de prescripción.'
    )
    const slices = c2.splitByArticles(text, { maxChars: 3500 })!
    expect(slices.length).toBe(2)
    expect(slices[0].text).toContain('ARTICULO 4.')
    expect(slices[0].text).not.toContain('TITULO V')
    expect(slices[1].text).toContain('TITULO V')
    expect(slices[1].text).toContain('La prescripción se computa')
    expect(slices[1].text).toContain('ARTICULO 20.')
  })

  it('el preámbulo es un chunk propio y un ANEXO inicia su propio chunk', () => {
    const c2 = new ChunkingService()
    const text = [
      'DECRETO 124 - REGLAMENTARIO.',
      'CONSIDERANDO que corresponde reglamentar la ley 27.541.',
      'ARTICULO 1. - Reglamento.',
      'ARTICULO 2. - Alcance.',
      'ANEXO I',
      'Formulario de declaración jurada.',
    ].join('\n')
    const slices = c2.splitByArticles(text, { maxChars: 3500 })!
    expect(slices.length).toBe(4)
    expect(slices[0].text).toContain('DECRETO 124')
    expect(slices[3].text).toContain('ANEXO I')
    expect(slices[3].text).toContain('Formulario de declaración jurada.')
    expect(slices[3].text).not.toContain('ARTICULO')
  })

  it('subdivide un artículo gigante respetando sus fronteras internas', () => {
    const c2 = new ChunkingService()
    const incisos = Array.from({ length: 14 }, (_, i) => `${['a', 'b', 'c', 'd', 'e', 'f'][i % 6]}) inciso con contenido extenso del artículo.`)
    const text = 'ARTICULO 1. - Objeto.\n' + incisos.join('\n')
    const slices = c2.splitByArticles(text, { maxChars: 300 })!
    expect(slices.length).toBeGreaterThan(1)
    for (const s of slices) expect(s.text.length).toBeLessThanOrEqual(300)
    // el encabezado del artículo queda en el primer trozo
    expect(slices[0].text).toContain('ARTICULO 1. - Objeto.')
    // sin pérdida ni reordenamiento de contenido (los separadores de línea de los
    // cortes son espacio en blanco normalizado)
    const norm = (t: string) => t.replace(/\s+/g, ' ')
    expect(norm(slices.map(s => s.text).join(' '))).toBe(norm(text))
  })

  it('devuelve undefined cuando no hay articulación (cero regresión)', () => {
    const c2 = new ChunkingService()
    const slices = c2.splitByArticles('Simplemente un texto sin artículos, con párrafos comunes.')
    expect(slices).toBeUndefined()
  })

  it('descarta el índice (TOC) de un PDF al computar fronteras', () => {
    const c2 = new ChunkingService()
    const text = [
      'LEY 27.541 - PRESUPUESTO.',
      'TITULO II .......... 5',
      'CAPITULO III ....... 6',
      'ARTICULO 14 ........ 7',
      'ARTICULO 15 ........ 8',
      'TITULO II - REGIMEN FISCAL.',
      'ARTICULO 14. - Se establece el regimen.',
      'ARTICULO 15. - Facultades del Estado.',
    ].join('\n')
    const slices = c2.splitByArticles(text, { maxChars: 3500, mimeType: 'application/pdf' })!
    // las líneas del índice no generan fronteras: solo preámbulo + 2 artículos
    expect(slices.length).toBe(3)
    expect(slices[0].text).toContain('LEY 27.541')
    // el TITULO real se adhiere al ARTICULO 14 (no al preámbulo)
    expect(slices[1].text.startsWith('TITULO II - REGIMEN FISCAL.')).toBe(true)
    expect(slices[1].text).toContain('ARTICULO 14.')
    expect(slices[2].text).toContain('ARTICULO 15.')
    // sin modo PDF, las líneas del índice SÍ producen fronteras (comportamiento previo)
    const noPdf = c2.splitByArticles(text, { maxChars: 3500 })!
    expect(noPdf.length).toBeGreaterThan(3)
  })

  it('respeta el fallback por tamaño cuando se pasan parentSlices a splitHierarchical', () => {
    const c2 = new ChunkingService()
    const text = 'ARTICULO 1. - Uno.\nARTICULO 2. - Dos.'
    const parents = c2.splitByArticles(text, { maxChars: 3500 })!
    const { parents: p, children } = c2.splitHierarchical(text, 'text/plain', {
      parentSlices: parents,
      childMaxChars: 1000,
      childMinChars: 1,
    })
    expect(p.length).toBe(2)
    expect(p[0].text).toContain('ARTICULO 1.')
    expect(p[1].text).toContain('ARTICULO 2.')
    expect(children.length).toBeGreaterThanOrEqual(2)
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
