import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  private async extractPDF(filePath: string): Promise<string> {
    // pdf-parse v2 exporta la clase PDFParse (API ESM), no una función.
    const pdfParseModule = await import('pdf-parse') as any;
    const PDFParse = pdfParseModule.PDFParse;
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const result = await parser.getText();
      const text = result.text || '';

      // Vía rápida: si el PDF tiene capa de texto suficiente, se usa tal cual.
      if (text.replace(/\s/g, '').length >= MIN_OCR_TEXT_LENGTH) {
        return text;
      }

      // PDF escaneado (sin capa de texto): fallback con OCR local.
      if (!OCR_ENABLED) {
        return text;
      }
      return this.extractPDFWithOCR(filePath);
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private async extractPDFWithOCR(filePath: string): Promise<string> {
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

    try {
      let ocrText = '';
      let page = 0;
      for await (const image of document) {
        if (page >= OCR_MAX_PAGES) break;
        try {
          const { data } = await worker.recognize(image);
          ocrText += (data.text || '') + '\n\n';
        } catch (pageErr) {
          console.warn('[OCR] Fallo en página', page + 1, pageErr instanceof Error ? pageErr.message : pageErr);
        }
        page += 1;
      }
      await worker.terminate();
      return ocrText;
    } catch (err) {
      await worker.terminate().catch(() => undefined);
      throw err;
    }
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
}
