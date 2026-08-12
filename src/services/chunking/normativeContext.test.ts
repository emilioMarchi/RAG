import { describe, it, expect } from 'vitest'
import { normativeOutline, outlinePathAt, OutlineNode } from './normativeContext.js'

const LEY = [
  'LEY 27.541 - PRESUPUESTO.',
  'TITULO II - REGIMEN FISCAL.',
  'CAPITULO III - IMPOSICION.',
  'ARTICULO 14. - Se establece el regimen de la presente.',
  'Persona jurídica obligada al tributo.',
  'ARTICULO 15. - Facultades del Estado.',
  'Inciso a) delegación de facultades.',
  'Inciso b) plazos de prescripción.',
  'TITULO III - DISPOSICIONES FINALES.',
  'ARTICULO 30. - Vigencia.',
].join('\n')

function outline(): OutlineNode[] {
  return normativeOutline(LEY)
}

describe('normativeOutline', () => {
  it('detecta los nodos jerárquicos de alto nivel', () => {
    const no = outline()
    const levels = no.map(n => n.level)
    expect(levels).toContain('ley')
    expect(levels).toContain('titulo')
    expect(levels).toContain('capitulo')
    expect(levels).toContain('articulo')
    expect(levels).toContain('inciso')
    expect(no[0].label).toMatch(/^LEY 27\.541$/i)
  })

  it('respeta el orden de aparición por offset', () => {
    const no = outline()
    for (let i = 1; i < no.length; i++) expect(no[i].start).toBeGreaterThan(no[i - 1].start)
  })
})

describe('outlinePathAt', () => {
  it('dentro de un ARTICULO 14 devuelve la cadena de ancestros', () => {
    const no = outline()
    const artIdx = LEY.indexOf('ARTICULO 14.')
    const path = outlinePathAt(no, artIdx)
    expect(path).toContain('ARTICULO 14')
    expect(path.indexOf('TITULO II')).toBeLessThan(path.indexOf('CAPITULO III'))
  })

  it('un Inciso agrega al ARTICULO 15 sin perder el marco', () => {
    const no = outline()
    const incisoIdx = LEY.indexOf('Inciso b)')
    const path = outlinePathAt(no, incisoIdx)
    expect(path).toContain('ARTICULO 15')
    expect(path).toContain('INCISO B')
    // El marco de alto nivel sigue presente
    expect(path).toContain('CAPITULO III')
  })

  it('cambia de TITULO cuando entra el siguiente (artículo 30 bajo TITULO III)', () => {
    const no = outline()
    const art30 = LEY.indexOf('ARTICULO 30.')
    const path = outlinePathAt(no, art30)
    expect(path).toContain('TITULO III')
    expect(path).not.toContain('TITULO II >')
    expect(path).toContain('ARTICULO 30')
  })

  it('un offset dentro de un preámbulo (antes del primer nodo) devuelve cadena vacía', () => {
    const preamble = 'CONSIDERANDO que la presente norma se dicta en ejercicio de las facultades\n' + LEY
    const no = normativeOutline(preamble)
    const considerandoStart = 0
    expect(outlinePathAt(no, considerandoStart)).toBe('')
  })

  it('offset dentro de articulo pero sin inciso no agrega inciso', () => {
    const no = outline()
    const art15 = LEY.indexOf('ARTICULO 15.')
    const path = outlinePathAt(no, art15)
    expect(path).toContain('ARTICULO 15')
    expect(path).not.toContain('INCISO')
  })
})