import { describe, it, expect, vi, beforeEach } from 'vitest';

const tokenizerFromPretrainedMock = vi.fn();
const modelFromPretrainedMock = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: tokenizerFromPretrainedMock },
  AutoModelForSequenceClassification: { from_pretrained: modelFromPretrainedMock },
}));

const { LocalReranker } = await import('./localReranker.js');

function chunk(id: string, raw = 'texto ' + id, score = 0) {
  return {
    id,
    document_id: 'doc-1',
    paragraph_index: 0,
    raw_content: raw,
    contextualized_text: raw,
    doc_title: 'Doc 1',
    r2_key: 'k',
    r2_url: null,
    parent_chunk_id: null,
    hybrid_score: score,
  };
}

function setupMocks() {
  const tokenizer = vi.fn().mockReturnValue({ input_ids: [], attention_mask: [] });
  const model = vi.fn();
  tokenizerFromPretrainedMock.mockResolvedValue(tokenizer);
  modelFromPretrainedMock.mockResolvedValue(model);
  return { tokenizer, model };
}

describe('LocalReranker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reordena candidatos por score del cross-encoder y devuelve top-N', async () => {
    const { model } = setupMocks();
    model.mockResolvedValue({
      logits: {
        data: new Float32Array([0.9, 0.2, 0.7, 0.1]),
        dims: [4, 1],
      },
    });

    const reranker = new LocalReranker('model-test');
    const candidates = [chunk('p1'), chunk('p2'), chunk('p3'), chunk('p4')];
    const ranked = await reranker.rerank('consulta', candidates, 2);

    expect(modelFromPretrainedMock).toHaveBeenCalledWith('model-test', {
      dtype: 'q8',
      device: 'cpu',
    });
    expect(ranked.map((c) => c.id)).toEqual(['p1', 'p3']);
    expect(ranked[0].hybrid_score).toBeCloseTo(0.7109, 1);
  });

  it('pasa query y pasajes en pares al tokenizador', async () => {
    const { tokenizer, model } = setupMocks();
    model.mockResolvedValue({
      logits: { data: new Float32Array([0.5, 0.5]), dims: [2, 1] },
    });

    const reranker = new LocalReranker('model-test');
    const candidates = [chunk('p1', 'texto uno'), chunk('p2', 'texto dos')];
    await reranker.rerank('¿qué dice el artículo 2?', candidates, 1);

    const [texts, options] = tokenizer.mock.calls[0];
    expect(texts).toEqual(['¿qué dice el artículo 2?', '¿qué dice el artículo 2?']);
    expect(options.text_pair[0]).toContain('texto uno');
    expect(options.text_pair[1]).toContain('texto dos');
    expect(options.padding).toBe(true);
    expect(options.truncation).toBe(true);
  });

  it('aplica sigmoide a logits de salida única', async () => {
    const { model } = setupMocks();
    model.mockResolvedValue({
      logits: {
        data: new Float32Array([0.0, 5.0]),
        dims: [2, 1],
      },
    });

    const reranker = new LocalReranker('model-test');
    const candidates = [chunk('p1'), chunk('p2')];
    const ranked = await reranker.rerank('q', candidates, 1);

    expect(ranked[0].id).toBe('p2');
    expect(ranked[0].hybrid_score).toBeCloseTo(0.9933, 2);
  });

  it('usa softmax para clasificación binaria de varias salidas', async () => {
    const { model } = setupMocks();
    model.mockResolvedValue({
      logits: {
        data: new Float32Array([-2, 0, 0, 5]),
        dims: [2, 2],
      },
    });

    const reranker = new LocalReranker('model-test');
    const candidates = [chunk('p1'), chunk('p2')];
    const ranked = await reranker.rerank('q', candidates, 1);

    expect(ranked[0].id).toBe('p2');
    expect(ranked[0].hybrid_score).toBeGreaterThan(0.9);
  });

  it('no reordena si no hay más candidatos que topN', async () => {
    const reranker = new LocalReranker('model-test');
    const candidates = [chunk('p1'), chunk('p2')];
    const ranked = await reranker.rerank('q', candidates, 5);

    expect(ranked).toHaveLength(2);
    expect(tokenizerFromPretrainedMock).not.toHaveBeenCalled();
  });
});