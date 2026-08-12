export type DetectedStrategy = 'legal' | 'generic'

export interface StrategyDetectionResult {
  strategy: DetectedStrategy
  score: number
  reasons: string[]
}

/** Términos léxicos con fuerte señal de texto normativo/legal (español). */
const LEGAL_LEXICAL = [
  'artículo', 'inciso', 'cláusula', 'decreto', 'reglamento', 'ordenanza',
  'resolución', 'disposición', 'norma', 'promulga', 'considerando', 'derog',
  'sancion', 'reglamentaria', 'tribunal', 'jurisdicc', 'legislativ', 'facultades',
  'ministerio', 'alinea', 'numeral', 'promulga',
]

/** Locuciones de varias palabras que pesan más y se cuentan como 1. */
const MULTIWORD: Array<[string, string]> = [
  ['disposiciones transitorias', 'disposiciones transitorias'],
  ['en uso de las facultades', 'uso de las facultades'],
  ['disposiciones reglamentarias', 'disposiciones reglamentarias'],
]

/** Líneas con estructura de articulación legal: "1)", "IV.", "ARTICULO 2°". */
const NUM_LINE_RE = /^\s*(?:\d{1,3}[.)]|[ivxlcdmIVXLCDM]+[.)]|art(?:ículo|iculo)?\.?\s*\d+)/i

const LEX_WEIGHT = 5
const STRUCT_WEIGHT = 30
const LEGAL_THRESHOLD = 14

/**
 * Detecta por contenido (heurística pura, sin LLM) si un texto es normativo/legal.
 * Puntúa señales léxicas y estructurales; por encima del umbral se clasifica legal.
 */
export class StrategyDetector {
  detect(text: string): StrategyDetectionResult {
    const sample = (text || '').toLowerCase()
    const reasons: string[] = []
    const chars = sample.replace(/\s+/g, '').length
    if (!chars) return { strategy: 'generic', score: 0, reasons }

    let hits = 0
    for (const kw of LEGAL_LEXICAL) {
      const matches = sample.match(new RegExp(`\\b${kw}`, 'g'))
      if (matches?.length) {
        hits += matches.length
        reasons.push(`${kw}×${matches.length}`)
      }
    }
    for (const [phrase, key] of MULTIWORD) {
      if (sample.includes(phrase)) {
        hits += 3
        reasons.push(`${key}×1`)
      }
    }

    const lexical = (hits * LEX_WEIGHT) / Math.max(chars / 1000, 1)

    const lines = sample.split('\n').filter(l => l.trim().length > 0)
    const structLines = lines.filter(l => NUM_LINE_RE.test(l)).length
    const structRatio = lines.length ? structLines / lines.length : 0
    const structural = structRatio * STRUCT_WEIGHT
    if (structLines) reasons.push(`líneas numeradas ${structLines}/${lines.length}`)

    const score = Math.round((lexical + structural) * 100) / 100
    const strategy: DetectedStrategy = score >= LEGAL_THRESHOLD ? 'legal' : 'generic'
    return { strategy, score, reasons }
  }
}