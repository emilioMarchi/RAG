RAG Studio - Launcher
============================================

[1/6] Checking Docker Desktop...
      Docker OK.
[2/6] Checking dependencies...
  node_modules already present.
[3/6] Checking .env...
[4/6] Starting database (PostgreSQL + pgvector)...
  Existing container found, starting it...
  Waiting for PostgreSQL to be ready...
  Database ready.
[5/6] Running migrations...

> rag-studio@1.0.0 migrate
> tsx src/migrate.ts

◇ injected env (18) from .env // tip: ⌘ custom filepath { path: '/custom/path/.env' }
Skipping migration: 001_initial.sql (already applied)
Skipping migration: 002_bm25_indexes.sql (already applied)
Skipping migration: 003_parent_chunks.sql (already applied)
Skipping migration: 004_graph_rag.sql (already applied)
Skipping migration: 005_query_evaluations.sql (already applied)
Skipping migration: 006_chunk_locations.sql (already applied)
Skipping migration: 007_local_embeddings.sql (already applied)
All migrations already applied.
[6/6] Starting RAG Studio (web)...

> rag-studio@1.0.0 dev
> tsx watch src/index.ts

◇ injected env (18) from .env // tip: ◈ encrypted .env [www.dotenvx.com]
[LocalEmbedding] Cargando modelo local: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (dims=384)
[LocalEmbedding] Modelo local listo.
[LocalReranker] Cargando cross-encoder local: SugoLabs/mmarco-mMiniLMv2-L12-H384-v1
[LocalReranker] Cross-encoder local listo.
RAG API running on http://localhost:3000
Health: http://localhost:3000/api/health
Embeddings: local (Xenova/paraphrase-multilingual-MiniLM-L12-v2, 384d) | Rerank: local
Relations error: error: syntax error at or near ">="
    at D:\Emi\apps\RAG\node_modules\pg-pool\index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (D:\Emi\apps\RAG\src\routes\query.ts:288:22) {
  length: 92,
  severity: 'ERROR',
  code: '42601',
  detail: undefined,
  hint: undefined,
  position: '501',
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'scan.l',
  line: '1244',
  routine: 'scanner_yyerror'
}
Relations error: error: syntax error at or near ">="
    at D:\Emi\apps\RAG\node_modules\pg-pool\index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (D:\Emi\apps\RAG\src\routes\query.ts:288:22) {
  length: 92,
  severity: 'ERROR',
  code: '42601',
  detail: undefined,
  hint: undefined,
  position: '501',
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'scan.l',
  line: '1244',
  routine: 'scanner_yyerror'
}
Relations error: error: syntax error at or near ">="
    at D:\Emi\apps\RAG\node_modules\pg-pool\index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (D:\Emi\apps\RAG\src\routes\query.ts:288:22) {
  length: 92,
  severity: 'ERROR',
  code: '42601',
  detail: undefined,
  hint: undefined,
  position: '501',
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'scan.l',
  line: '1244',
  routine: 'scanner_yyerror'
}
Relations error: error: syntax error at or near ">="
    at D:\Emi\apps\RAG\node_modules\pg-pool\index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (D:\Emi\apps\RAG\src\routes\query.ts:288:22) {
  length: 92,
  severity: 'ERROR',
  code: '42601',
  detail: undefined,
  hint: undefined,
  position: '501',
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'scan.l',
  line: '1244',
  routine: 'scanner_yyerror'
}
Relations error: error: syntax error at or near ">="
    at D:\Emi\apps\RAG\node_modules\pg-pool\index.js:45:11
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async <anonymous> (D:\Emi\apps\RAG\src\routes\query.ts:288:22) {
  length: 92,
  severity: 'ERROR',
  code: '42601',
  detail: undefined,
  hint: undefined,
  position: '501',
  internalPosition: undefined,
  internalQuery: undefined,
  where: undefined,
  schema: undefined,
  table: undefined,
  column: undefined,
  dataType: undefined,
  constraint: undefined,
  file: 'scan.l',
  line: '1244',
  routine: 'scanner_yyerror'
}