# Plan: Agente Conversacional con Arnés sobre RAG (TypeScript)

> **App de referencia:** `D:/Emi/apps/eva-harness` (agente en Python, patrón a portar — ver sección 12)

## 1. Objetivo

Convertir el chat de `/api/query/iterative` (monolítico, sin memoria) en un **agente conversacional con arnés**: mantiene memoria del hilo y **decide por turno** si responde con conocimiento propio o si invoca el flujo RAG como herramienta. Se mantiene sobre modelos free de OpenRouter y aprovecha los fixes de latencia ya identificados.

## 2. Arquitectura objetivo

```
POST /api/agent/chat { query, sessionId }
        │
        ▼
 ┌─────────────────────────┐
 │ AgentRouter             │  ← arnés (porta el patrón RouterAgent de eva-harness)
 │ 1. leer memoria (hilo)  │
 │ 2. LLM: decisión JSON   │  1 llamada
 │    { intent: 'chat'|'rag'|'tool', ... }
 └───────┬──────────┬──────┘
   chat  │          │  rag / tool
         ▼          ▼
  directo      Invoca tool 'search_documents'
  (sin RAG)    └─ IterativeRAGEngine (adelgazado)
                  + reinyecta resultado en memoria
        │
        ▼
  guardar respuesta en memoria → responder (con fuentes si hubo RAG)
```

## 3. Decisión clave: ruteo por **JSON**, no tool-calling nativo

`eva-harness` usa tool-calling nativo de Gemini. Para modelos free de OpenRouter usaremos **`response_format: {type:'json_object'}`** (que ya usa tu `LLMService`) para que el LLM devuelva una decisión estructurada:

```json
{ "intent": "rag", "query": "query reformulada", "conversational": false }
```

**Por qué**: más confiable y barato en free (algunos modelos free no soportan function-calling bien), y es 1 sola llamada. El flujo RAG pesado se invoca desde Node, no como tool nativo.

## 4. Nuevos módulos (no toca lo existente)

| Archivo | Propósito |
|---|---|
| `src/agent/conversationMemory.ts` | Memoria multi-turno (rollover, resumen, persistencia opcional) |
| `src/agent/agentRouter.ts` | Arnés: arma contexto, llama LLM, decide intent, orquesta |
| `src/agent/tools.ts` | Registro de herramientas: `search_documents` (+ `list_documents`) |
| `src/agent/prompts.ts` | System prompt del agente + prompt de decisión (intent) |
| `src/agent/agentService.ts` | Orquesta sesiones: obtiene memoria, corre router, persiste |
| `src/routes/agent.ts` | `POST /api/agent/chat` y `POST /api/agent/reset` |
| `src/services/agentLLM.ts` | Envoltorio sobre `LLMService` para decisión + chat directo + resumen |

## 5. Flujo del arnés (`agentRouter`)

1. **Leer memoria** de la sesión (si no existe, crear + inyectar system prompt).
2. **Construir prompt de decisión**: últimos N turnos + query actual → `LLMService.complete` con `json_object`.
3. **Decidir**:
   - `chat` → responder directamente con contexto conversacional (1 llamada).
   - `rag` → llamar `search_documents` (engine RAG adelgazado) → armar respuesta final con fuentes.
   - `tool` (futuro) → otras herramientas.
4. **Guardar** user + assistant en memoria.
5. **Responder** `{ answer, sources?, intent }`.

## 6. Memoria conversacional (`conversationMemory`)

- Almacenada en memoria por sesión (Map), con **persistencia opcional** en Postgres (`agent_sessions` / `agent_messages`).
- **Rollover**: mantener últimas ~10-15 mensajes; resumir los viejos con LLM (reusa patrón `_maybe_summarize` de `history.py`).
- `sessionId` proviene del frontend (se genera una por cliente y se guarda en `localStorage`).

## 7. Fixes de latencia que se aplican

Al exponer RAG como tool, usar `IterativeRAGEngine` con opciones más livianas (configurables en `.env`):
- `RAG_MAX_ITERATIONS=1` (hoy 4) — corta el bucle impredecible.
- `RAG_ENABLE_RERANKING=true` pero con pool más chico, o `false` en modo rápido.
- `RAG_ENABLE_CRAG=false` por defecto (fallback opcional).
- Mejorar la condición de corte en `iterativeRAGEngine.ts:145` (bug de `previousCount`).

Esto reduce el RAG de 5-8 llamadas LLM a ~2-3, y el agente suma 1-2 más de decisión/chat.

## 8. API y frontend

- **Nueva ruta** `POST /api/agent/chat` con `{ query, sessionId }` → `{ answer, sources?, intent, sessionId }`.
- **Frontend** (`public/app.js`): `sendChat()` pasa a llamar `/api/agent/chat`, envía `sessionId` (localStorage), y conserva el render de fuentes (`renderAnswer` + `buildCitationLabels` ya sirven). Añadir botón "Nueva conversación" → `POST /api/agent/reset`.
- Se mantiene `/api/query/iterative` intacto como respaldo/pruebas.

## 9. Configuración `.env`

```
AGENT_SESSION_TTL_HOURS=8
AGENT_MAX_TURNS=12
AGENT_MEMORY_PERSIST=sqlite|postgres|none
RAG_MAX_ITERATIONS=1
RAG_ENABLE_RERANKING=false
RAG_ENABLE_CRAG=false
```

## 10. Testing

- `conversationMemory.test.ts`: rollover, resumen, persistencia.
- `agentRouter.test.ts`: mock del LLM → decisiones `chat` vs `rag` correctas; integración con un fake del engine.
- `tools.test.ts`: `search_documents` devuelve fuentes y respeta límites.

## 11. Fases de implementación (orden de entrega)

1. `conversationMemory` + tests.
2. `prompts` + `agentLLM` (decisión JSON + chat directo + resumen).
3. `tools` (envuelve `IterativeRAGEngine`) + `agentRouter`.
4. `routes/agent.ts` + `agentService` + tests.
5. Frontend: switch a `/api/agent/chat` + `sessionId`.
6. Fix del corte iterativo + ajustes de latencia (`env`).
7. Persistencia en Postgres (opcional, después de que funcione en memoria).

## 12. Referencia: `eva-harness` (`D:/Emi/apps/eva-harness`)

Este plan **porta el patrón** del agente de referencia, no lo ejecuta tal cual (está en Python y atado a Gemini).

Piezas de `eva-harness` que se traducen a TypeScript:

| `eva-harness` (Python) | Este plan (TS) |
|---|---|
| `internal/agents/router.py` → `RouterAgent` (decide respuesta directa vs deploy) | `src/agent/agentRouter.ts` (decide `chat` vs `rag`) |
| `pkg/memory/history.py` → `ConversationMemory` (multi-turno + resumen) | `src/agent/conversationMemory.ts` |
| `pkg/memory/context_builder.py` → READ snapshot | Prompt de decisión con contexto del hilo |
| `pkg/executor/base.py` → `BaseExecutor` (tool schemas + execute) | `src/agent/tools.ts` |
| `pkg/provider/base.py` → `BaseProvider` (abstracción LLM) | `src/services/agentLLM.ts` sobre `LLMService` (OpenRouter free) |
| `PLAN_HIBRIDO.md` → arquitectura "capa ligera que rutea a flujo pesado" | Sección 2 de este plan |

**Cambios vs la referencia:**
- Provider: Gemini → OpenRouter free.
- Ruteo por tool-calling nativo → `response_format: json_object` (más robusto en free).
- `max_iterations` (15/5) → 1-3 vueltas por turno (inviable en free con loops largos).
- Se descarta shell/recorder/commissions/voice (no aplican a un RAG).

## 13. Riesgos / decisiones abiertas

- **¿Tool-calling nativo vs JSON?** Elijo JSON por robustez en free; si luego quieres tool-calling, la abstracción `tools.ts` ya lo soporta.
- **Persistencia**: empiezo en memoria (sesión por cliente vía `sessionId`); Postgres es fase 7. Al reiniciar el server se pierden los hilos.
- **Modelo del agente**: mismo free que el RAG para no multiplicar costos; se puede diferenciar con `AGENT_MODEL`.
- **Reranking**: lo dejo configurable; en free por defecto `false` para velocidad, activable al pasar a pago.

## 14. Estado de Implementación y Resumen de Tareas Realizadas

Todas las fases clave han sido implementadas de manera exitosa:

1. **Memoria Conversacional (`src/agent/conversationMemory.ts`) [Completado]**:
   * Implementada la gestión en memoria de sesiones multi-turno basadas en `sessionId`.
   * Integrado el soporte para **rollover** y resumen automático de los turnos más antiguos mediante el LLM al superar el límite (`maxTurns`).
   * Añadido el método `getMessages` para recuperar el historial conversacional.

2. **Ruteador del Agente y Prompts (`src/agent/prompts.ts`, `src/agent/agentLLM.ts`, `src/agent/agentRouter.ts`) [Completado]**:
   * Creados los system prompts de personalidad y el prompt estructurado para la decisión de ruta.
   * Creado `AgentLLM` para manejar el completado conversacional directo (`generateChatResponse`) y la decisión del enrutador por JSON (`decideRoute`), con defensas robustas ante respuestas incompletas de proveedores gratuitos de OpenRouter.
   * Creado `AgentRouter` como el arnés de control para evaluar la query, decidir el intent (`chat` o `rag`) y guardar las interacciones.

3. **Herramientas e Integración de RAG (`src/agent/tools.ts`, `src/agent/agentService.ts`) [Completado]**:
   * Envuelto `IterativeRAGEngine` como la herramienta principal `searchDocuments`.
   * Creado `AgentService` como el orquestador global e interfaz de servicios para los endpoints.

4. **Exposición de API y Servidor (`src/routes/agent.ts`, `src/index.ts`) [Completado]**:
   * Creadas las rutas `POST /api/agent/chat`, `POST /api/agent/reset` y `GET /api/agent/history`.
   * Registrado e inicializado el servicio del agente y su router en el archivo principal `src/index.ts`.

5. **Interfaz de Frontend (`public/index.html`, `public/app.js`) [Completado]**:
   * Agregado el botón visual **"Nueva Conversación"** en los controles del chat.
   * Vinculado el chat a `/api/agent/chat` usando una `sessionId` guardada en `localStorage`.
   * Implementada la función `loadAgentHistory()` en el inicio del frontend, permitiendo la persistencia visual de la conversación tras recargar o refrescar el navegador.
   * Conectado el botón de reinicio para limpiar visualmente el chat y llamar a `/api/agent/reset`.

