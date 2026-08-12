/**
 * Fase 6 del Plan de Chunking Estructural — Contexto normativo (AST corto).
 *
 * Los documentos legales son árboles Título → Capítulo → Sección → Artículo → Inciso,
 * pero el detector de fronteras produce límites planos. Este módulo reconstruye un
 * "outline" jerárquico a partir de las líneas de una norma y, dado un offset, devuelve
 * la cadena de ancestros abierta (p. ej. `LEY 27.541 > TITULO II > ARTICULO 14`) para
 * anteponerla como header sintético al enriquecer cada chunk.
 *
 * Corre sobre el texto PREPARADO de la estrategia (misma base que detectBoundaries).
 */

export type NormativeLevel =
  | 'ley'
  | 'decreto'
  | 'titulo'
  | 'capitulo'
  | 'seccion'
  | 'articulo'
  | 'inciso';

export interface OutlineNode {
  level: NormativeLevel;
  /** Offset de inicio de la línea que abre el nodo (en el texto de entrada). */
  start: number;
  /** Etiqueta descriptiva, p. ej. "ARTICULO 14". */
  label: string;
}

/** Menor número = mayor jerarquía (ley > decreto > titulo > ... > inciso). */
const LEVEL_RANK: Record<NormativeLevel, number> = {
  ley: 1,
  decreto: 2,
  titulo: 3,
  capitulo: 4,
  seccion: 5,
  articulo: 6,
  inciso: 7,
};

const LEVEL_PARSERS: Array<{ level: NormativeLevel; re: RegExp }> = [
  { level: 'ley', re: /^(?:LEY|DECRETO-LEY)\s+(?:N[°º]\.?\s*)?([0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)/i },
  { level: 'decreto', re: /^DECRETO\s+(?:N[°º]\.?\s*)?(\d+(?:\.\d+)*|[IVXLCDM]+)/i },
  { level: 'titulo', re: /^T[IÍ]TULO\s+([IVXLCDM]+|\d+)/i },
  { level: 'capitulo', re: /^(?:CAP[IÍ]TULO|CAP\.)\s+([IVXLCDM]+|\d+)/i },
  { level: 'seccion', re: /^SECCI[OÓ]N\s+([IVXLCDM]+|\d+)/i },
  { level: 'articulo', re: /^ART(?:[IÍ]CULO|ICULO)?\.?\s+(\d+)/i },
  { level: 'inciso', re: /^(?:Inciso|NUMERAL|INCISO)\s+([a-zA-Z0-9]+)/i },
];

/** Construye el outline jerárquico ordenado por offset de inicio. */
export function normativeOutline(text: string): OutlineNode[] {
  const textSafe = text || '';
  const nodes: OutlineNode[] = [];
  let idx = 0;
  for (const line of textSafe.split('\n')) {
    for (const p of LEVEL_PARSERS) {
      const m = line.match(p.re);
      if (m) {
        const num = (m[1] ?? '').toUpperCase();
        nodes.push({
          level: p.level,
          start: idx,
          label: `${p.level.toUpperCase()} ${num}`.trim(),
        });
        break;
      }
    }
    idx += line.length + 1;
  }
  return nodes.sort((a, b) => a.start - b.start);
}

/**
 * Devuelve la cadena de ancestros abierta en un offset, uniendo las etiquetas
 * desde el nivel más alto al más bajo. Un nodo nuevo de nivel R limpia de la pila
 * cualquier nodo más profundo o del mismo nivel (R >= actual), de modo que un
 * ARTICULO reemplaza al anterior y se mantienen TITULO/CAPITULO/SECCION abiertos.
 */
export function outlinePathAt(nodes: OutlineNode[], offset: number): string {
  const stack: Array<{ rank: number; label: string }> = [];
  for (const n of nodes) {
    if (n.start > offset) break;
    const rank = LEVEL_RANK[n.level];
    while (stack.length && stack[stack.length - 1].rank >= rank) stack.pop();
    stack.push({ rank, label: n.label });
  }
  return stack.map(s => s.label).join(' > ');
}