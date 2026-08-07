import fs from 'fs';
import path from 'path';

const HEADING_RE = /^#{1,6}\s/;
const MIN_PARAGRAPH_LENGTH = 20;

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

  splitIntoParagraphs(text: string): string[] {
    const rawParagraphs = text.split(/\n\s*\n/);
    return rawParagraphs
      .map(p => p.trim())
      .filter(p => p.length >= MIN_PARAGRAPH_LENGTH)
      .filter(p => !HEADING_RE.test(p));
  }

  generateSummary(text: string, maxChars: number = 500): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars).replace(/\s+\S*$/, '') + '...';
  }

  private async extractPDF(filePath: string): Promise<string> {
    // pdf-parse ESM exporta la función directamente en el namespace
    // Usamos un import con unknown para evitar el error TS2339 en strict mode
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParseModule = await import('pdf-parse') as any;
    const pdfParse: (buf: Buffer) => Promise<{ text: string }> =
      pdfParseModule.default ?? pdfParseModule;
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
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
