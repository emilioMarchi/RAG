import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { EmbeddingService } from './services/embeddingService.js';
import { LocalEmbeddingService } from './services/localEmbeddingService.js';
import { LocalReranker } from './services/localReranker.js';
import { LLMService } from './services/llmService.js';
import { StorageService } from './services/r2Service.js';
import { ChunkingService } from './services/chunkingService.js';
import { IngestionPipeline } from './services/ingestionPipeline.js';
import { HierarchicalRAGModule } from './services/ragEngine.js';
import { IterativeRAGEngine } from './services/iterativeRAGEngine.js';
import { createDocumentRouter } from './routes/documents.js';
import { createQueryRouter } from './routes/query.js';
import { AgentService } from './agent/agentService.js';
import { createAgentRouter } from './routes/agent.js';
import { createLLMRouter } from './routes/llm.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// Servir la interfaz web estática
app.use(express.static(path.join(__dirname, '..', 'public')));

async function main() {
  // ── Selector de proveedor de embeddings ──────────────────────────────────
  // 'local' = modelos ONNX en CPU (sin API key, sin red después de la 1ª carga).
  // 'gemini' = API de Gemini (requiere GEMINI_API_KEY).
  const embedder =
    env.EMBEDDING_PROVIDER === 'local'
      ? new LocalEmbeddingService(env.EMBEDDING_MODEL, env.EMBEDDING_DIMENSIONS)
      : new EmbeddingService();

  const llm = new LLMService();
  const storage = new StorageService();
  const chunker = new ChunkingService();
  const pipeline = new IngestionPipeline(embedder, llm, storage);

  // ── Reranker local (solo si la estrategia elegida es 'local') ─────────────
  const localReranker =
    env.RAG_RERANK_STRATEGY === 'local' ? new LocalReranker(env.RERANKER_MODEL) : null;

  // Warm-up: los modelos locales cargan en memoria una sola vez. El cold load
  // es la parte lenta (~0.4s embeddings, ~1-2s reranker); se hace antes de
  // aceptar tráfico para que el primer query no pague esa espera.
  if (embedder instanceof LocalEmbeddingService) {
    await embedder.warmUp();
  }
  if (localReranker) {
    await localReranker.warmUp();
  }

  const rag = new HierarchicalRAGModule(embedder, llm, { localReranker: localReranker ?? undefined });
  const iterativeRag = new IterativeRAGEngine(embedder, llm, {
    maxIterations: env.RAG_MAX_ITERATIONS,
    enableReranking: env.RAG_ENABLE_RERANKING,
    rerankStrategy: env.RAG_RERANK_STRATEGY,
    localReranker: localReranker ?? undefined,
    cragMaxPasses: env.RAG_CRAG_MAX_PASSES,
    enableContextExpansion: env.RAG_ENABLE_CONTEXT_EXPANSION,
    enableDecompose: env.RAG_ENABLE_DECOMPOSE,
    timeoutMs: env.RAG_TIMEOUT_MS,
  });
  const agentService = new AgentService(llm, iterativeRag, {
    maxTurns: env.AGENT_MAX_TURNS,
    topDocs: env.AGENT_TOP_DOCS,
    topParagraphs: env.AGENT_TOP_PARAGRAPHS,
  });

  app.use('/api', createDocumentRouter(pipeline, chunker, storage));
  app.use('/api', createQueryRouter(rag, iterativeRag, llm));
  app.use('/api', createAgentRouter(agentService));
  app.use('/api', createLLMRouter(llm));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.listen(env.PORT, () => {
    console.log(`RAG API running on http://localhost:${env.PORT}`);
    console.log(`Health: http://localhost:${env.PORT}/api/health`);
    console.log(
      `Embeddings: ${env.EMBEDDING_PROVIDER === 'local' ? `local (${env.EMBEDDING_MODEL}, ${env.EMBEDDING_DIMENSIONS}d)` : 'gemini api'} | Rerank: ${env.RAG_RERANK_STRATEGY}`
    );
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  await pool.end();
  process.exit(0);
});
