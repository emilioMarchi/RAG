import type { LLMService } from './llmService.js';
import type { ScoredChunk } from './hybridSearchService.js';
import type { LocalReranker } from './localReranker.js';

export type RerankStrategy = 'hybrid' | 'llm' | 'local';

/**
 * RerankingService
 *
 * Toma un pool amplio de candidatos (ej. top-20) y produce los top-N mejor
 * rankeados según la estrategia configurada:
 *
 * - 'hybrid' (default, determinista y SIN llamada LLM): reordena por el
 *   `hybrid_score` ya calculado por RRF (coseno + BM25) y toma el top-N.
 *   Es instantáneo y no incurre en latencia/costo de red.
 *
 * - 'llm': usa el LLM como cross-encoder para puntuar la relevancia cruzada
 *   de cada fragmento respecto a la query original. Más preciso pero lento.
 *
 * - 'local': usa un cross-encoder local (transformers.js/ONNX) en CPU.
 *   Misma precisión conceptual que 'llm' pero sin llamada de red ni API key.
 */
export class RerankingService {
  constructor(
    private llm: LLMService | null = null,
    private strategy: RerankStrategy = 'hybrid',
    private localReranker: LocalReranker | null = null
  ) {}

  /**
   * Re-rankea los candidatos y devuelve los top-N.
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

    if (this.strategy === 'hybrid') {
      // Ya vienen ordenados por hybrid_score (RRF), pero ordenamos por seguridad.
      return [...candidates]
        .sort((a, b) => b.hybrid_score - a.hybrid_score)
        .slice(0, topN);
    }

    // Estrategia 'local': cross-encoder ONNX en CPU (sin red).
    if (this.strategy === 'local') {
      if (!this.localReranker) {
        return candidates.slice(0, topN);
      }
      return this.localReranker.rerank(userQuery, candidates, topN);
    }

    // Estrategia 'llm': cross-encoder con el LLM.
    if (!this.llm) {
      return candidates.slice(0, topN);
    }

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
