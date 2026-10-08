# TASK: Auditoría de Arquitectura RAG y Plan de Evolución hacia Sistema Multi-Índice ("Cajas de Documentos")

## OBJETIVO
Necesito que audites nuestra implementación actual del sistema RAG (Retrieval-Augmented Generation) para identificar cómo gestionamos el indexado y la recuperación de documentos. 

Actualmente nos encontramos con el desafío de que al mezclar documentos normativos generales (leyes, decretos) con documentos de casos particulares o clientes en un mismo índice, la etapa de recuperación (*retrieval*) pierde precisión o requiere múltiples iteraciones para traer los fragmentos correctos.

Queremos evolucionar el sistema hacia un modelo de **"Cajas de Documentos" (Workspaces / Multi-Index RAG)**, donde cada "Caja" o colección represente un conjunto lógico de información (ej. "Caja Normativa General", "Caja Cliente/Expediente X", "Caja Jurisprudencia") y permita realizar búsquedas y comparaciones cruzadas entre cajas.

---

## FASE 1: AUDITORÍA DEL SISTEMA ACTUAL
Por favor, analiza el código base y responde brevemente:
1. **Indexación y Vector Store:** ¿Cómo se están almacenando los embeddings actualmente? (¿Usamos un único namespace/colección global o ya existe separación?).
2. **Metadata & Filtering:** ¿Qué metadatos estamos guardando con cada chunk de texto? (ej. `document_id`, `type`, `tenant_id`, `source_file`).
3. **Retrieval Pipeline:** ¿Cómo se ejecuta la query de búsqueda? ¿Se usa búsqueda vectorial pura, búsqueda híbrida (BM25 + Dense Vector), o Re-Ranking?
4. **Context Injection:** ¿Cómo construimos el prompt final que se le pasa al LLM?

---

## FASE 2: PLAN DE ARQUITECTURA Y EVOLUCIÓN (SI NO ESTÁ IMPLEMENTADO)
Si el sistema no soporta actualmente el aislamiento por "Cajas de Documentos" ni la búsqueda multi-índice, diseña un plan de implementación detallado con los siguientes aspectos:

### 1. Modelo de Datos y Abstracción de "Caja"
- Diseña el modelo/entidad para una **"Caja de Documentos" (Folder / Document Group / Collection)**.
- Define qué metadata mínima debe llevar cada chunk perteniente a una caja (ej. `box_id`, `box_type: [LAW | CASE | CONTRACT | INTERNAL_DOC]`, `visibility`, `version`).

### 2. Estrategia de Búsqueda Multi-Índice y Comparación Cruzada
Propón la mejor estrategia técnica para ejecutar consultas que comparen "Caja A" vs. "Caja B" (por ejemplo: *Hechos del Expediente X vs. Marco Legal Y*):
- **Opción A (Filtered Single-Index):** Un solo Vector Store con filtros duros en metadatos (`box_id IN [...]`).
- **Opción B (Multi-Collection Querying):** Consultas paralelas a diferentes colecciones e integración con *Reciprocal Rank Fusion (RRF)* o un *Re-Ranker* (ej. Cohere / BGE-Reranker).
- **Opción C (Two-Stage / Agentic Retrieval):** Un agente recupera primero los hechos de la "Caja del Caso" y luego usa esos hechos recuperados como query hacia la "Caja Normativa".

### 3. Cambios en la API y Contratos de Servicio
Define cómo deberían estructurarse las solicitudes hacia el endpoint de consulta (Payload JSON). Ejemplo:
```json
{
  "query": "Compara el reclamo del cliente contra los plazos legales",
  "target_boxes": [
    { "box_id": "expte-4092-2026", "role": "case_facts" },
    { "box_id": "ley-25326-decreto-1558", "role": "legal_framework" }
  ],
  "retrieval_strategy": "cross_comparison"
}