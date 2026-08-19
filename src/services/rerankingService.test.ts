import { describe, it, expect, vi } from 'vitest';
import { RerankingService } from './rerankingService.js';

function chunk(id: string, score: number) {
  return {
    id,
    document_id: 'doc-1',
    paragraph_index: 0,
    raw_content: id,
    contextualized_text: id,
    doc_title: 'Doc 1',
    r2_key: 'k',
    r2_url: null,
    parent_chunk_id: null,
    hybrid_score: score,
  };
}

describe('RerankingService (estrategia local)', () => {
  it('delega en el LocalReranker cuando la estrategia es local', async () => {
    const localReranker = {
      rerank: vi.fn().mockResolvedValue([]),
    };
    const svc = new RerankingService(null, 'local', localReranker as any);
    const candidates = [chunk('p1', 0.1), chunk('p2', 0.2), chunk('p3', 0.3)];

    await svc.rerank('query', candidates, 2);

    expect(localReranker.rerank).toHaveBeenCalledWith('query', candidates, 2);
  });

  it('cae a slice sin LocalReranker disponible', async () => {
    const svc = new RerankingService(null, 'local', null);
    const candidates = [chunk('p1', 0.1), chunk('p2', 0.2), chunk('p3', 0.3)];

    const ranked = await svc.rerank('query', candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.id)).toEqual(['p1', 'p2']);
  });

  it('mantiene comportamiento hybrid para la estrategia por defecto', async () => {
    const svc = new RerankingService(null, 'hybrid');
    const candidates = [chunk('p1', 0.1), chunk('p2', 0.9), chunk('p3', 0.5)];

    const ranked = await svc.rerank('query', candidates, 1);
    expect(ranked.map((c) => c.id)).toEqual(['p2']);
  });
});