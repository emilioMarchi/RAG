import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import { query } from '../config/db.js';
import type { RAGSource } from '../services/ragEngine.js';

export interface ToolResult {
  content: string;
  sources?: RAGSource[];
  cragDecision?: string;
  iterations?: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  mime_type: string;
  created_at: string;
  paragraph_count: number;
}

export interface ToolConfig {
  topDocs?: number;
  topParagraphs?: number;
}

export class AgentTools {
  private iterativeRag: IterativeRAGEngine;
  private config: Required<ToolConfig>;

  constructor(iterativeRag: IterativeRAGEngine, config: ToolConfig = {}) {
    this.iterativeRag = iterativeRag;
    this.config = { topDocs: 5, topParagraphs: 10, ...config };
  }

  /**
   * Ejecuta la búsqueda de documentos utilizando el motor RAG iterativo.
   */
  async searchDocuments(query: string): Promise<ToolResult> {
    try {
      const result = await this.iterativeRag.query(
        query,
        this.config.topDocs,
        this.config.topParagraphs,
        0
      );

      return {
        content: result.answer,
        sources: result.sources,
        cragDecision: result.cragDecision,
        iterations: result.iterations,
      };
    } catch (error) {
      console.error('[AgentTools] Error en searchDocuments:', error);
      return {
        content: `Error al buscar documentos: ${error instanceof Error ? error.message : 'Error desconocido'}`,
      };
    }
  }

  /**
   * Lista todos los documentos disponibles en la base de datos.
   * No usa RAG; consulta directamente la tabla de documentos.
   */
  async listDocuments(): Promise<DocumentSummary[]> {
    try {
      const result = await query<DocumentSummary>(
        `SELECT d.id, d.title, d.mime_type, d.created_at,
                COUNT(p.id)::int AS paragraph_count
         FROM documents d
         LEFT JOIN document_paragraphs p ON p.document_id = d.id
         GROUP BY d.id
         ORDER BY d.created_at DESC`
      );
      return result.rows;
    } catch (error) {
      console.error('[AgentTools] Error en listDocuments:', error);
      return [];
    }
  }
}
