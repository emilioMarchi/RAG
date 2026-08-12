import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface PdfTextItemLike {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
  hasEOL?: boolean;
}

interface PdfPageLike {
  num: number;
  items?: PdfTextItemLike[];
  styles?: Record<string, unknown>;
  viewport: { width: number; height: number };
}

const getDocument = async (): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> =>
  import('pdfjs-dist/legacy/build/pdf.mjs');

const PAGE_SEP = '\n\n';

const HEADING_RE = /^#{1,6}\s/;
const MIN_PARAGRAPH_LENGTH = 20;
const PDF_MAX_FRAGMENT_CHARS = 1200;
const PDF_HEADING_RE = /^\d+(\.\d+)*[\.\):]?\s|\b[A-Z][A-Za-zÀ-ÿ0-9 ]{3,50}:$/;
const PDF_INDEX_LINE_RE = /^\d+(\.\d+)*[.)]?\s+[A-Za-zÀ-ÿ0-9].{0,140}$/;
const PDF_FOOTER_RE = /^-+\s*\d+\s+of\s+\d+\s*-+$/i;
const MIN_OCR_TEXT_LENGTH = 20;
const OCR_SCALE = 2;
const OCR_LANG = process.env.OCR_LANG || 'spa';
const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 60);
const OCR_ENABLED = process.env.OCR_ENABLED !== 'false';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TESSDATA_DIR = path.resolve(__dirname, '..', '..', 'tessdata');

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChunkLocation {
  /** Página (1-indexed) del documento PDF que contiene el fragmento */
  pageNumber?: number;
  startChar?: number;
  endChar?: number;
  startLine?: number;
  endLine?: number;
  boundingBoxes?: BoundingBox[];
}

/** Ítem de la capa de texto de un PDF con su caja delimitadora normalizada */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Página de un PDF con su texto y las posiciones de cada fragmento de texto */
export interface PdfPage {
  pageNumber: number;
  text: string;
  items: PdfTextItem[];
  ranges: Array<{ start: number; end: number; item: PdfTextItem }>;
}

export interface ChildChunk {
  text: string;
  /** Índice del chunk hijo dentro del documento */
  childIndex: number;
  /** Índice del parent chunk al que pertenece este hijo */
  parentIndex: number;
  /** Ubicación del fragmento dentro del documento original */
  location?: ChunkLocation;
}

export interface ParentChunk {
  text: string;
  /** Índice del parent chunk dentro del documento */
  parentIndex: number;
  /** Índice del primer child que pertenece a este parent */
  startChildIndex: number;
  /** Índice del último child que pertenece a este parent */
  endChildIndex: number;
}

export interface HierarchicalChunks {
  parents: ParentChunk[];
  children: ChildChunk[];
}

export class ChunkingService {
  async extractText(filePath: string, mimeType: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    if (mimeType === 'application/pdf' || ext === '.pdf') {
      return this.extractPDF(filePath);
    }
    if (mimeType.includes('word') || ext === '.docx') {
      return this.extractDOCX(filePath);
    }
    if (mimeType === 'text/plain' || ext === '.txt') {
      return this.extractTXT(filePath);
    }
    if (mimeType === 'text/markdown' || ext === '.md') {
      return this.extractTXT(filePath);
    }
    if (mimeType === 'application/xml' || mimeType === 'text/xml' || ext === '.xml') {
      return this.extractXML(filePath);
    }

    throw new Error(`Unsupported file type: ${mimeType} (${ext})`);
  }

  splitIntoParagraphs(text: string, mimeType: string = ''): string[] {
    if (this.isPDF(mimeType)) {
      return this.splitPDF(text);
    }
    const rawParagraphs = text.split(/\n\s*\n/);
    return rawParagraphs
      .map(p => p.trim())
      .filter(p => p.length >= MIN_PARAGRAPH_LENGTH)
      .filter(p => !HEADING_RE.test(p));
  }

  private isPDF(mimeType: string): boolean {
    return mimeType.toLowerCase().includes('pdf') || mimeType.toLowerCase().endsWith('.pdf');
  }

  /**
   * Fragmentación específica de PDF: divide por líneas y corta en encabezados
   * numerados o con tope de tamaño, descartando pies de página y el índice (TOC).
   * Evita que secciones enteras de página queden en un único fragmento enorme.
   */
  private splitPDF(text: string): string[] {
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !PDF_FOOTER_RE.test(l));

    const fragments: string[] = [];

    // Buscamos el bloque de índice: 2+ líneas de encabezado consecutivas que
    // contengan solo título (sin cuerpo). Marcar esas líneas para descartarlas.
    const skip = new Set<number>();
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i];
      const nxt = lines[i + 1];
      const curIsHeading = PDF_HEADING_RE.test(cur);
      const curIsIndexLine = PDF_INDEX_LINE_RE.test(cur);
      const nxtIsHeading = PDF_HEADING_RE.test(nxt);
      if (curIsHeading && curIsIndexLine && nxtIsHeading) {
        skip.add(i);
      }
    }

    let current: string[] = [];
    let currentLen = 0;
    let prevHeadingOnly = false;

    const flush = (dropIfHeadingOnly: boolean) => {
      const fragment = current.join('\n').trim();
      if (!dropIfHeadingOnly || !prevHeadingOnly) {
        if (fragment.length >= MIN_PARAGRAPH_LENGTH) fragments.push(fragment);
      }
      current = [];
      currentLen = 0;
      prevHeadingOnly = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (skip.has(i)) continue;

      const isHeading = PDF_HEADING_RE.test(line);
      const isSingleHeadingOnly = isHeading && PDF_INDEX_LINE_RE.test(line);
      const wouldOvershoot = currentLen + line.length > PDF_MAX_FRAGMENT_CHARS;

      if (current.length > 0 && (isHeading || wouldOvershoot)) {
        flush(false);
      }
      current.push(line);
      currentLen += line.length;
      prevHeadingOnly = isSingleHeadingOnly;
    }

    flush(false);
    return fragments;
  }

  generateSummary(text: string, maxChars: number = 500): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars).replace(/\s+\S*$/, '') + '...';
  }

  /** Devuelve el texto plano de un PDF (compatible con el resto del pipeline). */
  private async extractPDF(filePath: string): Promise<string> {
    const pages = await this.extractPDFPages(filePath);
    return this.buildFlatText(pages);
  }

  /**
   * Extrae cada página de un PDF con su texto y, cuando hay capa de texto, las
   * posiciones (bounding boxes normalizados). Las páginas se devuelven para que
   * el chunking pueda asignar pageNumber y boundingBoxes a cada fragmento.
   */
  async extractPDFPages(filePath: string): Promise<PdfPage[]> {
    const pdfjs = await getDocument();
    const data = new Uint8Array(fs.readFileSync(filePath));
    const loadingTask = (pdfjs.getDocument as any)({ data, disableWorker: true, useSystemFonts: true });
    const doc = await loadingTask.promise as {
      numPages: number;
      getPage: (n: number) => Promise<
        PdfPageLike & { getViewport: (o: { scale: number }) => { width: number; height: number } } & {
          getTextContent: () => Promise<PdfPageLike>;
        }
      >;
    };

    const pages: PdfPage[] = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        pages.push(this.buildPage(n, textContent as unknown as PdfPageLike, vp));
      }
    } finally {
      await (loadingTask.destroy ? loadingTask.destroy() : Promise.resolve()).catch(() => undefined);
    }

    const totalTextLen = this.buildFlatText(pages).replace(/\s/g, '').length;

    // PDF escaneado (sin capa de texto suficiente): fallback con OCR local.
    if (totalTextLen < MIN_OCR_TEXT_LENGTH) {
      if (!OCR_ENABLED) return pages;
      return this.extractPDFPagesWithOCR(filePath);
    }
    return pages;
  }

  private buildPage(pageNumber: number, tc: PdfPageLike, vp: { width: number; height: number }): PdfPage {
    const items: PdfTextItem[] = [];
    const ranges: PdfPage['ranges'] = [];
    let pageText = '';

    for (const raw of tc.items ?? []) {
      const str = typeof raw.str === 'string' ? raw.str : '';
      const transform = raw.transform ?? [1, 0, 0, 1, 0, 0];
      const w = vp.width > 0 ? vp.width : 1;
      const h = vp.height > 0 ? vp.height : 1;

      const x = (transform[4] ?? 0) / w;
      const height = (raw.height ?? 0) / h;
      const y = h > 0 ? (h - (transform[5] ?? 0) - height) / h : 0;
      const width = (raw.width ?? 0) / w;

      const item: PdfTextItem = { str, x, y, width, height };

      const start = pageText.length;
      pageText += str;

      if (str.length > 0) {
        ranges.push({ start, end: start + str.length, item });
      }
      if (raw.hasEOL) {
        pageText += '\n';
      }
    }

    return { pageNumber, text: pageText, items, ranges };
  }

  /** Concatena las páginas en un único texto plano (mismo separador usado por el chunking). */
  buildFlatText(pages: PdfPage[]): string {
    return pages.map(p => p.text.trimEnd()).join(PAGE_SEP);
  }

  private async extractPDFPagesWithOCR(filePath: string): Promise<PdfPage[]> {
    const { pdf } = await import('pdf-to-img');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Tesseract = await import('tesseract.js') as any;

    const document = await pdf(filePath, { scale: OCR_SCALE });
    if (!fs.existsSync(TESSDATA_DIR)) {
      fs.mkdirSync(TESSDATA_DIR, { recursive: true });
    }

    const worker = await Tesseract.createWorker(OCR_LANG, undefined, {
      langPath: TESSDATA_DIR,
      gzip: true,
      logger: () => {},
    });

    const pages: PdfPage[] = [];
    try {
      let page = 0;
      for await (const image of document) {
        page += 1;
        if (page > OCR_MAX_PAGES) break;
        try {
          const { data } = await worker.recognize(image);
          const text = (data.text || '').trim();
          pages.push({ pageNumber: page, text, items: [], ranges: [] });
        } catch (pageErr) {
          console.warn('[OCR] Fallo en página', page, pageErr instanceof Error ? pageErr.message : pageErr);
        }
      }
      await worker.terminate();
    } catch (err) {
      await worker.terminate().catch(() => undefined);
      throw err;
    }
    return pages;
  }

  private async extractDOCX(filePath: string): Promise<string> {
    const mammoth = await import('mammoth');
    const dataBuffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    return result.value;
  }

  private async extractTXT(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Extrae el texto de un documento XML: elimina comentarios, CDATA, doctype y
   * las etiquetas, conservando el contenido textual como párrafos.
   */
  private async extractXML(filePath: string): Promise<string> {
    const raw = fs.readFileSync(filePath, 'utf-8')
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

    return raw
      .split(/>\s*</)
      .map(seg => seg.replace(/<\/?[^>]+>/g, '').trim())
      .filter(seg => seg.length > 0)
      .join('\n');
  }

  /**
   * Divide el texto en una estructura jerárquica Parent-Child:
   * - Parent chunks: bloques de 1200-2000 chars (contexto completo para el LLM)
   * - Child chunks: sub-fragmentos de 300-500 chars por parent (optimizados para embedding)
   *
   * La relación parent→child se registra mediante índices para facilitar el almacenamiento.
   */
  splitHierarchical(
    text: string,
    mimeType: string = '',
    options: { parentMaxChars?: number; childMaxChars?: number; childMinChars?: number; pages?: PdfPage[] } = {}
  ): HierarchicalChunks {
    const { parentMaxChars = 1800, childMaxChars = 450, childMinChars = 80, pages } = options;
    const lineIndex = this.buildLineIndex(text);

    // 1. Obtener parent chunks: bloques grandes (con offsets sobre `text`)
    const parentSlices = this.splitSlices(text, parentMaxChars, mimeType);

    const parents: ParentChunk[] = [];
    const children: ChildChunk[] = [];
    let globalChildIndex = 0;

    parentSlices.forEach((parentSlice, parentIndex) => {
      const startChildIndex = globalChildIndex;

      // 2. Dividir cada parent en children más pequeños
      const childSlices = this.splitSlices(parentSlice.text, childMaxChars)
        .filter(s => s.text.length >= childMinChars);

      for (const childSlice of childSlices) {
        const cStart = parentSlice.start + childSlice.start;
        const cEnd = cStart + childSlice.text.length;
        children.push({
          text: childSlice.text,
          childIndex: globalChildIndex,
          parentIndex,
          location: this.computeLocation(text, cStart, cEnd, lineIndex, pages),
        });
        globalChildIndex++;
      }

      const endChildIndex = globalChildIndex - 1;

      parents.push({
        text: parentSlice.text,
        parentIndex,
        startChildIndex,
        endChildIndex: endChildIndex >= startChildIndex ? endChildIndex : startChildIndex,
      });
    });

    return { parents, children };
  }

  private computeLocation(
    text: string,
    start: number,
    end: number,
    lineIndex: number[],
    pages?: PdfPage[]
  ): ChunkLocation {
    const clamp = (v: number) => Math.max(0, Math.min(text.length, v));
    const s = clamp(start);
    const e = clamp(end);

    const loc: ChunkLocation = { startChar: s, endChar: e };
    loc.startLine = this.lineForOffset(lineIndex, s);
    loc.endLine = this.lineForOffset(lineIndex, e);

    if (pages && pages.length > 0) {
      const found = this.locateInPages(pages, text.slice(s, e));
      if (found) {
        loc.pageNumber = found.pageNumber;
        if (found.boundingBoxes) loc.boundingBoxes = found.boundingBoxes;
      }
    }
    return loc;
  }

  /**
   * Recalcula la ubicación de un fragmento CONTRA EL TEXTO ORIGINAL (no el preparado).
   * Recibe los offsets del fragmento en el texto preparado y el mapa que los traduce
   * a offsets del texto original (producido por la estrategia). Así los números de
   * línea / página / caja quedan siempre referidos al archivo que ve el usuario.
   */
  public locateOnOriginal(
    originalText: string,
    pages: PdfPage[] | undefined,
    preparedStart: number,
    preparedEnd: number,
    offsetMap: (i: number) => number
  ): ChunkLocation {
    const clamp = (v: number) => Math.max(0, Math.min(originalText.length, v));
    const origStart = clamp(offsetMap(preparedStart));
    const origEnd = clamp(offsetMap(preparedEnd));

    const loc: ChunkLocation = { startChar: origStart, endChar: origEnd };
    const lineIndex = this.buildLineIndex(originalText);
    loc.startLine = this.lineForOffset(lineIndex, origStart);
    loc.endLine = this.lineForOffset(lineIndex, origEnd);

    if (pages && pages.length > 0) {
      const needle = originalText.slice(origStart, origEnd);
      const found = this.locateInPages(pages, needle);
      if (found) {
        loc.pageNumber = found.pageNumber;
        if (found.boundingBoxes) loc.boundingBoxes = found.boundingBoxes;
      }
    }
    return loc;
  }

  private buildLineIndex(text: string): number[] {
    const lines = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines.push(i + 1); // 0x0A '\n'
    }
    return lines;
  }

  private lineForOffset(lines: number[], offset: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-indexed
  }

  private locateInPages(
    pages: PdfPage[],
    raw: string
  ): { pageNumber: number; boundingBoxes?: BoundingBox[] } | undefined {
    const needle = raw.trim();
    if (!needle) return pages.length > 0 ? { pageNumber: pages[0].pageNumber } : undefined;

    for (const page of pages) {
      const idx = page.text.indexOf(needle);
      if (idx >= 0) {
        const boxes = this.unionRanges(page.ranges, idx, idx + needle.length);
        return { pageNumber: page.pageNumber, boundingBoxes: boxes };
      }
      // Intento insensible a espacios/distribución de líneas (muy común cuando la
      // estrategia limpió el texto: saltos de línea y espaciados difieren del PDF).
      const norm = this.findNormalized(page.text, needle);
      if (norm) {
        const boxes = this.unionRanges(page.ranges, norm.start, norm.end);
        return { pageNumber: page.pageNumber, boundingBoxes: boxes };
      }
    }

    const firstLine = needle.split('\n')[0].trim();
    if (firstLine) {
      for (const page of pages) {
        if (page.text.includes(firstLine)) return { pageNumber: page.pageNumber };
      }
    }
    return pages.length > 0 ? { pageNumber: pages[0].pageNumber } : undefined;
  }

  /** Busca `needle` en `haystack` ignorando el espacio en blanco, devolviendo los
   *  índices originales (en `haystack`) del rango encontrado. */
  private findNormalized(haystack: string, needle: string): { start: number; end: number } | null {
    const hIdx: number[] = [];
    let h = '';
    for (let i = 0; i < haystack.length; i++) {
      if (!/\s/.test(haystack[i])) {
        h += haystack[i];
        hIdx.push(i);
      }
    }
    const n = needle.replace(/\s+/g, '');
    if (!n) return null;
    const pos = h.indexOf(n);
    if (pos < 0) return null;
    const start = hIdx[pos] ?? 0;
    const end = (hIdx[pos + n.length] ?? hIdx[hIdx.length - 1]) + 1;
    return { start, end };
  }

  private unionRanges(ranges: PdfPage['ranges'], localStart: number, localEnd: number): BoundingBox[] | undefined {
    // Agrupar los items del fragmento en filas (líneas) por solape vertical, de modo
    // que el resaltado abrace cada línea de texto en lugar de un único rectángulo grande.
    const matched = ranges
      .filter(r => r.start < localEnd && r.end > localStart)
      .map(r => r.item)
      .sort((a, b) => a.y - b.y || a.x - b.x);

    if (matched.length === 0) return undefined;

    const OVERLAP = 0.4;
    const rows: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
    for (const it of matched) {
      const top = it.y;
      const bottom = it.y + it.height;
      const row = rows.find(r => {
        const overlap = Math.min(bottom, r.maxY) - Math.max(top, r.minY);
        const minH = Math.min(bottom - top, r.maxY - r.minY);
        return minH > 0 && overlap / minH > OVERLAP;
      });
      if (row) {
        row.minX = Math.min(row.minX, it.x);
        row.minY = Math.min(row.minY, it.y);
        row.maxX = Math.max(row.maxX, it.x + it.width);
        row.maxY = Math.max(row.maxY, it.y + it.height);
      } else {
        rows.push({ minX: it.x, minY: it.y, maxX: it.x + it.width, maxY: it.y + it.height });
      }
    }

    rows.sort((a, b) => a.minY - b.minY);
    return rows.map(r => ({ x: r.minX, y: r.minY, width: r.maxX - r.minX, height: r.maxY - r.minY }));
  }

  /**
   * Divide texto en fragmentos de tamaño máximo `maxChars` preservando los
   * offsets sobre el texto de entrada. Devuelve los fragmentos como sub-rebanadas.
   */
  private splitSlices(
    text: string,
    maxChars: number,
    mimeType?: string
  ): Array<{ text: string; start: number }> {
    if (mimeType && this.isPDF(mimeType)) {
      // Para PDFs usamos el splitter especializado (los offsets son aproximados;
      // la ubicación precisa se resuelve luego contra las páginas por contenido).
      const pdfFragments = this.splitPDF(text);
      const slices: Array<{ text: string; start: number }> = [];
      let offset = 0;
      const block = this.groupBlocks(pdfFragments.map(f => ({ text: f, start: 0, end: f.length })), maxChars);
      for (const b of block) {
        slices.push({ text: b.text, start: offset });
        offset += b.text.length + PAGE_SEP.length;
      }
      return slices;
    }

    const blocks = this.splitByBlankLines(text);
    return this.groupBlocks(blocks, maxChars);
  }

  /** Divide por líneas en blanco devolviendo párrafos junto a sus offsets originales. */
  private splitByBlankLines(text: string): Array<{ text: string; start: number; end: number }> {
    const out: Array<{ text: string; start: number; end: number }> = [];
    const re = /\n[ \t]*\n+/g;
    let segStart = 0;
    let m: RegExpExecArray | null;

    const push = (start: number, end: number) => {
      const seg = text.slice(start, end);
      const trimmed = seg.replace(/[ \t]+\n?$/, '').trimEnd();
      if (trimmed.length > 0) out.push({ text: trimmed, start, end: start + trimmed.length });
    };

    while ((m = re.exec(text))) {
      push(segStart, m.index);
      segStart = re.lastIndex;
    }
    push(segStart, text.length);
    return out;
  }

  /**
   * Divide un bloque excesivamente largo en trozos de hasta `maxChars` sin partir
   * palabras ni frases: corta primero en el último salto de línea, luego en el
   * último final de frase y, si la línea es muy larga, en el último espacio.
   */
  private sliceOversized(text: string, maxChars: number): Array<{ text: string; start: number; end: number }> {
    const out: Array<{ text: string; start: number; end: number }> = [];
    let start = 0;

    const cutPoint = (from: number, limit: number): number => {
      if (limit >= text.length) return text.length;
      const windowText = text.slice(from, limit);

      let idx = windowText.lastIndexOf('\n');
      if (idx > 0) return from + idx;

      idx = windowText.search(/[.;:!?](?:\s|$)/g);
      if (idx >= 0) return from + idx + 1;

      idx = windowText.lastIndexOf(' ');
      if (idx > 0) return from + idx;

      return limit;
    };

    while (start < text.length) {
      let end = cutPoint(start, start + maxChars);
      if (end <= start) end = Math.min(start + maxChars, text.length);
      const segment = text.slice(start, end).trim();
      if (segment.length > 0) out.push({ text: segment, start, end });
      start = end;
    }
    return out;
  }

  /** Agrupa párrafos en bloques de hasta `maxChars`, con offsets (start/end) del texto original. */
  private groupBlocks(
    blocks: Array<{ text: string; start: number; end: number }>,
    maxChars: number
  ): Array<{ text: string; start: number; end: number }> {
    const groups: Array<{ text: string; start: number; end: number }> = [];
    let current: Array<{ text: string; start: number; end: number }> = [];
    let currentLen = 0;

    const flush = () => {
      if (current.length === 0) return;
      const text = current.map(b => b.text).join(PAGE_SEP);
      groups.push({ text, start: current[0].start, end: current[current.length - 1].end });
      current = [];
      currentLen = 0;
    };

    for (const b of blocks) {
      const sepLen = current.length > 0 ? PAGE_SEP.length : 0;
      if (current.length > 0 && currentLen + sepLen + b.text.length > maxChars) flush();

      if (b.text.length > maxChars) {
        flush();
        const pieces = this.sliceOversized(b.text, maxChars);
        for (const piece of pieces) {
          groups.push({ text: piece.text, start: b.start + piece.start, end: b.start + piece.end });
        }
        continue;
      }

      current.push(b);
      currentLen += currentLen === 0 ? b.text.length : sepLen + b.text.length;
    }
    flush();
    return groups;
  }
}
