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
  // Gemini (SOLO EMBEDDINGS y solo si EMBEDDING_PROVIDER=gemini).
  // Con EMBEDDING_PROVIDER=local el sistema no requiere API key de Gemini.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
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
  // Estrategia de re-ranking: 'hybrid' (determinista) | 'llm' (cross-encoder) | 'local' (ONNX CPU).
  RAG_RERANK_STRATEGY: (process.env.RAG_RERANK_STRATEGY || 'hybrid') as 'hybrid' | 'llm' | 'local',
  RAG_ENABLE_RERANKING: (process.env.RAG_ENABLE_RERANKING ?? 'true') === 'true',
  // Corrective RAG: nº máximo de pases de re-búsqueda (0 = desactivado). Default 0.
  RAG_CRAG_MAX_PASSES: parseInt(process.env.RAG_CRAG_MAX_PASSES || '0', 10),
  // Bucle de expansión de contexto (evaluateContext): true si se evalúa el contexto
  // con LLM para ampliar párrafos adyacentes. Default false (evita una llamada LLM cara).
  RAG_ENABLE_CONTEXT_EXPANSION: (process.env.RAG_ENABLE_CONTEXT_EXPANSION ?? 'false') === 'true',
  // Decomposición de query con LLM (true) o heurística directa (false).
  RAG_ENABLE_DECOMPOSE: (process.env.RAG_ENABLE_DECOMPOSE ?? 'true') === 'true',
  // Presupuesto global de latencia (ms) para una consulta. 0 = sin límite.
  // IMPORTANTE: un valor bajo (p. ej. 45000) NO cancela el pipeline: las llamadas
  // LLM/embedding ya iniciadas siguen ejecutándose y, al expirar, lanzan
  // QueryTimeoutError que rompe/aborta la respuesta RAG por completo. Se deja en 0
  // (sin límite) por defecto para que la consulta siempre termine.
  RAG_TIMEOUT_MS: parseInt(process.env.RAG_TIMEOUT_MS || '0', 10),
  // Espera (ms) por reintento ante rate-limit (429) del LLM. Bajo para no colgarse
  // con modelos free que rate-limitan seguido. Default 10000.
  RAG_RATE_LIMIT_RETRY_MS: parseInt(process.env.RAG_RATE_LIMIT_RETRY_MS || '10000', 10),

  // Agente conversacional
  AGENT_MAX_TURNS: parseInt(process.env.AGENT_MAX_TURNS || '10', 10),
  AGENT_TOP_DOCS: parseInt(process.env.AGENT_TOP_DOCS || '5', 10),
  AGENT_TOP_PARAGRAPHS: parseInt(process.env.AGENT_TOP_PARAGRAPHS || '10', 10),

  // Ingesta de documentos
  // Reducir si el LLM usado es de plan free (OpenRouter free tier limita RPM muy bajo)
  INGESTION_CONCURRENCY: parseInt(process.env.INGESTION_CONCURRENCY || '2', 10),

  // ============================================
  //  Modelos LOCALES (transformers.js / ONNX)
  //  Reemplazan a Gemini para embeddings y al LLM para re-ranking.
  //  Corren en CPU sin llamadas de red después de la primera descarga.
  // ============================================
  // Proveedor de embeddings: 'gemini' (API) | 'local' (ONNX en CPU).
  EMBEDDING_PROVIDER: (process.env.EMBEDDING_PROVIDER || 'gemini') as 'gemini' | 'local',
  // Modelo local de embeddings (384d, multilingüe). Cambiar solo si se prueba otro.
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  // Dimensión del modelo local. Debe coincidir con la columna vector() de la DB.
  EMBEDDING_DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || '384', 10),
  // Cross-encoder local para RAG_RERANK_STRATEGY=local (multilingüe, incluye español).
  RERANKER_MODEL: process.env.RERANKER_MODEL || 'SugoLabs/mmarco-mMiniLMv2-L12-H384-v1',
  // Graph RAG: extracción de entidades/relaciones con el LLM.
  // Desactivado por defecto: el grafo aún no tiene consumidores reales (solo se escribe).
  // Reactivar cuando se implemente un endpoint/vista que lo lea.
  INGESTION_ENABLE_GRAPH_RAG: (process.env.INGESTION_ENABLE_GRAPH_RAG ?? 'false') === 'true',
  // Enriquecimiento determinista: construir el contexto (contextualized_text) sin llamar al LLM.
  // Si es false, vuelve al flujo anterior con llm.enrichChunk (más caro y lento).
  INGESTION_DETERMINISTIC_ENRICH: (process.env.INGESTION_DETERMINISTIC_ENRICH ?? 'true') === 'true',
} as const;
