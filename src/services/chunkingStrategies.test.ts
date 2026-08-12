import { describe, it, expect } from 'vitest'
import {
  ChunkingStrategySelector,
  GenericChunkingStrategy,
  LegalNormChunkingStrategy,
  splitWithStrategy,
} from './chunkingStrategies.js'
import { ChunkingService } from './chunkingService.js'

const c = new ChunkingService()
const selector = new ChunkingStrategySelector()

describe('ChunkingStrategySelector', () => {
  it('selects LegalNorm for legal domain', () => {
    const s = selector.getStrategy({ domain: 'legal' })
    expect(s).toBeInstanceOf(LegalNormChunkingStrategy)
  })

  it('selects LegalNorm for pdf_normativo fileType', () => {
    const s = selector.getStrategy({ fileType: 'pdf_normativo' })
    expect(s).toBeInstanceOf(LegalNormChunkingStrategy)
  })

  it('selects Generic for unclassified files', () => {
    const s = selector.getStrategy({ fileExtension: '.pdf', mimeType: 'application/pdf' })
    expect(s).toBeInstanceOf(GenericChunkingStrategy)
  })

  it('selects Generic for markdown', () => {
    const s = selector.getStrategy({ fileExtension: '.md' })
    expect(s).toBeInstanceOf(GenericChunkingStrategy)
  })
})

describe('LegalNormChunkingStrategy', () => {
  it('reconstructs words split by page-break hyphens', () => {
    const s = new LegalNormChunkingStrategy()
    expect(s.prepare('perso-\nnales').text).toBe('personales')
  })

  it('reconstructs words split by newline without hyphen', () => {
    const s = new LegalNormChunkingStrategy()
    expect(s.prepare('perso\nnales').text).toBe('personales')
  })

  it('keeps long definitions in a single child chunk instead of splitting them', () => {
    const s = new LegalNormChunkingStrategy()
    const longDefinition =
      'ARTICULO 1 - TRATAMIENTO DE DATOS PERSONALES. ' +
      'Se entiende por tratamiento de datos personales toda operación y procedimiento ' +
      'técnico de carácter automatizado que permita la recolección, evaluación, ' +
      'interoperatividad, transferencia o decisión respecto de datos personales ' +
      'sin que se requiera el consentimiento previo del titular en los casos previstos ' +
      'por la presente norma y sus disposiciones reglamentarias complementarias.'
    const { children } = splitWithStrategy(c, longDefinition, s, { childMinChars: 1 })
    expect(children.length).toBeGreaterThan(0)
    // La definición no debe quedar cortada: al menos un child contiene el término clave
    const atLeastOne = children.some(ch => ch.text.includes('TRATAMIENTO DE DATOS PERSONALES'))
    expect(atLeastOne).toBe(true)
    // Ningún child es un fragmento diminuto e inconexo (todos >= childMin de la estrategia)
    for (const ch of children) {
      expect(ch.text.length).toBeGreaterThanOrEqual(s.config.childMinChars)
    }
  })

  it('produce un mapa offset(preparado)→offset(original) alineado al texto fuente', () => {
    const s = new LegalNormChunkingStrategy()
    const original = 'A.\nB\n\nC.'
    const prepared = s.prepare(original)
    // Salto de línea simple → espacio; salto de párrafo (\n\n) se conserva.
    expect(prepared.text).toBe('A. B\n\nC.')
    // El espacio (preparado idx 2) proviene del '\n' original (idx 2).
    expect(prepared.index(2)).toBe(2)
    // 'B' del preparado (idx 3) apunta al 'B' original (idx 3).
    expect(prepared.index(3)).toBe(3)
    expect(prepared.index(6)).toBe(6)
  })

  it('locations referencian el texto original (líneas correctas pese al cleaning)', () => {
    const s = new LegalNormChunkingStrategy()
    // El cleaning une "A.\nB." → "A. B." (reduce el nº de líneas). La ubicación
    // debe seguir anclada a las líneas ORIGINALES, no a las del texto limpiado.
    const original = 'A.\nB.\n\nC.\nD.'
    const prepared = s.prepare(original)
    expect(prepared.text).toBe('A. B.\n\nC. D.')

    // En el preparado "C." está en la línea 2; en el ORIGINAL corresponde a la línea 3.
    const cInPrepared = prepared.text.indexOf('C.') // 7
    const endInPrepared = prepared.text.length // 13
    const located = c.locateOnOriginal(original, undefined, cInPrepared, endInPrepared, prepared.index)
    expect(located.startLine).toBe(4)
    expect(located.startChar).toBe(7)
    expect(original.slice(located.startChar, located.endChar)).toBe('C.\nD.')
  })
})

describe('splitWithStrategy', () => {
  it('applies strategy config sizes', () => {
    const generic = new GenericChunkingStrategy()
    const legal = new LegalNormChunkingStrategy()

    const longText = 'ARTICULO 2. ' + 'palabra valiosa '.repeat(200)

    const genericChildren = splitWithStrategy(c, longText, generic, { childMinChars: 1 })
    const legalChildren = splitWithStrategy(c, longText, legal, { childMinChars: 1 })

    // Con la estrategia legal los child chunks permiten ser más largos (600) que el genérico (450)
    const genericMax = Math.max(...genericChildren.children.map(ch => ch.text.length))
    const legalMax = Math.max(...legalChildren.children.map(ch => ch.text.length))
    expect(legalMax).toBeGreaterThanOrEqual(genericMax)
  })

  it('aplica overlap hacia atrás entre child chunks cuando overlapChars > 0', () => {
    const generic = new GenericChunkingStrategy()
    const text = 'palabra '.repeat(120) // texto corrido que fuerza varios children

    const noOverlap = splitWithStrategy(c, text, generic, { childMinChars: 1 })
    const withOverlap = splitWithStrategy(c, text, generic, { childMinChars: 1, overlapChars: 40 })

    expect(noOverlap.children.length).toBeGreaterThan(1)
    expect(withOverlap.children.length).toBe(noOverlap.children.length)

    // El 2º child con overlap empieza antes (incluye contexto del previo)
    const b = withOverlap.children[1]
    expect(b.text.length).toBeGreaterThan(noOverlap.children[1].text.length)
    // La location sigue anclada al texto ORIGINAL: el slice deriva del original, no del preparado
    const loc = b.location
    expect(loc).toBeDefined()
    expect(loc!.startChar!).toBeGreaterThanOrEqual(0)
  })

  it('registra rango core (sin overlap) vs extended cuando overlapChars > 0', () => {
    const generic = new GenericChunkingStrategy()
    const text = 'palabra '.repeat(120)

    const withOverlap = splitWithStrategy(c, text, generic, { childMinChars: 1, overlapChars: 40 })
    const b = withOverlap.children[1]
    const loc = b.location

    expect(loc).toBeDefined()
    expect(loc!.coreStartChar).toBeDefined()
    expect(loc!.coreEndChar).toBeDefined()
    // El núcleo NO incluye el overlap: empieza después del rango ampliado
    expect(loc!.coreStartChar!).toBeGreaterThanOrEqual(loc!.startChar!)
    expect(loc!.coreEndChar!).toBeLessThanOrEqual(loc!.endChar!)
    // El rango core apunta al fragmento real del chunk (b.text) descontado el prefijo
    const coreSlice = text.slice(loc!.coreStartChar!, loc!.coreEndChar!)
    expect(b.text.endsWith(coreSlice)).toBe(true)
  })

  it('ancla un contextPath normativo jerárquico en la estrategia legal (Fase 6)', () => {
    const legal = new LegalNormChunkingStrategy()
    // ARTICULO 14 largo para forzar que ARTICULO 15 quede en un child propio.
    const law = [
      'LEY 27.541 - PRESUPUESTO.',
      'TITULO II - REGIMEN FISCAL.',
      'ARTICULO 14. - ' + 'contenido impositivo extenso y detallado del regimen '.repeat(40),
      'ARTICULO 15. - Facultades de la autoridad para la fiscalización.',
    ].join('\n\n')
    const { children } = splitWithStrategy(c, law, legal, { childMinChars: 1 })
    const withAtr15 = children.find(ch => ch.contextPath?.includes('ARTICULO 15'))
    expect(withAtr15).toBeDefined()
    expect(withAtr15!.contextPath).toContain('LEY 27.541')
    expect(withAtr15!.contextPath).toContain('TITULO II')
    expect(withAtr15!.contextPath).toContain('ARTICULO 15')
    // La estrategia genérica no genera contextPath
    const generic = new GenericChunkingStrategy()
    const g = splitWithStrategy(c, law, generic, { childMinChars: 1 })
    expect(g.children.some(ch => ch.contextPath)).toBe(false)
  })

  it('respeta el hook adaptativo sizeFor por segmento (Fase 7)', () => {
    const generic = new GenericChunkingStrategy()
    // texto con párrafos alternos que el detector parte en segmentos
    const text = Array.from({ length: 20 }, (_, i) => `Párrafo ${i} de contenido suficientemente extenso para cortar.`).join('\n\n')

    // sizeFor estricto: cada segmento de 6 chars de máx → fuerza muchos chunks pequeños
    const strict = splitWithStrategy(c, text, generic, { childMinChars: 1, sizeFor: () => 6 })
    expect(strict.children.length).toBeGreaterThan(1)
    // un sizeFor generoso devuelve menos chunks que el estricto
    const loose = splitWithStrategy(c, text, generic, { childMinChars: 1, sizeFor: () => 100000 })
    expect(loose.children.length).toBeLessThan(strict.children.length)
  })
})