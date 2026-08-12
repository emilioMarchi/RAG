/**
 * Fase 1 del Plan de Chunking Estructural — Detector de fronteras (boundary detection).
 * Módulo aislado y sin estado que, sobre un texto (el PREPARADO por la estrategia),
 * devuelve la lista ordenada de fronteras estructurales (offsets) donde un chunk
 * puede partir "en frente" en vez de a tope de caracteres.
 *
 * Reutiliza las señales ya existentes:
 *   - NUMERIC_LINE_RE  → numeración legal (espejo de strategyDetector.ts:25)
 *   - PDF_HEADING_RE   → encabezados numerados/títulos (espejo de chunkingService.ts:28)
 *   - párrafos (\n\n)  → splitByBlankLines (chunkingService.ts:599)
 *
 * No ejecuta sobre el texto ORIGINAL: debe correr sobre el texto preparado y luego
 * `locateOnOriginal` traducirá los offsets al archivo real (ver plan §5.1).
 */

export type BoundaryKind = 'heading' | 'numbered' | 'paragraph' | 'list' | 'page';

export interface BoundaryMatch {
  /** Offset (en el texto preparado) donde comienza la frontera */
  start: number;
  /** Offset donde termina la línea/fragmento que la inicia */
  end: number;
  kind: BoundaryKind;
  /** Texto descriptivo corto (p. ej. "ARTÍCULO 5°") para debugging/UI */
  label?: string;
}

const HEADING_RE = /^#{1,6}\s+/;
const PDF_HEADING_RE = /^\d+(\.\d+)*[\.\):]?\s|\b[A-Z][A-Za-zÀ-ÿ0-9 ]{3,50}:$/;
const NUMERIC_LINE_RE = /^\s*(?:\d{1,4}[.)]|[ivxlcdmIVXLCDM]+[.)]|art(?:ículo|iculo)?\.?\s*\d+)/i;
const LIST_LINE_RE = /^\s*(?:[-*•·])\s+/;
const PAGE_BREAK = '\f';

/** Especificidad para deduplicar varias fronteras en el mismo offset. */
const KIND_RANK: Record<BoundaryKind, number> = {
  numbered: 5,
  heading: 4,
  list: 3,
  paragraph: 2,
  page: 1,
};

export interface BoundaryOptions {
  /** Tipos de frontera a detectar (default: todos). */
  kinds?: BoundaryKind[];
}

export function detectBoundaries(text: string, opts: BoundaryOptions = {}): BoundaryMatch[] {
  const allow = new Set<BoundaryKind>(opts.kinds ?? ['heading', 'numbered', 'paragraph', 'list', 'page']);

  const boundaries: BoundaryMatch[] = [];
  const push = (m: BoundaryMatch) => {
    if (allow.has(m.kind)) boundaries.push(m);
  };

  // 1. Fronteras de párrafo: inicio de cada bloque separado por \n\n.
  if (allow.has('paragraph')) {
    for (const p of paragraphStarts(text)) {
      push({ start: p.start, end: p.end, kind: 'paragraph', label: p.label });
    }
  }

  // 2. Fronteras de página conservadas como form-feed (\f) si el extractor las deja.
  if (allow.has('page')) {
    let idx = text.indexOf(PAGE_BREAK);
    while (idx >= 0) {
      push({ start: idx + 1, end: idx + 1, kind: 'page', label: 'página' });
      idx = text.indexOf(PAGE_BREAK, idx + 1);
    }
  }

  // 3. Líneas estructurales: encabezado, numeración legal, ítems de lista.
  for (const ls of lineStarts(text)) {
    const line = text.slice(ls.offset, ls.endOffset);
    const trimmed = line.trim();
    if (!trimmed) continue;

    const label = trimmed.slice(0, 48);
    // Numeración legal primero: líneas como "1." o "ARTÍCULO 5°" también podrían
    // casar con PDF_HEADING_RE (`^\d+...\s`); queremos la categoría más específica.
    if (NUMERIC_LINE_RE.test(line)) {
      push({ start: ls.offset, end: ls.endOffset, kind: 'numbered', label });
    } else if (HEADING_RE.test(line) || PDF_HEADING_RE.test(line)) {
      push({ start: ls.offset, end: ls.endOffset, kind: 'heading', label });
    } else if (LIST_LINE_RE.test(line)) {
      push({ start: ls.offset, end: ls.endOffset, kind: 'list', label });
    }
  }

  return sortAndDedupe(boundaries);
}

/** Inicios de párrafo (bloques separados por líneas en blanco) con sus offsets. */
function paragraphStarts(text: string): Array<{ start: number; end: number; label?: string }> {
  const out: Array<{ start: number; end: number; label?: string }> = [];
  const re = /\n[ \t]*\n+/g;

  const pushAt = (s: number) => {
    let idx = s;
    while (idx < text.length && /\s/.test(text[idx])) idx++;
    if (idx < text.length) {
      out.push({ start: idx, end: idx, label: text.slice(idx, idx + 48) });
    }
  };

  pushAt(0);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    pushAt(re.lastIndex);
  }
  return out;
}

/** Stacks de cada línea (offset de inicio y de fin) sin parsear contenido. */
function lineStarts(text: string): Array<{ offset: number; endOffset: number }> {
  const out: Array<{ offset: number; endOffset: number }> = [];
  let offset = 0;
  while (offset < text.length) {
    const nl = text.indexOf('\n', offset);
    const endOffset = nl < 0 ? text.length : nl;
    out.push({ offset, endOffset });
    if (nl < 0) break;
    offset = nl + 1;
  }
  return out;
}

/** Ordena por offset y, ante la misma posición, conserva la categoría más específica. */
function sortAndDedupe(matches: BoundaryMatch[]): BoundaryMatch[] {
  matches.sort((a, b) => a.start - b.start || KIND_RANK[b.kind] - KIND_RANK[a.kind]);
  const out: BoundaryMatch[] = [];
  for (const m of matches) {
    const last = out[out.length - 1];
    if (last && last.start === m.start) {
      if (KIND_RANK[m.kind] > KIND_RANK[last.kind]) out[out.length - 1] = m;
    } else {
      out.push(m);
    }
  }
  return out;
}