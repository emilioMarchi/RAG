# PLAN DE OPTIMIZACIÓN PGVECTOR / POSTGRESQL

_Origen: observaciones del agente de desarrollo validadas contra el código y respuesta del
agente auditor en `log.md`. Fuente real: validación de las 4 sugerencias de rendimiento sobre
`/query/scores`, `/query/relations` y la dimensionalidad model/columna._

## 1. Contexto

El `log.md` contenía 4 sugerencias de optimización de latencia (PostgreSQL/pgvector y
embeddings). El agente de desarrollo las validó contra `src/routes/query.ts`,
`src/services/embeddingService.ts`, `src/migrations/001_initial.sql` y los motores RAG.
El auditor aceptó la validación y propuso correcciones (P1, S1, S2) + una opcional (S4).

Resumen del dictamen:
- **S1** `Full Table Scan` en `/query/scores`: confirmada → aplicar.
- **S2** producto cartesiano en `/query/relations`: acertada → aplicar.
- **S3** `JSON.stringify` vs vector string: **descartada** (no aporta nada; Postgres ya recibe
  el literal nativo).
- **S4** `embedding_low` (Matryoshka): archivada como **opcional** a futuro.
- **Bug latente detectado (P1, crítico)**: modelo `gemini-embedding-001` (máx. 768 dims) vs
  `1536` solicitado / columna `vector(1536)`.

## 2. Estado actual del código (referencias)

| Archivo | Detalle |
| --- | --- |
| `src/routes/query.ts:100-106` | `SELECT ... ORDER BY score DESC` sin LIMIT (S1) |
| `src/routes/query.ts:258-271` | `CROSS JOIN document_paragraphs` (S2) |
| `src/routes/query.ts:95` | `generateEmbedding(..., 1536)` (P1) |
| `src/services/ingestionPipeline.ts:87` | `generateEmbedding(ctxText, 1536)` (P1) |
| `src/services/ingestionPipeline.ts:131` | guarda `JSON.stringify(ec.highVector)` (P1) |
| `src/services/ragEngine.ts:84` | `generateEmbedding(userQuery, 1536)` (P1) |
| `src/services/iterativeRAGEngine.ts:79,176` | `generateEmbedding(subQ/reformulated, 1536)` (P1) |
| `src/services/embeddingService.ts:4` | MODEL = `gemini-embedding-001` (máx. 768) (P1) |
| `src/migrations/001_initial.sql:24,31-32` | `embedding_high vector(1536)` + HNSW (P1) |

## 3. Dimensiones existentes (no confundir)

- `documents.embedding_base` `vector(768)` — nivel documento (búsqueda de docs).
- `document_paragraphs.embedding_high` `vector(1536)` — nivel párrafo (grafo/similitud).

Son **columnas/vectores**, no 2 modelos. `gemini-embedding-001` admite
`outputDimensionality` hasta **768**.

## 4. Fases

### FASE P1 (CRÍTICO) — Alinear dimensión de párrafos
1. **Verificar** en runtime el máximo real del modelo que devuelve el endpoint (status 200 ya
   logueado con dims 768/1536 → confirmar si 1536 es aceptado). Si `gemini-embedding-001`
   rechaza 1536, la ingesta de párrafos estará fallando.
2. **Migración SQL** (`007_paragraphs_dim768.sql`):
   ```sql
   DROP INDEX IF EXISTS idx_paragraphs_high;
   ALTER TABLE document_paragraphs ALTER COLUMN embedding_high TYPE vector(768) USING embedding_high::vector(768);
   CREATE INDEX idx_paragraphs_high ON document_paragraphs USING hnsw (embedding_high vector_cosine_ops) WITH (m = 16, ef_construction = 64);
   ```
   (El `USING ... ::vector(768)` evita fallo si hubiera filas; y exige re-ingesta si las
   hubiera de distinta dimensión.)
3. **Código** — cambiar `1536 → 768` (u omitir dim) en:
   - `src/routes/query.ts:95`
   - `src/services/ingestionPipeline.ts:87`
   - `src/services/ragEngine.ts:84`
   - `src/services/iterativeRAGEngine.ts:79,176`  ← omitido por el auditor, agregado acá
4. **Re-ingesta** de los documentos existentes (los párrafos guardados quedan con dimensión
   previa).

### FASE S1 — HNSW + LIMIT en `/query/scores` (query.ts)
```ts
const LIMIT_SCORES = 1000; // techo acotado del grafo de nodos
const result = await query<{ id: string; score: number }>(
  `SELECT id,
          GREATEST(0, 1 - (embedding_high <=> $1::vector) / 2) AS score
   FROM document_paragraphs
   ORDER BY embedding_high <=> $1::vector
   LIMIT $2`,
  [JSON.stringify(highVector), LIMIT_SCORES]
);
```
- El `LIMIT` activa el índice HNSW y acota el grafo a los N párrafos más similares.
- **Degradación aceptada:** el frontend recibe menos nodos; documentar/ajustar el techo.
- `JSON.stringify` conservado (S3 descartada).

### FASE S2 — CTE MATERIALIZED en `/query/relations` (query.ts)
```ts
const result = await query<{ source_id: string; target_id: string; similarity: number }>(
  `WITH subset AS MATERIALIZED (
      SELECT id, embedding_high FROM document_paragraphs WHERE id = ANY($1::uuid[])
   )
   SELECT p1.id AS source_id, p2.id AS target_id,
          (1 - (p1.embedding_high <=> p2.embedding_high)) AS similarity
   FROM subset p1 CROSS JOIN subset p2
   WHERE p1.id < p2.id
     AND (1 - (p1.embedding_high <=> p2.embedding_high)) >= $2
   ORDER BY similarity DESC`,
  [paragraphIds, simThreshold]
);
```

### FASE S4 (OPCIONAL, archivada)
- Añadir `embedding_low` (p.ej. 256/512) + índice HNSW en párrafos, dedicado solo al grafo.
- Diferida; reabrir si la carga del grafo sigue siendo el cuello de botella tras P1/S1/S2.

## 5. Orden de ejecución sugerido
1. P1 (¿bug de dimensiones?) → 2. S1 → 3. S2 → 4. (opcional) S4.

## 6. Verificación
```bash
npx tsc --noEmit          # typecheck en 0
npx vitest run            # suite (4 fallas preexistentes de mocks DB permitidas)
```
- Verificación manual: `/upload` de un doc → check que `embedding_high` se inserte en 768;
  `/query/scores` con `EXPLAIN` y LIMIT usando `idx_paragraphs_high`; `/query/relations`
  materializando el subset.

## 7. Criterio de aceptación
- Ingesta de párrafos funciona con dimensión alineada al modelo (768).
- `/query/scores` usa el índice HNSW (EXPLAIN) y acota nodos.
- `/query/relations` materializa el subset antes del cruce.
- `tsc` y tests verdes salvo las 4 fallas de mocks preexistentes.