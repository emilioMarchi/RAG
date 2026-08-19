# Análisis técnico del flujo de consulta RAG

> Estado: documentación del funcionamiento ACTUAL (pre-optimización).
> Fuente: código en `src/` + `log.md` de una consulta real.
> Consulta de referencia en los logs: `"puntos del artículo 2"`.

---

## 1. Stack y servicios involucrados

| Componente | Archivo | Rol |
|---|---|---|
| `AgentService` | `src/agent/agentService.ts` | Orquesta el chat del agente |
| `AgentRouter` | `src/agent/agentRouter.ts` | Decide ruta chat / rag / list_docs |
| `AgentLLM` | `src/agent/agentLLM.ts` | Decide ruta vía LLM (router) |
| `AgentTools` | `src/agent/tools.ts` | Ejecuta RAG (`searchDocuments`) |
| `IterativeRAGEngine` | `src/services/iterativeRAGEngine.ts` | **Motor RAG principal** (agente + `/query/iterative`) |
| `HierarchicalRAGModule` | `src/services/ragEngine.ts` | Motor RAG simple (`/query/simple`) |
| `HybridSearchService` | `src/services/hybridSearchService.ts` | Búsqueda densa (pgvector) + léxica (BM25/ts + RRF) |
| `RerankingService` | `src/services/rerankingService.ts` | Re-ranking con LLM (cross-encoder) |
| `CRAGEvaluator` | `src/services/cragEvaluator.ts` | Evaluación Corrective RAG |
| `EmbeddingService` | `src/services/embeddingService.ts` | Embeddings Gemini (768d y 1536d) |
| `LLMService` | `src/services/llmService.ts` | Llamadas LLM (OpenRouter/OpenAI-compat) con retry/fallback |
| `ConversationMemory` | `src/agent/conversationMemory.ts` | Historias en memoria + resumen de turnos (rollover) |
| `QueryEvaluator` | `src/services/queryEvaluator.ts` | Evaluación de calidad en background (fire-and-forget) |

Punto de entrada HTTP:
- `POST /api/agent/chat` → `src/routes/agent.ts` (flujo usado en los logs)
- `POST /api/query/iterative` → `src/routes/query.ts` (mismo motor)

---

## 2. Cronología exacta de una consulta RAG (llamada a `IterativeRAGEngine.query`)

Corresponde al request `"puntos del artículo 2"` del `log.md`. **Todo es estrictamente serial** (await tras await), sin paralelismo.

### Fase A — Enrutamiento del agente (`AgentRouter.processQuery`)
1. `memory.getOrCreateSession` → pide system prompt en memoria (sin red).
2. `memory.getHistoryForLLM` → construye historial (sin red).
3. **LLM call #1** `agentLLM.decideRoute` → decide `intent=rag`, refina query. *(log: `[AgentRouter] Decision ... -> intent: rag`)*
4. `memory.addMessage` → guarda mensaje del usuario.

### Fase B — `IterativeRAGEngine.query` (vía `AgentTools.searchDocuments`)

**B1. Descomposición de query**
5. **LLM call #2** `llm.decomposeQuery` → devuelve 1 sub-query. *(log: `[DECOMPOSE DEBUG]... sub_queries: ["puntos del artículo 2"]`)*
6. Para cada sub-query (aquí 1):
   - **Embed call #1** `generateEmbedding(subQ, 768)` → filtrar documentos candidatos. *(log l.29)*
   - SQL: `SELECT id FROM documents ORDER BY embedding_base <=> $vec LIMIT topDocs(=5)`.
   - **Embed call #2** `generateEmbedding(subQ, 1536)` → búsqueda híbrida. *(log l.31)*
   - `hybridSearch.search` → **3–4 SQL**: vectorial + BM25 + (posible SELECT extra de hits BM25 faltantes).
7. `rrfMergeMultiQuery` (RRF) → fusiona rankings → 20 candidatos (maxContextParagraphs).

**B2. Re-ranking inicial**
8. **LLM call #3** `reranker.rerank` → `llm.rerankChunks` (LLM puntúa los 20 candidatos y devuelve top 7).  
   *(No hay log explícito de esto, pero ocurre: `finalTopK=7`, candidates=20 → 20>7 → SI ejecuta LLM.)*

**B3. Bucle iterativo de expansión de contexto** (`while iterations < RAG_MAX_ITERATIONS=4`)
9. `enrichWithParents` → 1 SQL (fetch `document_parent_chunks`).
10. **LLM call #4** `llm.evaluateContext` → devuelve `decision:"answer"`. *(log: `[EVALUATE DEBUG]`)*
11. Como `decision !== 'expand'` → `break`. (Si fuese `expand`, repetiría B3 hasta 4 veces, con `adjacentParagraphs` = más SQL.)

**B4. Corrective RAG (CRAG)**
12. **LLM call #5** `crag.evaluate` → devuelve `PARTIAL` + `reformulated_query`. *(log: `[CRAG] Decision: PARTIAL`)*
13. Como `PARTIAL`, ejecuta una **retrieval COMPLETA nueva** con la query reformulada `"definiciones completas del artículo 2..."`:
    - **Embed call #3** `generateEmbedding(reformulado, 768)` *(log l.40)*
    - SQL doc candidatos (768d).
    - **Embed call #4** `generateEmbedding(reformulado, 1536)` *(log l.42)*
    - `hybridSearch.search` (3–4 SQL).
    - **LLM call #6** `reranker.rerank` → `llm.rerankChunks` **(¡nuevo re-ranking LLM!)**.
    - `enrichWithParents` (1 SQL).
    - Merge con fuentes previas.
    - ➜ El log se corta aquí (l.43). Este es el punto donde el tiempo se dispara.

**B5. Respuesta final**
14. **LLM call #7** `llm.generateRAGAnswer` → genera el texto final con el contexto fusionado.

### Fase C — Post-procesamiento
15. `memory.addMessage('assistant', ragResult.content)` → guarda respuesta.
16. En `/query/iterative` además: `QueryEvaluator.recordAndEvaluate` → **fire-and-forget** (1 SQL + otra llamada LLM en background, NO bloquea al usuario).

---

## 3. Resumen de costos por consulta

**Llamadas a red EXTERNA por cada consulta RAG (serie):**

| # | Tipo | Fase | Propósito |
|---|---|---|---|
| 1 | LLM | A | Router de intención |
| 2 | LLM | B1 | Decomposición de query |
| 1 | Embed 768d | B1 | Filtro docs candidatos |
| 2 | Embed 1536d | B1 | Búsqueda híbrida |
| 3 | LLM | B2 | Re-ranking inicial (cross-encoder) |
| 4 | LLM | B3 | Evaluación de contexto (expansión) |
| 5 | LLM | B4 | Evaluación CRAG |
| 3 | Embed 768d | B4 | Re-búsqueda CRAG |
| 4 | Embed 1536d | B4 | Re-búsqueda CRAG |
| 6 | LLM | B4 | Re-ranking CRAG (duplicado) |
| 7 | LLM | B5 | Generación de respuesta final |

**Totales: 7 llamadas LLM + 4 llamadas Embedding (Gemini) + ~10–14 consultas SQL a Postgres**, todo secuencial.

SQL adicionales posibles por el bucle de expansión (B3) si el LLM pidiera `expand`:
hasta 4 iteraciones × (`adjacentParagraphs` + merge), duplicando SQL.

---

## 4. Cuello de botella principal: latencia de las llamadas LLM

El cuello de botella NO es la base de datos ni los embeddings; es la **cantidad de round-trips LLM en cadena** (7) contra un modelo free/barato de OpenRouter.

Detalles que agravan cada LLM call (`llmService.complete`, `src/services/llmService.ts`):
- Modelo default: `meta-llama/llama-3.3-70b-instruct:free` (tier free: **colas y RPM muy bajos** → latencia alta).
- Cada `complete` **recorre todos los modelos** si recibe 429 (rate limit): `[LLM_MODEL, ...LLM_BACKUP_MODEL]`.
- La mayoría de métodos envuelven la llamada en `withRetry`, `src/utils/retry.ts` con `baseDelay: 2000ms` y `maxRetries: 2–3`. Un solo rate-limit puede añadir **6s+ de espera** extra.
  - `decompose` (3 retries), `evaluateContext` (2), `generateRAGAnswer` (3), `rerankChunks` (2).
- No hay `timeout` explícito en el cliente OpenAI (usa el default del SDK), y sin streaming ni cancelación.

**Estimación para >1 minuto:** con 7 llamadas LLM en serie a un modelo free (5–30s cada una en best-effort), se explica fácilmente un tiempo total de 60–180s. El log se cortó justo en la re-búsqueda CRAG ($calls 5→6→7), que es la parte más costosa.

---

## 5. Otros hallazgos de ineficiencia

1. **CRAG duplica el pipeline.** Cuando la decisión no es `RELEVANT`, se repite el flujo completo `embed la 768d → embed 1536d → hybrid search → rerank LLM → enrich parents`. En la práctica casi dobla el costo (LLM #5, #6 y extra embeds). El prompt de CRAG es agresivo (los fragmentos están truncados a 300 chars, lo que incentiva `PARTIAL`).

2. **Doble embedding por query (768 + 1536).** `ragEngine` e `iterativeRAGEngine` generan **dos** embeddings para la MISMA cadena de texto. Los valores devueltos por Gemini en el log (l.30 vs l.32) son **idénticos**, lo que sugiere que `outputDimensionality` no está funcionando como se espera (el modelo devuelve los mismos valores numericos). El de 768 solo filtra 5 documentos candidatos; luego el de 1536 hacen la búsqueda real. Es una llamada extra a Gemini por cada sub-query y por cada re-búsqueda CRAG.

3. **Re-ranking con LLM muy caro y repetido.** Se usa el LLM como cross-encoder (`rerankChunks`), llamada costosa, y se ejecuta **2 veces** en el camino CRAG (inicial + reformulado). Se podría reemplazar por un reranker matemático (p.ej. ${maxsim} con embeddings local, MMP, o simplemente usar más RRF) para quitar 2 de las 7 llamadas LLM.

4. **Pipeline redundante en queries simples.** La query `"puntos del artículo 2"` produce **1 sola sub-query** idéntica al original, y aun así se pagan los LLM de `decompose` + `rerank` + `evaluate` + `crag`. Decompose añade una llamada LLM sin aportar nada cuando no hay descomposición.

5. **Bucles sin límite temporal claro.** `maxIterations=4` en expansión, y CRAG puede re-buscar; no hay un presupuesto de latencia global ni métrica de corte por tiempo.

6. **`ConversationMemory` guarda la respuesta RAG completa** en memoria (puede ser larga) y la reenvía en el `historyText` del router en cada turno → aumenta el input del LLM del router.

---

## 6. Mapa de archivos relevantes (para referencia al optimizar)

| Responsabilidad | Archivo / líneas |
|---|---|
| Orquesta chat + decide ruta | `src/agent/agentRouter.ts:29` |
| Disparo RAG desde el agente | `src/agent/tools.ts:37` |
| Motor RAG iterativo (decompose+rerank+expand+CRAG+answer) | `src/services/iterativeRAGEngine.ts:39-198` |
| Motor RAG simple | `src/services/ragEngine.ts:59-118` |
| Búsqueda híbrida (vector+BM25+RRF) | `src/services/hybridSearchService.ts:86-179` |
| Re-ranking con LLM | `src/services/rerankingService.ts:21`, `src/services/llmService.ts:315` |
| CRAG | `src/services/cragEvaluator.ts:23` |
| Decomposición de query | `src/services/llmService.ts:254` |
| Generación de respuesta | `src/services/llmService.ts:217` |
| Embeddings (768/1536) | `src/services/embeddingService.ts:8` |
| LLM con retry/fallback | `src/services/llmService.ts:26-47`, retry en `src/utils/retry.ts` |
| Config knobs | `src/config/env.ts:37-44` |
| Endpoint HTTP | `src/routes/query.ts:18` y `src/routes/agent.ts:11` |

---

## 7. Knobs de configuración existentes (para mitigar sin tocar código)

`src/config/env.ts`:

| ENV | Default | Efecto |
|---|---|---|
| `RAG_MAX_ITERATIONS` | `4` | Cota el bucle de expansión (B3) |
| `RAG_RERANK_STRATEGY` | `hybrid` | `llm` vuelve al cross-encoder (más preciso, +LLM calls #3/#6) |
| `RAG_ENABLE_RERANKING` | `true` | Si `false`, elimina todo re-ranking (híbrido o LLM) |
| `RAG_CRAG_MAX_PASSES` | `0` | Pases de re-búsqueda CRAG (0 = off → elimina LLM #5/#6 + embeds) |
| `RAG_ENABLE_CONTEXT_EXPANSION` | `false` | `true` = evalúa y expande contexto con LLM (añade una llamada LLM que puede colgarse con free) |
| `RAG_ENABLE_DECOMPOSE` | `true` | `false` = nunca descomponer (quita LLM #2 en queries multi-intención) |
| `RAG_TIMEOUT_MS` | `45000` | Presupuesto global de latencia (0 = ilimitado) |
| `RAG_RATE_LIMIT_RETRY_MS` | `10000` | Espera por reintento ante 429 (bajo = menos colgues con free) |
| `LLM_MODEL` / `LLM_BACKUP_MODEL` | free llama | Cambiar a un modelo de pago con baja latencia |
| `AGENT_TOP_DOCS` | `5` | Nº documentos candidatos |

Con los defaults actuales (`hybrid` + `CRAG off` + sin expansión) el pipeline queda en
**2 LLM calls (router + answer) + 1 embed**, con `RAG_RATE_LIMIT_RETRY_MS=10000` para
evitar esperas ciegas ante rate-limit de modelos free.

---

## 8. Recomendaciones de optimización (en orden de impacto)

1. **Desactivar/parametrizar CRAG** (ELIMINA el reprocesamiento completo). Es la mayor fuente de latencia: LLM #5, #6 + embeds 3 y 4.
2. **Eliminar el re-ranking vía LLM**, o hacerlo con un modelo open/local matemático en vez de una chat completion. Quita LLM #3 y #6.
3. **Eliminar la doble embed** (768+1536) usando un solo embedding 1536d para filtro y búsqueda. Quita 1 embed por sub-query y 1 por re-búsqueda.
4. **Hacer el pipeline en paralelo** donde se pueda (e.g. embeddings de sub-queries en `Promise.all`).
5. **Meter un presupuesto global de latencia** (p.ej. hard timeout a 15–20s) para evitar esperas de minutos.
6. **Simplificar decompose**: si la query refina a sí misma / 1 sub-query, saltar la llamada LLM.
7. **Reemplazar el prompt de CRAG** para que no sea tan propenso a `PARTIAL` (mostrar más contexto real, no 300 chars truncados).
8. Usar un **modelo de pago** con baja latencia en `LLM_MODEL` si la latencia aguda lo permite.

---

*Fin del documento.*

---

## Apéndice — Optimizaciones implementadas (estado actual)

Las secciones anteriores describen el flujo original. A continuación, el estado
post-refactor y las ganancias esperadas de latencia.

### Cambios aplicados por archivo

| Archivo | Cambio |
|---|---|
| `src/services/rerankingService.ts` | Nueva estrategia `'hybrid'` (determinista, sin LLM) como default. `'llm'` opcional. |
| `src/services/iterativeRAGEngine.ts` | · Se elimina el filtro de documentos 768d (ya no hay `SELECT ... FROM documents`).<br>· Un solo embedding 1536d por sub-query.<br>· Sub-queries procesadas en paralelo (`mapConcurrent`).<br>· CRAG con presupuesto `cragMaxPasses` (bucle).<br>· `enableDecompose` para saltar descomposición.<br>· Timeout global (`QueryTimeoutError`). |
| `src/services/hybridSearchService.ts` | `docIds=[]` = buscar en TODOS los párrafos (sin filtro `document_id`). |
| `src/services/llmService.ts` | · Guard heurístico en `decomposeQuery` (evita el LLM en queries atómicas).<br>· Timeout por llamada (60s) en el cliente OpenAI. |
| `src/services/cragEvaluator.ts` | Prompt muestra el **contexto completo** (antes 300 chars truncados) → menos falsos `PARTIAL`. |
| `src/config/env.ts` | Nuevos knobs: `RAG_RERANK_STRATEGY`, `RAG_CRAG_MAX_PASSES`, `RAG_ENABLE_DECOMPOSE`, `RAG_TIMEOUT_MS`. |
| `src/index.ts` | Conecta los nuevos knobs al motor iterativo. |

### Costos por consulta (antes → después, con defaults)

| Recurso | Antes | Después (default `hybrid`/`CRAG off`/sin expansión) |
|---|---|---|
| Llamadas LLM en serie | 7 | **2** (router + answer) |
| Embeddings Gemini | 4 | **1** (1536d) por sub-query; sub-queries en paralelo |
| Re-ranking vía LLM | 2× | **0** |
| SQL Postgres | ~10–14 | ~4–6 |
| Riesgo de espera >1 min | alto | controlado por `RAG_TIMEOUT_MS` + `RAG_RATE_LIMIT_RETRY_MS` |

Para máxima precisión (a costa de tiempo): `RAG_RERANK_STRATEGY=llm`,
`RAG_CRAG_MAX_PASSES=1` y `RAG_ENABLE_CONTEXT_EXPANSION=true`, idealmente con un
modelo de pago de baja latencia.

*Fin del apéndice.*