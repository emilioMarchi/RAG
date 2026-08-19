import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
} from '@huggingface/transformers';
import type { ScoredChunk } from './hybridSearchService.js';

type LazyTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type LazyModel = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

/**
 * LocalReranker
 *
 * Cross-encoder de re-ranking 100% local vía transformers.js (ONNX Runtime).
 * Procesa el par (query, fragmento) JUNTOS dentro del modelo de atención y
 * devuelve un score de relevancia por fragmento, luego reordena y recorta
 * el pool de candidatos a los top-N.
 *
 * A diferencia del reranker 'llm' (chat completion de OpenRouter), aquí no hay
 * llamada de red: el modelo se descarga una vez (q8/int8, ~120MB) y corre en CPU.
 */
export class LocalReranker {
  private tokenizer: LazyTokenizer | null = null;
  private model: LazyModel | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private modelId: string = 'SugoLabs/mmarco-mMiniLMv2-L12-H384-v1') {}

  /**
   * Precarga el modelo al arrancar (el cold load puede tardar ~1-2s).
   */
  async warmUp(): Promise<void> {
    await this.getModel();
  }

  private getModel(): Promise<void> {
    if (!this.initPromise) {
      console.log(`[LocalReranker] Cargando cross-encoder local: ${this.modelId}`);
      this.initPromise = (async () => {
        this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId);
        this.model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, {
          dtype: 'q8',
          device: 'cpu',
        });
        console.log('[LocalReranker] Cross-encoder local listo.');
      })().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  /**
   * Re-rankea los candidatos y devuelve los top-N por relevancia cruzada.
   *
   * @param userQuery   Consulta original del usuario
   * @param candidates  Pool amplio de fragmentos candidatos (ej. 20)
   * @param topN        Cuántos fragmentos finales devolver (ej. 7)
   */
  async rerank(userQuery: string, candidates: ScoredChunk[], topN = 7): Promise<ScoredChunk[]> {
    if (candidates.length <= topN) return candidates;

    await this.getModel();
    const tokenizer = this.tokenizer!;
    const model = this.model!;

    const texts = candidates.map(() => userQuery);
    const passages = candidates.map(
      (c) => `${c.doc_title}\n${c.raw_content ?? c.contextualized_text}`
    );

    const inputs = tokenizer(texts, {
      text_pair: passages,
      padding: true,
      truncation: true,
    });

    const { logits } = await model(inputs);

    const scores = this.extractScores(logits);

    return candidates
      .map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(({ chunk, score }) => ({ ...chunk, hybrid_score: score }));
  }

  /**
   * Convierte los logits del cross-encoder a una probabilidad de relevancia 0-1.
   * - 1 sola salida (p. ej. mMARCO/bge-reranker): sigmoide.
   * - Varias salidas (softmax binaria): probabilidad de la clase positiva (última).
   */
  private extractScores(logits: { data: Float32Array; dims?: number[] }): number[] {
    const dims = logits.dims as number[];
    const data = logits.data;
    const numRows = dims && dims.length >= 2 ? dims[0] : 1;
    const cols = dims && dims.length >= 2 ? dims[1] : 1;

    const scores: number[] = [];
    for (let r = 0; r < numRows; r++) {
      if (cols === 1) {
        const x = data[r];
        scores.push(1 / (1 + Math.exp(-x)));
        continue;
      }
      // Softmax sobre la fila
      const row = Array.from(data.slice(r * cols, (r + 1) * cols));
      const max = Math.max(...row);
      const exps = row.map((v) => Math.exp(v - max));
      const sum = exps.reduce((a, b) => a + b, 0);
      scores.push(exps[cols - 1] / sum);
    }

    return scores;
  }
}