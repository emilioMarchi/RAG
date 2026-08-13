import { IterativeRAGEngine } from '../services/iterativeRAGEngine.js';
import type { RAGSource } from '../services/ragEngine.js';

export interface ToolResult {
  content: string;
  sources?: RAGSource[];
  cragDecision?: string;
  iterations?: number;
}

export class AgentTools {
  private iterativeRag: IterativeRAGEngine;

  constructor(iterativeRag: IterativeRAGEngine) {
    this.iterativeRag = iterativeRag;
  }

  /**
   * Ejecuta la búsqueda de documentos utilizando el motor RAG iterativo.
   */
  async searchDocuments(query: string): Promise<ToolResult> {
    try {
      // Usamos parámetros optimizados para velocidad en free tier
      const result = await this.iterativeRag.query(
        query,
        5,   // topDocs
        10,  // topParagraphs
        0    // similarityThreshold
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
}
