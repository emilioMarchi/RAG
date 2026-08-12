import { describe, it, expect } from 'vitest'
import { StrategyDetector } from './strategyDetector.js'

const detector = new StrategyDetector()

const LEGAL_TEXT = [
  'ARTÍCULO 1. - La presente norma tiene por objeto regular el tratamiento de datos personales.',
  'ARTÍCULO 2. - Se entiende por tratamiento toda operación técnica de carácter automatizado que',
  'permita la recolección, evaluación, transporte o decisión respecto de datos personales.',
  'ARTÍCULO 3. - Inciso a) del párrafo anterior: quedan comprendidas las entidades públicas y privadas.',
  'Decreto N° 2743/2021 reglamenta la presente ley y sus disposiciones reglamentarias complementarias.',
  'Resolución 12/2022 establece los plazos de adecuación y sus disposiciones transitorias.',
  'En uso de las facultades conferidas por el artículo 99 inciso 3 de la Constitución Nacional.',
].join('\n')

const GENERIC_TEXT = [
  'Este informe describe la implementación del servicio de búsqueda híbrida.',
  'La API expone los siguientes endpoints con autenticación por tokens.',
  'El tiempo de respuesta promedio fue de 120 ms en el entorno de despliegue.',
  'Se instalaron los paquetes necesarios y se configuró la base de datos vectorial.',
  'Los resultados de la métrica de latencia se muestran en la figura 3 del anexo técnico.',
  'El proceso de carga se ejecuta en segundo plano y reporta el progreso por lotes.',
].join('\n')

describe('StrategyDetector', () => {
  it('detects legal text by content', () => {
    const r = detector.detect(LEGAL_TEXT)
    expect(r.strategy).toBe('legal')
    expect(r.score).toBeGreaterThanOrEqual(14)
  })

  it('detects generic text', () => {
    const r = detector.detect(GENERIC_TEXT)
    expect(r.strategy).toBe('generic')
    expect(r.score).toBeLessThan(14)
  })

  it('handles empty text as generic', () => {
    expect(detector.detect('').strategy).toBe('generic')
    expect(detector.detect('   \n  ').strategy).toBe('generic')
  })

  it('is case-insensitive', () => {
    expect(detector.detect(LEGAL_TEXT.toUpperCase()).strategy).toBe('legal')
  })
})