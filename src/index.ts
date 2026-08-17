import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { EmbeddingService } from './services/embeddingService.js';
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

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// Servir la interfaz web estática
app.use(express.static(path.join(__dirname, '..', 'public')));

const embedder = new EmbeddingService();
const llm = new LLMService();
const storage = new StorageService();
const chunker = new ChunkingService();
const pipeline = new IngestionPipeline(embedder, llm, storage);
const rag = new HierarchicalRAGModule(embedder, llm);
const iterativeRag = new IterativeRAGEngine(embedder, llm, {
  maxIterations: env.RAG_MAX_ITERATIONS,
  enableReranking: env.RAG_ENABLE_RERANKING,
  enableCRAG: env.RAG_ENABLE_CRAG,
});
const agentService = new AgentService(llm, iterativeRag, {
  maxTurns: env.AGENT_MAX_TURNS,
  topDocs: env.AGENT_TOP_DOCS,
  topParagraphs: env.AGENT_TOP_PARAGRAPHS,
});

app.use('/api', createDocumentRouter(pipeline, chunker, storage));
app.use('/api', createQueryRouter(rag, iterativeRag, llm));
app.use('/api', createAgentRouter(agentService));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(env.PORT, () => {
  console.log(`RAG API running on http://localhost:${env.PORT}`);
  console.log(`Health: http://localhost:${env.PORT}/api/health`);
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
