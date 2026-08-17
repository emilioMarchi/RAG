import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key] || undefined;
}

export const env = {
  GEMINI_API_KEY: required('GEMINI_API_KEY'),
  LLM_API_URL: process.env.LLM_API_URL || 'https://openrouter.ai/api/v1',
  LLM_API_KEY: required('LLM_API_KEY'),
  LLM_MODEL: process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
  LLM_BACKUP_MODEL: optional('LLM_BACKUP_MODEL'),
  DATABASE_URL: required('DATABASE_URL'),

  // Almacenamiento: 'local' (default) o 'r2'
  STORAGE_MODE: (process.env.STORAGE_MODE || 'local') as 'local' | 'r2',
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR || 'data/documents',
  // R2 es opcional: solo se usa si STORAGE_MODE=r2
  CLOUDFLARE_ACCOUNT_ID: optional('CLOUDFLARE_ACCOUNT_ID'),
  R2_ACCESS_KEY_ID: optional('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: optional('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_NAME: optional('R2_BUCKET_NAME'),
  R2_PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || null,
  PORT: parseInt(process.env.PORT || '3000', 10),

  // RAG iterativo (motor compartido por /api/query/iterative y el agente)
  RAG_MAX_ITERATIONS: parseInt(process.env.RAG_MAX_ITERATIONS || '4', 10),
  RAG_ENABLE_RERANKING: (process.env.RAG_ENABLE_RERANKING ?? 'true') === 'true',
  RAG_ENABLE_CRAG: (process.env.RAG_ENABLE_CRAG ?? 'true') === 'true',

  // Agente conversacional
  AGENT_MAX_TURNS: parseInt(process.env.AGENT_MAX_TURNS || '10', 10),
  AGENT_TOP_DOCS: parseInt(process.env.AGENT_TOP_DOCS || '5', 10),
  AGENT_TOP_PARAGRAPHS: parseInt(process.env.AGENT_TOP_PARAGRAPHS || '10', 10),

  // Ingesta de documentos
  // Reducir si el LLM usado es de plan free (OpenRouter free tier limita RPM muy bajo)
  INGESTION_CONCURRENCY: parseInt(process.env.INGESTION_CONCURRENCY || '2', 10),
  // Graph RAG: extracción de entidades/relaciones con el LLM.
  // Desactivado por defecto: el grafo aún no tiene consumidores reales (solo se escribe).
  // Reactivar cuando se implemente un endpoint/vista que lo lea.
  INGESTION_ENABLE_GRAPH_RAG: (process.env.INGESTION_ENABLE_GRAPH_RAG ?? 'false') === 'true',
  // Enriquecimiento determinista: construir el contexto (contextualized_text) sin llamar al LLM.
  // Si es false, vuelve al flujo anterior con llm.enrichChunk (más caro y lento).
  INGESTION_DETERMINISTIC_ENRICH: (process.env.INGESTION_DETERMINISTIC_ENRICH ?? 'true') === 'true',
} as const;
