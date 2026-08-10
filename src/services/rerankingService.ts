import type { LLMService } from './llmService.js';
import type { ScoredChunk } from './hybridSearchService.js';

/**
 * RerankingService
 *
 * Toma un pool amplio de candidatos (ej. top-20) y usa el LLM como cross-encoder
 * para puntuar la relevancia cruzada de cada fragmento respecto a la query original.
 * Devuelve los top-N mejor rankeados.
 */
export class RerankingService {
  constructor(private llm: LLMService) {}

  /**
   * Re-rankea los candidatos usando el LLM como cross-encoder.
   *
   * @param userQuery   Consulta original del usuario
   * @param candidates  Pool amplio de fragmentos candidatos (ej. 20)
   * @param topN        Cuántos fragmentos finales devolver (ej. 6-8)
   */
  async rerank(
    userQuery: string,
    candidates: ScoredChunk[],
    topN: number = 7
  ): Promise<ScoredChunk[]> {
    if (candidates.length <= topN) return candidates;

    const scores = await this.llm.rerankChunks(userQuery, candidates);

    // Combinar el score del LLM con el hybrid_score previo (60% LLM, 40% RRF)
    const combined = candidates.map((chunk, i) => ({
      chunk,
      finalScore: 0.6 * (scores[i] ?? 0) + 0.4 * chunk.hybrid_score,
    }));

    combined.sort((a, b) => b.finalScore - a.finalScore);

    return combined.slice(0, topN).map(c => ({
      ...c.chunk,
      hybrid_score: c.finalScore,
    }));
  }
}
