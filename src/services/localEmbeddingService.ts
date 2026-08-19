import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * LocalEmbeddingService
 *
 * Genera embeddings 100% locales vía transformers.js (ONNX Runtime) sin depender
 * de la API de Gemini. La misma interfaz que EmbeddingService (generateEmbedding)
 * para poder intercambiarlos sin tocar los consumidores.
 *
 * El argumento `dimensions` del contrato original se ignora: la dimensión real la
 * define el modelo local (default 384) y se recorta a `this.dimensions` para que
 * los vectores coincidan siempre con la columna vector() de la base.
 */
export class LocalEmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    private modelId: string = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    private dimensions: number = 384
  ) {}

  /**
   * Precarga el modelo al arrancar (el cold load es la parte más lenta).
   * No es estrictamente necesario: generateEmbedding carga lazy por sí mismo.
   */
  async warmUp(): Promise<void> {
    await this.getExtractor();
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.initPromise) {
      console.log(`[LocalEmbedding] Cargando modelo local: ${this.modelId} (dims=${this.dimensions})`);
      this.initPromise = pipeline('feature-extraction', this.modelId, {
        dtype: 'q8',
        device: 'cpu',
      })
        .then((extractor) => {
          this.extractor = extractor;
          console.log('[LocalEmbedding] Modelo local listo.');
          return extractor;
        })
        .catch((err) => {
          // Permitir reintentar en la próxima llamada si la carga falla (p. ej. sin red).
          this.initPromise = null;
          throw err;
        });
    }
    return this.initPromise;
  }

  async generateEmbedding(text: string, _dimensions?: number): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from((output.data as Float32Array).slice(0, this.dimensions));
  }

  /**
   * Embedding en lote de varios textos (útil para ingesta: una sola pasada del
   * modelo por lote en lugar de N llamadas individuales).
   */
  async generateEmbeddings(texts: string[], batchSize = 8): Promise<number[][]> {
    const extractor = await this.getExtractor();
    const result: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const data = output.data as Float32Array;
      const dims = output.dims as number[];
      const numRows = dims.length === 2 ? dims[0] : 1;
      for (let r = 0; r < numRows; r++) {
        result.push(Array.from(data.slice(r * dims[1], r * dims[1] + this.dimensions)));
      }
    }

    return result;
  }
}