/**
 * Fase 8 del Plan de Chunking Estructural — Evaluación empírica (harness local).
 *
 * Mide la calidad de la partición sin depender de DB/LLM: sobre un corpus legal,
 * compara configuraciones (fixed vs adaptativo) y estrategias (generic vs legal),
 * reportando:
 *   - nº de slices/chunks, largo promedio y máximo
 *   - adhesión a fronteras: distancia media entre el inicio de cada slice y la
 *     frontera detectada más cercana (0 = arranca exactamente en una frontera)
 *   - % de children con contextPath normativo (Fase 6, solo estrategia legal)
 *
 * Uso:  npm run eval:chunking   (tsx src/evaluateChunking.ts)
 */
import { ChunkingService } from './services/chunkingService.js';
import { detectBoundaries } from './services/chunking/boundaryDetector.js';
import {
  GenericChunkingStrategy,
  LegalNormChunkingStrategy,
  splitWithStrategy,
} from './services/chunkingStrategies.js';

const c = new ChunkingService();

const LEGAL_SAMPLE = [
  'LEY 27.541 - PRESUPUESTO GENERAL DE LA ADMINISTRACION NACIONAL.',
  'TITULO I - DISPOSICIONES GENERALES.',
  'ARTICULO 1. - Apruebase el presupuesto de gastos y recursos de la administración nacional.',
  'El presente título comprende las normas generales de ejecución del presupuesto vigente.',
  'ARTICULO 2. - Los organismos comprendidos deberán ajustar sus acciones a las previsiones.',
  'CAPITULO I - DE LA EJECUCION.',
  'ARTICULO 3. - La ejecución presupuestaria se regirá por el principio de legalidad.',
  'Inciso a) las erogaciones deberán contar con la partida correspondiente.',
  'Inciso b) los gastos se imputarán al ejercicio en que se devenguen.',
  'TITULO II - REGIMEN FISCAL.',
  'ARTICULO 14. - Facultase al Poder Ejecutivo a reasignar partidas con los límites previstos.',
  'El ejercicio de esta facultad no podrá modificar el total de los créditos vigentes.',
  'ARTICULO 15. - Las reasignaciones deberán publicarse en el boletín oficial.',
  'Inciso a) toda modificación será comunicada a la autoridad de aplicación.',
  'Inciso b) las normas reglamentarias establecerán los procedimientos de notificación.',
].join('\n\n');

function nearestBoundaryDistance(offset: number, boundaries: Array<{ start: number }>): number {
  let best = Infinity;
  for (const b of boundaries) best = Math.min(best, Math.abs(offset - b.start));
  return best === Infinity ? 0 : best;
}

function stats(slices: Array<{ text: string; start: number }>, boundaries: Array<{ start: number }>) {
  const lens = slices.map(s => s.text.length);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
  const max = Math.max(0, ...lens);
  const dists = slices.map(s => nearestBoundaryDistance(s.start, boundaries));
  const onBoundary = dists.filter(d => d <= 1).length;
  const meanDist = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 0;
  return {
    slices: slices.length,
    avg: Math.round(avg),
    max,
    meanBoundaryDist: Math.round(meanDist * 10) / 10,
    startOnBoundaryPct: slices.length ? Math.round((onBoundary / slices.length) * 100) : 0,
  };
}

const generic = new GenericChunkingStrategy();
const prepared = generic.prepare(LEGAL_SAMPLE);
const boundaries = detectBoundaries(prepared.text);

console.log('## Split estructural (splitStructural) sobre texto preparado');
console.log('Fronteras detectadas:', boundaries.length);
console.log('fixed(450):\t', JSON.stringify(stats(c.splitStructural(prepared.text, 450), boundaries)));
console.log(
  'adaptive:\t',
  JSON.stringify(stats(c.splitStructural(prepared.text, 450, { sizeFor: seg => (seg.text.length > 300 ? 250 : 650) }), boundaries))
);

console.log('\n## Estrategias (parent/child) con overlap 60');
for (const [name, strat] of [['generic', generic] as const, ['legal', new LegalNormChunkingStrategy()] as const]) {
  const r = splitWithStrategy(c, LEGAL_SAMPLE, strat as never, { overlapChars: 60 });
  const n = r.children.length;
  const lens = r.children.map(x => x.text.length);
  const withCtx = r.children.filter(ch => ch.contextPath).length;
  console.log(
    `${name}:\t` +
      JSON.stringify({
        parents: r.parents.length,
        children: n,
        avg: Math.round(lens.reduce((a, b) => a + b, 0) / Math.max(n, 1)),
        withContextPathPct: Math.round((withCtx / Math.max(n, 1)) * 100),
      })
  );
}