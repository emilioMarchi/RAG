import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { R2StorageService } from './r2Service.js';
import { getClient } from '../config/db.js';
import { mapConcurrent } from '../utils/concurrency.js';

interface EnrichmentResult {
  contextualized_text: string;
  keywords: string[];
  category: string;
  highVector: number[];
}

export class IngestionPipeline {
  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService,
    private storage: R2StorageService
  ) {}

  async processAndStoreDocument(params: {
    title: string;
    fileBuffer: Buffer;
    fileName: string;
    mimeType: string;
    fullContentText: string;
    paragraphs: string[];
  }) {
    const { title, fileBuffer, fileName, mimeType, fullContentText, paragraphs } = params;

    const client = await getClient();

    try {
      await client.query('BEGIN');

      const uploadResult = await this.storage.uploadFile(fileBuffer, fileName, mimeType);

      const baseVector = await this.embedder.generateEmbedding(fullContentText, 768);

      const docRes = await client.query(
        `INSERT INTO documents (title, content, r2_key, r2_url, mime_type, embedding_base)
         VALUES ($1, $2, $3, $4, $5, $6::vector) RETURNING id`,
        [title, fullContentText, uploadResult.r2Key, uploadResult.publicUrl, mimeType, JSON.stringify(baseVector)]
      );
      const docId = docRes.rows[0].id;
      const docSummary = this.generateDocSummary(fullContentText);

      const enrichedParagraphs = await mapConcurrent(
        paragraphs,
        async (rawText, i) => {
          const enriched = await this.llm.enrichChunk(title, docSummary, rawText);
          const ctxText = enriched.contextualized_text || rawText;
          const highVector = await this.embedder.generateEmbedding(ctxText, 1536);
          return {
            contextualized_text: ctxText,
            keywords: enriched.keywords || [],
            category: enriched.category || 'general',
            highVector,
            index: i,
            rawText,
          };
        },
        5
      );

      for (const ep of enrichedParagraphs) {
        await client.query(
          `INSERT INTO document_paragraphs
           (document_id, paragraph_index, raw_content, contextualized_text, metadata, embedding_high)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)`,
          [
            docId,
            ep.index,
            ep.rawText,
            ep.contextualized_text,
            JSON.stringify({ keywords: ep.keywords, category: ep.category }),
            JSON.stringify(ep.highVector),
          ]
        );
      }

      await client.query('COMMIT');

      return {
        docId,
        r2Key: uploadResult.r2Key,
        paragraphsProcessed: paragraphs.length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private generateDocSummary(text: string, maxChars: number = 500): string {
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars).replace(/\s+\S*$/, '') + '...';
  }
}
