import { EmbeddingService } from './embeddingService.js';
import { LLMService } from './llmService.js';
import { query } from '../config/db.js';

export interface RAGSource {
  doc_title: string;
  raw_content: string;
  contextualized_text: string;
  r2_key: string;
  r2_url: string | null;
  document_id?: string;
  paragraph_index?: number;
}

export interface RAGResult {
  answer: string;
  sources: RAGSource[];
}

export class HierarchicalRAGModule {
  constructor(
    private embedder: EmbeddingService,
    private llm: LLMService
  ) {}

  async query(userQuery: string, topDocs = 5, topParagraphs = 3): Promise<RAGResult> {
    const baseQueryVector = await this.embedder.generateEmbedding(userQuery, 768);

    const candidateDocsRes = await query<{ id: string; title: string }>(
      `SELECT id, title FROM documents
       ORDER BY embedding_base <=> $1::vector LIMIT $2`,
      [JSON.stringify(baseQueryVector), topDocs]
    );

    const candidateIds = candidateDocsRes.rows.map((row) => row.id);
    if (candidateIds.length === 0) {
      return { answer: 'No se encontraron documentos relacionados con tu consulta.', sources: [] };
    }

    const highQueryVector = await this.embedder.generateEmbedding(userQuery, 1536);

    const paragraphsRes = await query<RAGSource>(
      `SELECT p.raw_content, p.contextualized_text, d.title as doc_title, d.r2_key, d.r2_url
       FROM document_paragraphs p
       JOIN documents d ON p.document_id = d.id
       WHERE p.document_id = ANY($1::uuid[])
       ORDER BY p.embedding_high <=> $2::vector LIMIT $3`,
      [candidateIds, JSON.stringify(highQueryVector), topParagraphs]
    );

    const retrievedParagraphs = paragraphsRes.rows;

    const contextText = retrievedParagraphs
      .map((p, i) => `[Fuente ${i + 1} - ${p.doc_title}]:\n${p.contextualized_text}`)
      .join('\n\n');

    const answer = await this.llm.generateRAGAnswer(userQuery, contextText);

    return {
      answer,
      sources: retrievedParagraphs,
    };
  }
}
