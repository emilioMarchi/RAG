import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChunkingService } from './chunkingService.js'
import { GenericChunkingStrategy, splitWithStrategy } from './chunkingStrategies.js'

const c = new ChunkingService()

// Reproduce el texto plano real de un PDF (igual que documents.ts:47)
function makePages(lineGroups: Array<Array<{ str: string; x: number; y: number; w: number; h: number }>>) {
  const pages = lineGroups.map((items, i) => {
    let text = ''
    const ranges: any[] = []
    for (const it of items) {
      const start = text.length
      text += it.str
      text += '\n'
      ranges.push({ start, end: start + it.str.length, item: { str: it.str, x: it.x, y: it.y, width: it.w, height: it.h } })
    }
    return { pageNumber: i + 1, text: text.trimEnd(), items: items as any, ranges }
  })
  return pages
}

const PAGE1 = [
  { str: 'ARTICULO 1. Primera norma valiosa.', x: 0.1, y: 0.1, w: 0.5, h: 0.04 },
  { str: 'Contenido del articulo inicial.', x: 0.1, y: 0.15, w: 0.5, h: 0.04 },
]
const PAGE2 = [
  { str: 'ARTICULO 2. Segunda disposicion.', x: 0.1, y: 0.2, w: 0.5, h: 0.04 },
  { str: 'Texto que pertenece al segundo.', x: 0.1, y: 0.25, w: 0.5, h: 0.04 },
]
const PAGE3 = [
  { str: 'ARTICULO 3. Tercera regla con mas texto para que luego haya varios fragmentos y se defase mucho mas claramente en el resaltado.', x: 0.1, y: 0.3, w: 0.9, h: 0.05 },
  { str: 'Continuacion del tercer articulo con contenido suficiente.', x: 0.1, y: 0.35, w: 0.8, h: 0.04 },
  { str: 'Otra linea del articulo tercero.', x: 0.1, y: 0.4, w: 0.7, h: 0.04 },
]

describe('INTEGRIDAD: el texto leído en la interfaz coincide 1:1 con lo marcado en el PDF', () => {
  // TEST DE REPRODUCCIÓN EXACTA: cada chunk debe poder ubicarse en el texto plano
  // original usando sus offsets STARTCHAR, y ese slice debe ser exactamente chunk.text.
  // Si esto falla para PDFs, la causa es que la rama PDF de splitSlices genera offsets
  // APROXIMADOS (acumulados por "text.length + PAGE_SEP"), que divergen del texto real
  // a medida que avanzan los fragmentos → defase que se ve desde el fragmento ~5.
  it('PDF generic: startChar apunta exactamente al texto del chunk en el original', () => {
    const flat = c.buildFlatText(makePages([PAGE1, PAGE2, PAGE3]) as any)
    const pages = makePages([PAGE1, PAGE2, PAGE3])
    const { children } = splitWithStrategy(c, flat, new GenericChunkingStrategy(), {
      mimeType: 'application/pdf',
      pages: pages as any,
      childMinChars: 1,
    })

    expect(children.length).toBeGreaterThan(1)
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

    for (const ch of children) {
      const loc = ch.location
      expect(loc, `chunk ${ch.childIndex} sin location`).toBeDefined()
      // Reproducir desde el ORIGINAL usando solo offsets (como hace el visor).
      const reproduced = flat.slice(loc!.startChar ?? 0, loc!.endChar ?? 0)
      expect(norm(reproduced), `chunk ${ch.childIndex}: slice(offset) no coincide con chunk.text`).toBe(norm(ch.text))
    }
  })
})

describe('REGRESION: el detector de TOC no elimina las enumeraciones internas de los artículos', () => {
  // Un documento legal real: un índice de contenidos al PRINCIPIO y luego artículos
  // cuyos puntos se enumeran con "N. ...". El detector de TOC antiguo confundía esas
  // líneas numeradas con un índice y las ELIMINABA (p. ej. el punto 4 del artículo 4
  // de la Ley 25.326 desaparecía de los chunks). El fix solo limpia el TOC antes del
  // primer encabezado estructural (ARTICULO/CAPITULO/TITULO).
  const TOC_AND_ART4 = [
    'ARTICULO 1. Objeto de la ley',
    'ARTICULO 2. Definiciones',
    'ARTICULO 3. Archivos de datos',
    'ARTICULO 4. Calidad de los datos',
    'ARTICULO 4° — (Calidad de los datos).',
    '1. Los datos personales que se recojan deben ser ciertos, adecuados y pertinentes.',
    '2. La recolección de datos no puede hacerse por medios desleales o fraudulentos.',
    '3. Los datos no pueden ser utilizados para finalidades distintas.',
    '4. Los datos deben ser exactos y actualizarse en el caso de que ello fuere necesario.',
    '5. Los datos total o parcialmente inexactos deben ser suprimidos.',
    '6. Los datos deben ser almacenados de modo que permitan el ejercicio del derecho de acceso.',
    '7. Los datos deben ser destruidos cuando hayan dejado de ser necesarios.',
  ]

  it('conserva todos los puntos numerados del artículo aunque haya un TOC al inicio', () => {
    const lines = TOC_AND_ART4
    const pages = makePages([lines.map((str, i) => ({ str, x: 0.1, y: 0.1 + i * 0.05, w: 0.8, h: 0.04 }))])
    const flat = c.buildFlatText(pages as any)
    const frags = c.splitIntoParagraphs(flat, 'application/pdf')
    const joined = frags.join('\n')
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    const joinedN = norm(joined)

    expect(frags.length).toBeGreaterThan(0)
    expect(joinedN).toContain(norm('ARTICULO 4° — (Calidad de los datos).'))
    expect(joinedN).toContain(norm('1. Los datos personales que se recojan deben ser ciertos, adecuados y pertinentes.'))
    expect(joinedN).toContain(norm('2. La recolección de datos no puede hacerse por medios desleales o fraudulentos.'))
    expect(joinedN).toContain(norm('3. Los datos no pueden ser utilizados para finalidades distintas.'))
    expect(joinedN).toContain(norm('4. Los datos deben ser exactos y actualizarse en el caso de que ello fuere necesario.'))
    expect(joinedN).toContain(norm('5. Los datos total o parcialmente inexactos deben ser suprimidos.'))
    expect(joinedN).toContain(norm('6. Los datos deben ser almacenados de modo que permitan el ejercicio del derecho de acceso.'))
    expect(joinedN).toContain(norm('7. Los datos deben ser destruidos cuando hayan dejado de ser necesarios.'))
  })
})