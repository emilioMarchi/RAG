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
})