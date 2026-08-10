# Plan de Implementación: RAG Avanzado

> Basado en el archivo `nueva-implementacion` del proyecto

## Estado actual del sistema

El sistema RAG actual tiene:
- **Búsqueda jerárquica 2 capas**: embedding 768d (docs) + 1536d (párrafos)
- **IterativeRAGEngine**: descomposición de queries + expansión iterativa de contexto
- **ChunkingService**: extracción de texto de PDF, DOCX, TXT, XML con OCR fallback
- **LLMService**: enrichChunk, evaluateContext, generateRAGAnswer, decomposeQuery

---

## Tareas a Implementar

### Task 1 — Búsqueda Híbrida (Vectorial + BM25)

**Problema**: La búsqueda puramente vectorial no recupera bien códigos, IDs, fechas o montos exactos.

**Solución**:
- Implementar `HybridSearchService` combinando:
  - **Dense retrieval**: embeddings existentes (768d y 1536d)
  - **Sparse retrieval / BM25**: búsqueda léxica sobre `raw_content` usando `ts_vector` + GIN de Postgres (sin dependencias externas)
- Fusionar rankings con **Reciprocal Rank Fusion (RRF)**, pesos `[0.6 vectorial + 0.4 BM25]`

**Archivos**:
| Acción | Archivo |
|--------|---------|
| ✨ Crear | `src/migrations/002_bm25_indexes.sql` |
| ✨ Crear | `src/services/hybridSearchService.ts` |
| ✏️ Modificar | `src/services/ragEngine.ts` |
| ✏️ Modificar | `src/services/iterativeRAGEngine.ts` |

---

### Task 2 — Re-ranking con Cross-Encoder (vía LLM)

**Problema**: Los top-K del retriever no siempre son los más relevantes para la query final.

**Solución**:
- Recuperar `top_k = 20` fragmentos del retriever inicial
- Puntuar cada fragmento con el LLM (cross-encoder scoring en un único batch)
- Seleccionar los **top 6–8** con mayor score de relevancia cruzada para el prompt final

**Archivos**:
| Acción | Archivo |
|--------|---------|
| ✨ Crear | `src/services/rerankingService.ts` |
| ✏️ Modificar | `src/services/llmService.ts` — agregar `rerankChunks()` |
| ✏️ Modificar | `src/services/ragEngine.ts` — integrar re-ranking |
| ✏️ Modificar | `src/services/iterativeRAGEngine.ts` — integrar re-ranking |

---

### Task 3 — Chunking Jerárquico Parent-Child

**Problema**: Los chunks pequeños pierden el contexto global de la sección a la que pertenecen.

**Solución**:
- **Child Chunks** (para búsqueda): 300–500 chars, usados para vectorizar y rankear
- **Parent Chunks** (para generación): 1200–2000 chars, entregados al LLM como contexto real
- Al encontrar un Child relevante → recuperar su Parent completo para el prompt

**Archivos**:
| Acción | Archivo |
|--------|---------|
| ✨ Crear | `src/migrations/003_parent_chunks.sql` |
| ✏️ Modificar | `src/services/chunkingService.ts` — agregar `splitHierarchical()` |
| ✏️ Modificar | `src/services/ingestionPipeline.ts` — almacenar parent chunks |
| ✏️ Modificar | `src/services/ragEngine.ts` — al recuperar hijos, traer su parent |

---

### Task 4 — Sub-queries / Multi-Query (mejora del existente)

**Estado**: `IterativeRAGEngine` ya descompone queries con `llm.decomposeQuery()`. Falta:
- Mejorar la fusión de resultados multi-query con **RRF** (actualmente es solo concat + dedup)
- Hacer el engine iterativo la ruta **por defecto** en lugar de opcional

**Archivos**:
| Acción | Archivo |
|--------|---------|
| ✏️ Modificar | `src/services/iterativeRAGEngine.ts` — fusión RRF multi-query |
| ✏️ Modificar | `src/routes/query.ts` — engine iterativo como default |

---

## Criterios de Aceptación

1. **Test de cruce de fuentes**: query que requiere 2 archivos distintos → contexto incluye fragmentos de ambos documentos
2. **Test de dato exacto**: query con un código, fecha o monto específico → BM25 lo recupera correctamente  
3. **Test de faltante de contexto**: pregunta sin información en los archivos → el sistema declara ausencia sin inventar

---

## Orden de Implementación

```
[1] ✅  Migration: BM25 indexes (GIN + ts_vector)
[2] ✅  HybridSearchService
[3] ✅  Integrar Hybrid en ragEngine
[4] ✅  Integrar Hybrid en iterativeRAGEngine (RRF multi-query)
[5] ✅  LLMService: rerankChunks()
[6] ✅  RerankingService
[7] ✅  Integrar Re-ranking en query pipeline
[8] ✅  Migration: parent_chunks table
[9] ✅  ChunkingService: splitHierarchical()
[10] ✅ IngestionPipeline: almacenar parent chunks
[11] ✅ RagEngine: recuperar parent chunks al hacer query
[12] ✅ /query usa engine iterativo por defecto
[13]    Correr migración en DB + smoke test manual
```

---

## Progreso

| # | Tarea | Estado |
|---|-------|--------|
| 1 | Migration BM25 (GIN + ts_vector) | ✅ Completo |
| 2 | HybridSearchService | ✅ Completo |
| 3 | Integrar Hybrid en ragEngine | ✅ Completo |
| 4 | Integrar Hybrid en iterativeRAGEngine | ✅ Completo |
| 5 | LLMService: rerankChunks | ✅ Completo |
| 6 | RerankingService | ✅ Completo |
| 7 | Integrar Re-ranking en query pipeline | ✅ Completo |
| 8 | Migration parent_chunks table | ✅ Completo |
| 9 | ChunkingService: splitHierarchical | ✅ Completo |
| 10 | IngestionPipeline: parent chunks | ✅ Completo |
| 11 | RagEngine: recuperar parent chunks | ✅ Completo |
| 12 | RRF multi-query en iterativeRAGEngine | ✅ Completo |
| 13 | Correr migraciones en DB + smoke test | ⬜ Pendiente |
