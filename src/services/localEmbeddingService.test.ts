import { describe, it, expect, vi, beforeEach } from 'vitest';

const pipelineMock = vi.fn();
vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineMock,
}));

const { LocalEmbeddingService } = await import('./localEmbeddingService.js');

function fakeTensor(data: number[], dims: number[]) {
  return { data: new Float32Array(data), dims };
}

describe('LocalEmbeddingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generateEmbedding devuelve vector de la dimensión configurada', async () => {
    const extractor = vi.fn().mockResolvedValue(fakeTensor(Array.from({ length: 512 }, (_, i) => i), [1, 512]));
    pipelineMock.mockResolvedValue(extractor);

    const svc = new LocalEmbeddingService('model-test', 384);
    const vec = await svc.generateEmbedding('consulta de prueba');

    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'model-test', {
      dtype: 'q8',
      device: 'cpu',
    });
    expect(vec).toHaveLength(384);
    expect(vec[0]).toBe(0);
    expect(vec[383]).toBe(383);
  });

  it('recorta a la dimensión incluso si el modelo emite más dims', async () => {
    const extractor = vi.fn().mockResolvedValue(fakeTensor(Array.from({ length: 768 }, (_, i) => i), [1, 768]));
    pipelineMock.mockResolvedValue(extractor);

    const svc = new LocalEmbeddingService('model-test', 384);
    const vec = await svc.generateEmbedding('t');
    expect(vec).toHaveLength(384);
  });

  it('generateEmbeddings procesa en lote y separa filas', async () => {
    const extractor = vi.fn().mockResolvedValue(fakeTensor(
      Array.from({ length: 2 * 384 }, (_, i) => i),
      [2, 384]
    ));
    pipelineMock.mockResolvedValue(extractor);

    const svc = new LocalEmbeddingService('model-test', 384);
    const batch = await svc.generateEmbeddings(['a', 'b'], 8);

    expect(extractor).toHaveBeenCalledWith(['a', 'b'], { pooling: 'mean', normalize: true });
    expect(batch).toHaveLength(2);
    expect(batch[0]).toHaveLength(384);
    expect(batch[1]).toHaveLength(384);
    expect(batch[0][0]).toBe(0);
    expect(batch[1][0]).toBe(384);
  });

  it('reutiliza el pipeline entre llamadas (singleton)', async () => {
    const extractor = vi.fn().mockResolvedValue(fakeTensor(Array.from({ length: 384 }), [1, 384]));
    pipelineMock.mockResolvedValue(extractor);

    const svc = new LocalEmbeddingService('model-test', 384);
    await svc.generateEmbedding('a');
    await svc.generateEmbedding('b');

    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });
});