# Ingesta y Técnica de Chunking — Guía técnica para agentes

Este documento describe el pipeline de **ingesta de documentos de texto** y la técnica de **generación de chunks** del sistema RAG. Está pensado para que otro agente entienda el diseño e implementación sin necesidad de leer el código completo.

**Fuentes de referencia:** `src/services/chunkingService.ts`, `src/services/chunkingStrategies.ts`, `src/services/chunking/boundaryDetector.ts`, `src/services/chunking/normativeContext.ts`, `src/services/ingestionPipeline.ts`, `src/strategyDetector.ts` (verificar ruta real: `src/services/strategyDetector.ts`), `src/routes/documents.ts`, `PLAN_CHUNKING_ESTRUCTURAL.md`.

---

## 1. Visión de conjunto

El sistema implementa un chunking **jerárquico Parent-Child**:

- **Parent chunks**: bloques grandes (contexto completo para el LLM).
- **Child chunks**: sub-fragmentos de cada parent, optimizados para embedding, con metadatos de ubicación (`location`) y contexto (ruta normativa).

La división es **estructura-aware** (respeta fronteras naturales del documento: encabezados, artículos, párrafos, numeración, páginas) con **solape (overlap)** opcional y un hook adaptativo por densidad (`sizeFor`). El tamaño se mide en **caracteres**, no en tokens.

Tipos de documento soportados: **PDF** (con fallback OCR local), **DOCX**, **TXT**, **Markdown** y **XML**.

---

## 2. Pipeline de ingesta

### 2.1 Entrada — `POST /api/upload`

`src/routes/documents.ts:19`

1. `documents.ts:26-37` — Construye metadatos: `title`, `mimeType`, `chunkingMetadata` con `chunkingStrategy` (default `'auto'`), `domain`, `fileType`, `fileExtension`, `overlapChars` (opcional) y `adaptive` (bool).
2. `documents.ts:39-41` — Escribe el buffer a un archivo temporal `temp_<ts>_<name>`.
3. `documents.ts:45-51` — Extrae texto según MIME:
   - **PDF** → `extractPDFPages(tempPath)` → `buildFlatText(pdfPages)`.
   - **Otros** → `extractText(tempPath, mimeType)`.
4. `documents.ts:61-69` — Delega en `pipeline.processAndStoreDocument({...})`.
5. `documents.ts:52` — Borra el archivo temporal.

`ChunkingService` se instancia una vez en `src/index.ts:34` e `IngestionPipeline` en `src/index.ts:35`.

### 2.2 Extracción de texto por tipo — `extractText` (`src/services/chunkingService.ts:115-135`)

- `.pdf` → `extractPDF` → `extractPDFPages` → `buildFlatText`.
- `.docx` → `extractDOCX` (usando **mammoth**).
- `.txt` / `.md` → lectura UTF-8 directa (`extractTXT`).
- `.xml` → `extractXML`: elimina comentarios/CDATA/doctype y tags.
- Otro → `throw 'Unsupported file type...'`.

### 2.3 PDF — el caso más complejo (`extractPDFPages`, `chunkingService.ts:230-267`)

- Usa **pdfjs-dist**; construye `PdfPage { pageNumber, text, items, ranges }` con bounding boxes normalizados 0..1.
- **Fase 0 — sanitización de layout** (`sanitizeLayout`:306-332): descarta header/footer repetidos en ≥3 páginas (`LAYOUT_MIN_REPEAT_PAGES=3`, ratios 0.12).
- **Fallback OCR local** (`chunkingService.ts:262-265`): si el texto sin espacios < `MIN_OCR_TEXT_LENGTH=20`, usa **pdf-to-img + tesseract.js** (`OCR_LANG='spa'`, `OCR_SCALE=2`, `OCR_MAX_PAGES=60`). Las páginas OCR no llevan items/ranges.

### 2.4 Orquestación transaccional — `processAndStoreDocument` (`src/services/ingestionPipeline.ts:38-248`)

Todo bajo una transacción SQL (`BEGIN`).

1. Subida a storage (`storage.uploadFile`).
2. **Vector base 768d** del documento completo (`generateEmbedding(fullContentText, 768)`).
3. Persistir `documents` (`content`, `r2_key`, `r2_url`, `mime_type`, `embedding_base`).
4. **Chunking jerárquico** (paso clave, ver §3).
5. Persistir parents en `document_parent_chunks`.
6. Por child, **en paralelo** (`mapConcurrent`, `INGESTION_CONCURRENCY` default 2):
   - Prefiere `child.extendedText ?? child.text` y antepone `child.contextPath`.
   - `llm.enrichChunk(...)` → textos contextualizados + keywords + categoría.
   - `generateEmbedding(ctxText, 1536)` → **vector high 1536d**.
   - Graph RAG (si `INGESTION_ENABLE_GRAPH_RAG`): `extractEntitiesAndRelations`.
   - **Resiliencia**: un child fallido se descarta sin abortar la ingesta.
7. Persistir children en `document_paragraphs` (con `raw_content`, `contextualized_text`, `metadata` JSONB con `keywords/category/location/contextPath`, `embedding_high`, `parent_chunk_id`).
8. Graph RAG: entidades en `document_entities` (dedup por documento) y `entity_relations`.
9. `COMMIT` / `ROLLBACK` según éxito.

---

## 3. Técnica de chunking en detalle

### 3.1 Modelo de datos (`chunkingService.ts:84-112`)

```ts
ChildChunk  { parentIndex, childIndex, text, extendedText?, contextPath?, coreStartChar?, coreEndChar?, location }
ParentChunk { parentIndex, text, startChildIndex, endChildIndex, location }
```

### 3.2 Función principal — `splitHierarchical` (`chunkingService.ts:465-517`)

Defaults: `parentMaxChars=1800`, `childMaxChars=450`, `childMinChars=80`.

1. `splitSlices(text, parentMaxChars, mimeType, sizeFor)` → parents (con offsets).
2. Por parent, `splitSlices(parentSlice.text, childMaxChars, ...)` → children, y `coalesceMin(rawChildSlices, childMinChars)` (`:690-713`) que **fusiona fragmentos cortos** (ej. un "ARTICULO 1°" aislado) con el siguiente en vez de descartarlos.
3. Asigna índices y `location`; cierra el parent con `startChildIndex/endChildIndex`.

### 3.3 Dispatcher — `splitSlices` (`chunkingService.ts:715-737`)

- **PDF** → `splitPDF` + `groupBlocks` (offsets aproximados).
- **General** → `splitStructural(text, maxChars, { sizeFor })`.

### 3.4 Corte estructura-aware — `splitStructural` (`chunkingService.ts:746-790`)

- Segmentos vía `sliceByBoundaries(text, detectBoundaries(text))`.
- Acumula bloques en un `buffer` hasta superar `maxChars` por segmento → `flush()`.
- **`sizeFor` adaptativo** (`:771`): `const segMax = sizeFor ? sizeFor({ text: seg.text }) : maxChars;`.
- Si un **único segmento excede su tope** (ej. un ARTÍCULO gigante) → `sliceOversized`.

### 3.5 Fallback por oración/línea — `sliceOversized` (`chunkingService.ts:842-876`)

`cutPoint` prefiere, en orden:
1. último `\n` → 2. último final de frase `[.;:!?]` (usa `lastIndexOf` para no partir tras encabezados cortos) → 3. último espacio → 4. corte duro a `maxChars`.

### 3.6 Detector de fronteras — Fase 1 (`src/services/chunking/boundaryDetector.ts:48-91`)

`detectBoundaries(text, opts)` devuelve `BoundaryMatch[]` con `kind: 'heading' | 'numbered' | 'paragraph' | 'list' | 'page'`.

Señales:
- **Párrafos**: regex `\n[ \t]*\n+`.
- **Páginas**: form-feed `\f`.
- **Líneas estructurales**:
  - `NUMERIC_LINE_RE = /^\s*(?:\d{1,4}[.)]|[ivxlcdmIVXLCDM]+[.)]|art(?:ículo|iculo)?\.?\s*\d+)/` → `numbered`.
  - `HEADING_RE = /^#{1,6}\s+/` y `PDF_HEADING_RE` → `heading`.
  - `LIST_LINE_RE = /^\s*(?:[-*•·])\s+/` → `list`.

En el mismo offset gana la categoría más específica (`KIND_RANK`: `numbered`=5 > `heading`=4 > `list`=3 > `paragraph`=2 > `page`=1).

### 3.7 Overlap — Fase 3 (`src/services/chunkingStrategies.ts:272-288`)

```ts
const extendedText = overlapChars > 0
  ? prepared.text.slice(Math.max(0, loc.startChar - overlapChars), loc.endChar)
  : ch.text;
```

- El texto **con solape** se guarda en `extendedText` (solo para enriquecer/vectorizar).
- El fragmento publicado (`text`/`location`) se mantiene como **núcleo sin solape** (Fase 5).
- Default global `OVERLAP_DEFAULT_CHARS = 80` (sobrescribible por request). En `splitWithStrategy` default es `0`.

### 3.8 Contexto normativo (AST) — Fase 6 (`src/services/chunking/normativeContext.ts`)

- `normativeOutline(text)`: escanea líneas con `LEVEL_PARSERS` (`ley`, `decreto`, `titulo`, `capitulo`, `seccion`, `articulo`, `inciso`).
- `outlinePathAt(nodes, offset)`: devuelve la cadena de ancestros, ej. `"LEY 27.541 > TITULO II > ARTICULO 14"` usando `LEVEL_RANK`.
- En `splitWithStrategy` se reconstruye el outline solo si la estrategia es **legal** y se asigna `contextPath` a cada child (luego se antepone al enriquecer).

### 3.9 Estrategias por dominio (`src/services/chunkingStrategies.ts`)

| Estrategia | `parentMaxChars` | `childMaxChars` | `childMinChars` |
|---|---|---|---|
| **Generic** (`:64-75`) | 1000 | 450 | 80 |
| **Legal** (`:82-155`) | 1500 | 600 | 100 (tiene `clean` = `cleanWithMap`) |

- `cleanWithMap` une palabras cortadas por salto de página (`perso-\nnales` → `personales`) y convierte saltos de línea simples en espacio, produciendo un **mapa de offsets** `index(prep → orig)`.
- `splitWithStrategy` usa `locateOnOriginal` (`chunkingService.ts:550-575`) para recalcular `pageNumber/startLine/endLine/boundingBoxes` hacia el documento original.

### 3.10 Selección de estrategia — `resolveChunkingStrategy` (`chunkingStrategies.ts:207-231`)

1. **Manual**: `'legal'`, `domain==='legal'`, `fileType==='pdf_normativo'` o regex `/ley|norma|decreto|regulaci/i` → **Legal**; `'generic'` o `domain==='general'` → **Generic**.
2. **Auto**: si `'auto'` → `StrategyDetector().detect(text)`.
3. **Compatibilidad**: `ChunkingStrategySelector.getStrategy(metadata)`.

`StrategyDetector.detect` (`src/services/strategyDetector.ts:36-68`): heurística con señales léxicas (‑ Lexical weight 5, locuciones +3) y estructural (proporción de líneas con numeración, weight 30); umbral `LEGAL_THRESHOLD=14`.

---

## 4. Parámetros de configuración

### 4.1 Constantes (código)

- `splitHierarchical` defaults: parent 1800 / child 450 / childMin 80.
- `OVERLAP_DEFAULT_CHARS = 80` (ingesta).
- PDF/OCR: `MIN_PARAGRAPH_LENGTH=20`, `PDF_MAX_FRAGMENT_CHARS=1200`, `MIN_OCR_TEXT_LENGTH=20`, `OCR_SCALE=2`, `OCR_LANG='spa'`, `OCR_MAX_PAGES=60`, `LAYOUT_*`.

### 4.2 Variables de entorno (`src/config/env.ts`)

- `INGESTION_CONCURRENCY` (default 2) — concurrencia al enriquecer/vectorizar.
- `INGESTION_ENABLE_GRAPH_RAG` (default true).
- `OCR_ENABLED`, `OCR_LANG`, `OCR_MAX_PAGES`.

---

## 5. Cálculo del tamaño y hook adaptativo de densidad

- **El tamaño se mide en caracteres (`text.length`), NO en tokens.** No hay tokenizador en el pipeline.
- **Vectores**: doc completo → 768d (base); child → 1536d (high).

### 5.1 Hook `sizeFor` (Fase 7)

- Definido en `ChunkingStrategyConfig.sizeFor` (`chunkingStrategies.ts:41`) y `StrategySplittingOptions.sizeFor` (`:196`).
- **Ninguna estrategia actual lo implementa** (both Generic y Legal lo dejan `undefined`), así que hoy no cambia nada.
- Se habilita por el flag `adaptive` (default `true`) en la ingesta (`ingestionPipeline.ts:88`), pero como `strategy.config.sizeFor` es `undefined`, efectivamente neutro.
- Se aplica en `splitStructural` (`:752,771`) y `splitSlices` (`:719,735`).
- Patrón previsto (ver `src/evaluateChunking.ts:73`): zonas >300 chars se trocean a 250, zonas cortas hasta 650 → *texto denso → chunks menores*.

### 5.2 Evaluación empírica (Fase 8)

`src/evaluateChunking.ts` compara configs (generic/legal/adaptive) midiendo la adhesión a fronteras. Se corre con `npm run eval:chunking`.

---

## 6. Persistencia (tablas)

- `documents` — documento + `embedding_base`.
- `document_parent_chunks` — parents.
- `document_paragraphs` — children (`raw_content`, `contextualized_text`, `metadata` JSONB, `embedding_high`, `parent_chunk_id`).
- `document_entities`, `entity_relations` — Graph RAG.

---

## 7. Limitaciones y notas importantes

1. **Tamaño en caracteres, no tokens**: todo el chunking es por `text.length`.
2. **`sizeFor` es un hook sin estrategia real**: el flag `adaptive` existe pero hoy no altera el resultado. El patrón de uso está en `evaluateChunking.ts:73`.
3. El endpoint `/upload` acepta DOCX/XML por MIME genérico.
4. `splitIntoParagraphs` en `documents.ts:54` solo valida que haya contenido; el pipeline usa el texto completo.
5. Concurrencia controlada (`INGESTION_CONCURRENCY` default 2) para no saturar el tier free del LLM.
6. Los números de línea citados corresponden al estado actual de los archivos y deben verificarse si el código cambia.

---

## 9. Plan de integración — Ingesta determinista y desacoplada

> **Estado: PARCIALMENTE APLICADO.** Ver notas `[✓ APLICADO]` y `[SUSPENDIDO]`.
> **Importante:** el plan original referencia archivos que NO existen (`ingestionPipeline_2.ts`, `chunkingService_2.ts`). Este plan mapea cada fase al código real.

**Archivos destino reales:**
- `src/services/ingestionPipeline.ts` ✓
- `src/services/chunkingStrategies.ts` ✓
- `src/config/env.ts` ✓
- (nuevos) `src/services/queueService.ts`, `workers/graphRagWorker.ts` — [SUSPENDIDO, no creados]

### Fase 1 — Enriquecimiento determinista (quitar el LLM de la ingesta) `[✓ APLICADO]`

**Consumidores:** la búsqueda (`hybridSearchService.ts`, `ragEngine.ts`, `iterativeRAGEngine.ts`) solo usa `raw_content`, `contextualized_text` y `parent_content`. `keywords`/`category` se guardan en `metadata` pero **no** los consume el retriever → su pérdida es de bajo riesgo. El `contextualized_text` SÍ se vectoriza y se sirve al LLM → debe seguir siendo rico.

**Dónde:** `ingestionPipeline.ts` (cuerpo de `mapConcurrent`).

**Aplicado:** flag `env.INGESTION_DETERMINISTIC_ENRICH` (default **true**). Cuando `true`, se salta `llm.enrichChunk` y se construye `contextualized_text` determinista (`keywords=[]`, `category=strategy.config.name`). Si es `false`, vuelve al flujo anterior con LLM. Tests actualizados en `ingestionPipeline.test.ts`.

**Riesgo residual:** para estrategias generic sin `contextPath` el prompt determinista es pobre → si baja calidad de búsqueda, considerar incluir `docSummary`.

### Fase 2 — Ajuste de tamaños (chars → tokens) `[✓ APLICADO]`

**Dónde:** `chunkingStrategies.ts`.
- `GenericChunkingStrategy`: parent 1000→2500, child 450→1000, min 80→150. ✓
- `LegalNormChunkingStrategy`: parent 1500→3500, child 600→1200, min 100→150. ✓

**Verificación:** el embedding es `gemini-embedding-001` (`embeddingService.ts:4`), límite de entrada 2048 tokens (~3.5 ch/tok ⇒ ~7000 ch). `childMaxChars=1200` y `parentMaxChars=3500` quedan holgados y seguros. `sliceOversized` ya trunca lo que excede `maxChars`. Recomendado validar con `npm run eval:chunking`.

### Fase 3 — Chunking adaptativo nativo `[✓ SIN CÓDIGO + FIX DE FRONTERAS]`

No requiere el hook `sizeFor`: `splitStructural` agrupa hasta `maxChars` y `sliceOversized` corta oversized. `normativeOutline`/`contextPath` ya se activan si la estrategia es `legal`. Validar con `npm run eval:chunking` que las fronteras sigan respetando artículos con los nuevos límites.

**Fix aplicado (bug preexistente):** `splitStructural` agrupaba por `maxChars` y **pegaba el comienzo del ARTÍCULO siguiente al final del chunk anterior**. Ahora `sliceByBoundaries` etiqueta cada segmento con su `BoundaryKind` y `splitStructural` fuerza `flush` al iniciar una frontera fuerte (`numbered`/`heading`): cada artículo/encabezado inicia un chunk nuevo. Verificado: `startOnBoundaryPct=100` en `evaluateChunking.ts` y `contextPath` completo (`LEY > TITULO > ARTICULO N`).

**Fix 2 (raíz de "legal ≠ automática"):** la limpieza de la estrategia legal (`cleanWithMap`) colapsaba los saltos de línea simples a espacios, y como el detector de fronteras es **por línea**, borraba el inicio de cada ARTICULO (los absorbía en el cuerpo). Ahora `cleanWithMap` conserva el `\n` cuando la línea siguiente es estructural (ARTICULO, numeración ≥2 chars romana, heading, lista), mientras sigue uniendo palabras partidas por guion (hipenación) y rejuntando párrafos. Resultado: la estrategia legal alinea artículos igual que la genérica.

### Fase 4 — Desacoplar Graph RAG (worker asíncrono) `[SUSPENDIDO]`

**Motivo:** el Graph RAG solo se **escribe** (`INSERT` en `document_entities`/`entity_relations`) pero **ningún consumidor lo lee** (ni búsqueda, ni `/api/query/relations`, que calcula relaciones por similitud de vectores). Gasta llamadas LLM sin beneficio.

**Decisión tomada:** `INGESTION_ENABLE_GRAPH_RAG` pasó a default **`false`** (`env.ts`), eliminando el costo/bloqueo por fragmento en la ingesta. El endpoint `/api/query/relations` sigue funcionando (usa `embedding_high <=>`).

**Para reactivar el Graph RAG en el futuro:**
1. Implementar un consumidor real (p. ej. `/api/query/relations` que lea `entity_relations`, o vista de entidades por documento en la UI).
2. `INGESTION_ENABLE_GRAPH_RAG=true`.
3. Opcionalmente aplicar el desacoplamiento async: tabla `graph_rag_queue`, `src/services/queueService.ts`, `workers/graphRagWorker.ts`, y mover las inserciones de `ingestionPipeline.ts:194-227` al worker.

**Resultado (estado actual):** ingesta sin llamadas LLM por fragmento (solo embeddings) → leyes en 2-3s; Graph RAG desactivado hasta que tenga consumidor.

---

## 8. Resumen del flujo en una oración

El texto se extrae según el tipo de archivo (PDF con layout/OCR, DOCX/TXT/MD/XML plano), se limpia según la estrategia (legal o genérica), se parte en bloques jerárquicos **respectando fronteras naturales** (encabezados, numeración, párrafos, páginas) con **solape** opcional y **rodadura según densidad**, se enriquece y vectoriza a dos niveles (786d pleno / 1536d por chunk) y se persiste de forma transaccional junto con entidades y relaciones (Graph RAG).


----

Aquí tienes el plan de acción técnico completo, desglosado fase por fase, con el código exacto que necesitas modificar en tus archivos actuales.Este plan transforma tu ingesta de un proceso pesado y dependiente del LLM a un pipeline determinista, ultrarrápido y optimizado para bases de datos vectoriales.Fase 1: Enriquecimiento Determinista (Eliminar el LLM de la ingesta)Actualmente, ingestionPipeline_2.ts llama a this.llm.enrichChunk por cada fragmento, lo que dispara los costos y el tiempo. Vamos a reemplazar esto por una concatenación determinista usando los metadatos (como el contextPath del AST) que tu sistema ya extrae magistralmente.  TSArchivo a modificar: src/services/ingestionPipeline.ts (aprox. línea 80-110).  Código sugerido:TypeScript// Reemplaza el bloque try/catch dentro de mapConcurrent por lo siguiente:

try {
  // 1. Tomamos el texto con overlap (solo para el vector)
  const embedText = child.extendedText ?? child.text;
  
  // 2. CONSTRUCCIÓN DETERMINISTA DEL CONTEXTO (¡Sin LLM!)
  // Concatenamos el título del documento y la ruta normativa (ej. LEY > TITULO > ARTICULO)
  const contextualized_text = child.contextPath 
    ? `Documento: ${title}\nContexto normativo: ${child.contextPath}\n\n${embedText}`
    : `Documento: ${title}\n\n${embedText}`;

  // 3. Generamos el vector directamente sobre el texto contextualizado
  const highVector = await this.embedder.generateEmbedding(contextualized_text, 1536);

  // Ya no extraemos keywords con el LLM en tiempo real. 
  // (Si las necesitas para BM25, puedes usar una librería local como 'natural' o regex)
  const keywords: string[] = []; 
  const category = strategy.config.name; // 'legal' o 'generic'

  let graphData = { entities: [], relations: [] };

  // Fase 4: Desacoplar GraphRAG (ver más abajo)
  if (enableGraphRag) {
    // AQUÍ idealmente enviarías un evento a una cola (Redis/BullMQ) 
    // en lugar de bloquear el hilo esperando a this.llm.extractEntitiesAndRelations
  }

  processedCount++;
  if (processedCount % 10 === 0 || processedCount === children.length) {
    console.log(`[Ingestion] Progreso: ${processedCount}/${children.length} chunks procesados`);
  }

  return {
    childIndex: child.childIndex,
    parentChunkId: parentDbIds[child.parentIndex] ?? null,
    rawText: child.text, // El fragmento puro para la UI
    contextualized_text: contextualized_text, // El fragmento rico para el Vector DB
    keywords,
    category,
    location: child.location ?? null,
    contextPath: child.contextPath ?? null,
    highVector,
    graphData,
  };
} catch (err) {
  failedChildren += 1;
  console.error(`[Ingestion] Skipping child ${child.childIndex} (embedding failed):`, err);
  return null;
}
Fase 2: Ajuste de Tamaños (De Caracteres a "Tokens")Tus fragmentos legales actuales están limitados a 600 caracteres (childMaxChars), lo que equivale a unos ~150 tokens. Esto es insuficiente para búsquedas complejas. Vamos a ampliar los límites asumiendo un promedio de 3.5 a 4 caracteres por token, apuntando a ~350 tokens para vectores y ~1000 tokens para contexto del LLM.  Archivo a modificar: src/services/chunkingStrategies.ts (aprox. línea 50).  Código sugerido:TypeScriptexport class LegalNormChunkingStrategy implements ChunkingStrategy {
  readonly config: ChunkingStrategyConfig = {
    name: 'legal',
    // Parent optimizado para ventana de contexto del LLM (~1000 tokens)
    parentMaxChars: 3500, // Antes: 1500
    
    // Child optimizado para embeddings semánticos densos (~300-350 tokens)
    // Esto permite que incisos enteros y artículos medianos entren en un solo chunk
    childMaxChars: 1200,  // Antes: 600
    
    // Mínimo lógico para no tener "basura" suelta
    childMinChars: 150,   // Antes: 100
    
    clean: (t) => this.cleanWithMap(t).text,
  };

  // ... (el resto del código queda igual) ...
}

export class GenericChunkingStrategy implements ChunkingStrategy {
  readonly config: ChunkingStrategyConfig = {
    name: 'generic',
    parentMaxChars: 2500, // ~700 tokens
    childMaxChars: 1000,  // ~250 tokens
    childMinChars: 150,
  };
  // ...
}
Fase 3: Chunking Adaptativo Nativo (Sin necesidad de sizeFor)La buena noticia es que tu diseño en chunkingService_2.ts ya es adaptativo por defecto gracias a la función splitStructural. Al aumentar childMaxChars a 1200 en la Fase 2, splitStructural agrupará párrafos, incisos y artículos automáticamente hasta llegar a ese límite natural.  TSNo necesitas implementar código complejo para sizeFor. Solo asegúrate de que el detector de fronteras esté habilitado en la estrategia legal.Si un artículo legal (Frontera) mide 800 caracteres, quedará en un solo bloque porque no supera los 1200. Si mide 1500 caracteres, la función sliceOversized lo cortará elegantemente en el último punto y aparte. Tu arquitectura ya manejaba esto, solo le faltaba "espacio" en los límites.  Fase 4: Desacoplamiento de Graph RAG (Async Worker)El Graph RAG (extracción de entidades/relaciones) es lo único que debería requerir un LLM en la ingesta. Si lo ejecutas sincrónicamente, un PDF de 10 páginas tardará minutos.Plan de refactorización:En ingestionPipeline_2.ts: Elimina la llamada a this.llm.extractEntitiesAndRelations del flujo principal.  En su lugar: Almacena los paragraph_id generados y su contenido en una tabla de base de datos tipo "cola" (ej. graph_rag_queue).El Worker: Crea un pequeño script (ej. workers/graphRagWorker.ts) que corra en segundo plano (vía cron o un bucle while(true) con un delay). Este script:Lee de la tabla graph_rag_queue los chunks pendientes.Llama al LLM para extraer entidades.Inserta en document_entities y entity_relations.  Marca la tarea como completada.Ejemplo conceptual del cambio en ingestionPipeline_2.ts (después del bloque COMMIT):TypeScript// Al final del método processAndStoreDocument, después de COMMIT:

if (enableGraphRag) {
  // Enviar a la cola de procesamiento en background en lugar de bloquear
  // Solo guardamos las referencias, el Worker hará el LLM de a poco.
  await this.queueService.enqueueGraphRagTasks(
    enrichedChildren.map(c => ({
      documentId: docId,
      paragraphId: c.paragraphId,
      text: c.rawText
    }))
  );
  console.log(`[Ingestion] Encoladas ${enrichedChildren.length} tareas de GraphRAG para background.`);
}

return {
  docId,
  // ...
}
Resultados inmediatos tras aplicar estas 4 fases:Ingestas instantáneas: Las leyes cargarán en 2-3 segundos en lugar de minutos, permitiéndote ingerir colecciones legislativas completas de golpe sin miedo a timeouts.Recuperación más precisa: Al aumentar el tamaño del vector y cruzarlo determinísticamente con el AST (contextPath), el modelo semántico tendrá mucha más "superficie" para encontrar coincidencias.Cero dólares en ingesta básica: Solo pagarás centavos por los embeddings (que son miles de veces más baratos que las llamadas a un LLM).