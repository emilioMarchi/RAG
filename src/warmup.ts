import { env } from './config/env.js';
import { LocalEmbeddingService } from './services/localEmbeddingService.js';
import { LocalReranker } from './services/localReranker.js';

async function main() {
  console.log('=== Pre-cargando modelos locales ===');
  
  // Configurar cache de HF en ./models para persistencia
  process.env.HF_HOME = process.env.HF_HOME || './models/hf-cache';
  process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || './models/hf-cache';

  const embedder = new LocalEmbeddingService(env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS);
  console.log(`[Warmup] Embedding: ${env.EMBEDDING_MODEL} (${env.EMBEDDING_DIMENSIONS}d)`);
  await embedder.warmUp();

  if (env.RAG_RERANK_STRATEGY === 'local') {
    const reranker = new LocalReranker(env.RERANKER_MODEL);
    console.log(`[Warmup] Reranker: ${env.RERANKER_MODEL}`);
    await reranker.warmUp();
  } else {
    console.log(`[Warmup] Reranker: strategy=${env.RAG_RERANK_STRATEGY} (no local)`);
  }

  console.log('=== Modelos listos ===');
}

main().catch((err) => {
  console.error('[Warmup] Error:', err);
  process.exit(1);
});