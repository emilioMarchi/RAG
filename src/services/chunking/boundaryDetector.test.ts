import { describe, it, expect } from 'vitest'
import { detectBoundaries, BoundaryKind } from './boundaryDetector.js'

describe('detectBoundaries', () => {
  it('detecta los offsets de cada ARTÍCULO de una norma', () => {
    const text = [
      'ARTÍCULO 1. - La presente norma tiene por objeto regular el tratamiento de datos personales.',
      'ARTÍCULO 2. - Se entiende por tratamiento toda operación técnica automatizada.',
      'ARTÍCULO 3. - Inciso a) del párrafo anterior: quedan comprendidas las entidades públicas.',
    ].join('\n')
    const bounds = detectBoundaries(text)
    const numbered = bounds.filter(b => b.kind === 'numbered')
    expect(numbered.length).toBe(3)
    const starts = numbered.map(b => b.start)
    expect(starts[0]).toBe(0)
    expect(text.slice(starts[0], starts[0] + 10)).toBe('ARTÍCULO 1')
    expect(text.slice(starts[1], starts[1] + 10)).toBe('ARTÍCULO 2')
    expect(text.slice(starts[2], starts[2] + 10)).toBe('ARTÍCULO 3')
  })

  it('detecta encabezados markdown e identifica su label', () => {
    const text = '# Título principal\n\n## Sección 1\nAlgo de contenido.\n## Sección 2\nMás contenido.'
    const bounds = detectBoundaries(text)
    const headings = bounds.filter(b => b.kind === 'heading')
    expect(headings.some(b => b.label?.includes('Título principal'))).toBe(true)
    expect(headings.some(b => b.label?.includes('Sección 1'))).toBe(true)
    expect(headings.some(b => b.label?.includes('Sección 2'))).toBe(true)
  })

  it('detecta la frontera de cada párrafo (bloques separados por \\n\\n)', () => {
    const text = 'Primer párrafo con contenido suficiente.\n\nSegundo párrafo con otro contenido.\n\nTercer párrafo.'
    const bounds = detectBoundaries(text, { kinds: ['paragraph'] })
    const paragraphs = bounds.filter(b => b.kind === 'paragraph')
    expect(paragraphs.length).toBe(3)
    expect(paragraphs[0].start).toBe(0)
    expect(text.slice(paragraphs[0].start, paragraphs[0].start + 6)).toBe('Primer')
  })

  it('detecta ítems de listas con guiones', () => {
    const text = 'Introducción.\n- Primer ítem de la lista\n- Segundo ítem de la lista'
    const bounds = detectBoundaries(text, { kinds: ['list'] })
    const lists = bounds.filter(b => b.kind === 'list')
    expect(lists.length).toBe(2)
    expect(lists[0].label?.includes('Primer ítem')).toBe(true)
  })

  it('detecta incisos de artículo en minúscula (a), b., aa)) como kind item', () => {
    const text = [
      'ARTICULO 1. - Cuerpo del artículo.',
      'a) inciso primero con contenido suficiente para el ejemplo',
      'b) inciso segundo que también debe detectarse',
      'aa) último inciso compuesto',
      '2) numeral doble',
    ].join('\n')
    const bounds = detectBoundaries(text, { kinds: ['item', 'numbered'] })
    const items = bounds.filter(b => b.kind === 'item')
    expect(items.length).toBe(3)
    expect(items[0].label?.startsWith('a)')).toBe(true)
    expect(items[1].label?.startsWith('b)')).toBe(true)
    expect(items[2].label?.startsWith('aa)')).toBe(true)
    // La enumeración numérica sigue siendo numbered (no item)
    expect(bounds.some(b => b.kind === 'numbered' && b.label?.startsWith('2)'))).toBe(true)
  })

  it('una oración común en minúscula no se confunde con un inciso', () => {
    const text = 'las disposiciones de la presente ley serán de orden público.'
    const bounds = detectBoundaries(text, { kinds: ['item'] })
    expect(bounds.filter(b => b.kind === 'item')).toHaveLength(0)
  })

  it('detecta saltos de página conservados como form-feed', () => {
    const text = 'Contenido página 1.\fContenido página 2.\fContenido página 3.'
    const bounds = detectBoundaries(text, { kinds: ['page'] })
    const pages = bounds.filter(b => b.kind === 'page')
    expect(pages.length).toBe(2)
    expect(pages.every(b => b.label === 'página')).toBe(true)
  })

  it('resuelve un número legal como numbered (más específico) cuando coincide como heading', () => {
    const text = '1. Primera cláusula.\n2. Segunda cláusula.'
    const bounds = detectBoundaries(text)
    const atStart = bounds.filter(b => b.start === 0)
    expect(atStart.some(b => b.kind === 'numbered')).toBe(true)
    // No puede haber dos fronteras distintas en el mismo offset
    expect(new Set(bounds.map(b => b.start)).size).toBe(bounds.length)
  })

  it('respeta la restricción de kinds pasada por opciones', () => {
    const text = '# Título\nARTÍCULO 5. Cuerpo.'
    const onlyNumbers = detectBoundaries(text, { kinds: ['numbered'] })
    expect(onlyNumbers.every(b => b.kind === 'numbered')).toBe(true)
  })
})