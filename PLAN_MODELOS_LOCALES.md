# Plan: Modelos locales por etapa del pipeline RAG

> Estado: propuesta para validar.
> Objetivo: reducir latencia y dependencia de APIs externas pesadas (Gemini
> embeddings) reemplazando cada punto del pipeline por el modelo local más
> liviano que resuelva la tarea, manteniendo el control total del stack
> (Node/TS + Postgres pgvector, sin Python).

---

## 1. Contexto y problema

- Hoy TODOS los embeddings (768d documento + 1536d párrafo) se generan con
  `gemini-embedding-001` vía API (`src/services/embeddingService.ts`): ~200-500ms
  y una llamada de red por embedding, más exposición a rate-limits.
- El re-ranking `'llm'` usa una chat completion de OpenRouter como cross-encoder
  (lento y caro); el `'hybrid'` actual es solo RRF (no cruza query-fragmento).
- Los chunks son de ~300 tokens (`childMaxChars: 1200`). Para esa escala un
  modelo de 384 dimensiones puede ser suficiente; el 1536d está sobredimensionado.
- Se trabaja con **un solo documento**: re-embedding no representa costo.

## 2. Objetivo

1. **Embeddings locales** (384d) que reemplacen a Gemini en la indexación y la query.
2. **Reranker cross-encoder local** que reemplace al LLM como reranker.
3. Mantener la búsqueda híbrida (pgvector + BM25) ya existente.
4. Mantener únicamente la generación de respuesta como dependencia remota (LLM).

## 3. Modelos propuestos por etapa

| Etapa | Hoy | Propuesto (local ONNX) | Tamaño | Dims |
|---|---|---|---|---|
| Embeddings párrafos / docs | Gemini API 1536d/768d | `paraphrase-multilingual-MiniLM-L12-v2` (Xenova/onnx-community) | ~35MB q8 | 384 |
| Reranker cross-encoder | RRF o chat completion | `SugoLabs/mmarco-mMiniLMv2-L12-H384-v1` (mMARCO, multilingüe con español, int8) | ~118MB | — |
| Alternativa reranker | — | `Xenova/bge-reranker-base` (q8) | ~110MB | — |
| Sparse / BM25 | Postgres ts_vector | **Sin cambio** (ya local) | — | — |
| LLM generación | OpenRouter | **Sin cambio** (única dependencia remota) | — | — |

Justificación de la elección de embeddings:
- `paraphrase-multilingual-MiniLM-L12-v2` es multilingüe (cubre español),
  384d, rápido en CPU y con mirrors ONNX disponibles para transformers.js.
- Opciones a probar en el benchmark (fase 6) si la calidad no alcanza:
  `BAAI/bge-m3` (1024d, más pesado) o modelos Spanish-only si existiera
  mirror ONNX (`hiems/BERTa-MiniLM-L6-v2-es` no tiene ONNX confirmado).

## 4. Diseño técnico

### 4.1 Dependencia

```bash
npm i @huggingface/transformers
```

- Transformers.js v3 (ESM-only), corre en Node/Electron con ONNX Runtime.
- Los modelos se descargan una vez a `~/.cache/huggingface/hub` (configurable
  vía `env.cacheDir`). Sin red después de la primera carga.
- Usar `dtype: "q8"` en CPU (los exports fp16 fallan en el execution provider
  CPU de onnxruntime-node).

### 4.2 Nuevo servicio: `LocalEmbeddingService`

- Misma interfaz que `EmbeddingService` (`generateEmbedding(text, dimensions?)`)
  para no tocar los consumidores (`ingestionPipeline.ts`, `iterativeRAGEngine.ts`,
  `ragEngine.ts`).
- `pipeline('feature-extraction', <modelo>, { dtype: 'q8', device: 'cpu' })`,
  pooling `'mean'`, `normalize: true`.
- Singleton con warm-up al arrancar (el cold load es lo más lento, ~380ms).

### 4.3 Reranker local

- Nueva estrategia `'local'` en `src/services/rerankingService.ts`.
- `AutoModelForSequenceClassification` + `AutoTokenizer`:
  concat `query + fragmento`, score = logits (o sigmoid), top-20 → top-7.
- Los modelos del catálogo ya traen cabecera de clasificación binaria
  (cross-encoder), compatible con transformers.js.

### 4.4 Config (`src/config/env.ts` + `.env.example`)

| ENV | Default | Efecto |
|---|---|---|
| `EMBEDDING_PROVIDER` | `gemini` | `local` usa LocalEmbeddingService; `gemini` conserva el actual |
| `EMBEDDING_MODEL` | `paraphrase-multilingual-MiniLM-L12-v2` | Modelo local a usar |
| `EMBEDDING_DIMENSIONS` | `384` | Dimensión del modelo local |
| `RERANKER_MODEL` | `SugoLabs/mmarco-mMiniLMv2-L12-H384-v1` | Cross-encoder local |
| `RAG_RERANK_STRATEGY` | `hybrid` | Se añade `local` a las opciones |

### 4.5 Migración `007_local_embeddings.sql`

- `embedding_base` → `vector(384)`
- `embedding_high` → `vector(384)`
- Recrear índices HNSW (el índice vectorial depende de la dimensión).
- Con 1 documento: re-ingesta vía el endpoint `/api/upload` existente.

## 5. Pasos de implementación

1. Instalar `@huggingface/transformers`.
2. Crear `src/services/localEmbeddingService.ts` (interfaz compatible).
3. Extender `rerankingService.ts` con estrategia `'local'`.
4. Factory de selección de provider en `src/index.ts` + knobs en `env.ts`.
5. Migración 007 + re-ingesta del documento.
6. Script de benchmark comparativo (`npm run eval:embeddings`):
   - Mismas queries del dominio, top-k con Gemini (1536d) vs local (384d).
   - Medir: hit-rate, score de similitud, latencia por query.
   - Decidir con datos si 384d alcanza o hay que subir a un modelo mayor.

## 6. Criterios de aceptación

- [ ] Query RAG completa funciona con `EMBEDDING_PROVIDER=local` y
      `RAG_RERANK_STRATEGY=local` sin ninguna llamada a Gemini.
- [ ] Benchmark documenta top-k local vs Gemini en las queries de prueba.
- [ ] Latencia de query no aumenta respecto a hoy (embed local ≈ 15ms).
- [ ] `EMBEDDING_PROVIDER=gemini` sigue funcionando (rollback trivial).
- [ ] Tests existentes de `embeddingService`/`iterativeRAGEngine` siguen pasando.

## 7. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Calidad semántica 384d insuficiente para jurisprudencia | Benchmark fase 6; subir a bge-m3 (1024d) si hace falta |
| Tamaño de descarga inicial del modelo | Una sola vez; se puede pre-cargar con el instalador |
| fp16 no soportado en CPU (onnxruntime-node) | Usar siempre `q8` en CPU |
| Cold load lento al primer query | Warm-up del pipeline al arrancar la app |

*Fin del plan.*
