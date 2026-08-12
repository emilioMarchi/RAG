# Plan de Integración: Chunking Estructural (estructura-aware) + Overlap + Parent-Child

Mejora del pipeline de fragmentación para que los cortes ocurran **en las fronteras reales del documento** (numeración legal, encabezados, títulos, párrafos, páginas/columnas) en lugar de topes de caracteres fijos. Reemplaza (a mediano plazo) los tamaños fijos de cada estrategia por una partición **estructura-aware**, conserva el enfoque **parent-child** para RAG y agrega **overlap** entre fragmentos para no perder contexto en el punto de corte. Deja además un hook para la **partición adaptativa por densidad** (futura).

> **Nota de integración (2026-08-12):** este documento fue puesto al día integrando el
> diagnóstico técnico del estado actual del sistema (ver `log.md`). Las secciones
> "Estado base relevante", "Contexto extendido integrado" y "Riesgos" incorporan lo que
> de verdad existe hoy en el código, de modo que cada fase refleje el punto real de
> partida y no supuestos.

---

## 🗺️ Mapa de ruta

Plantea un pipeline de fragmentación estructura-aware. Este es el **único** roadmap del
proyecto: las recomendaciones del análisis técnico (sanitización de layout, jerarquía
normativa, rango core vs extended, rendimiento) quedaron integradas como fases numeradas.
Las fases marcadas con ✅ ya están implementadas; el resto es desarrollo pendiente en orden.

```mermaid
graph TD
    F0[Fase 0: Sanitizacion layout PDF ✅] --> F1
    F1[Fase 1: Detector de fronteras ✅] --> F2
    F2[Fase 2: Split estructural ✅] --> F3[Fase 3: Overlap ✅]
    F2 --> F4[Fase 4: Parent-child + dedup grafo ✅]
    F3 --> F5[Fase 5: Rango core vs extended ✅]
    F4 --> F6[Fase 6: Contexto normativo (AST) ✅]
    F5 --> F7[Fase 7: Hook adaptativo por densidad ✅]
    F6 --> F8[Fase 8: Evaluacion empirica ✅]
```

---

## Estado base relevante (código actual)

| Área | Archivo | Punto de integración |
|------|---------|----------------------|
| Split jerárquico | `src/services/chunkingService.ts:362` | `splitHierarchical()` divide parent→child por `splitSlices` (defaults parent 1800 / child 450 / min 80) |
| Split genérico | `chunkingService.ts:575` | `splitSlices()` → `splitByBlankLines()` (párrafos) / `splitPDF()` (offsets aproximados en PDF) |
| Split por párrafos | `chunkingService.ts:599` | `splitByBlankLines()` usa `/\n[ \t]*\n+/` y recorta |
| Cortes de bloque | `chunkingService.ts:624` / `:655` | `sliceOversized()` corta por `\n`→`[.;:!?]`→espacio; `groupBlocks()` fusiona hasta `maxChars` |
| Reglas PDF | `chunkingService.ts:28-29` | `PDF_HEADING_RE`, `PDF_INDEX_LINE_RE`, `PDF_FOOTER_RE` (solo en `splitPDF`) |
| Marcadores legales | `chunkingService.ts:142` | `splitPDF()` solo usado en modo PDF |
| Ubicación | `chunkingService.ts:409` / `:440` | `computeLocation()` → `locateOnOriginal()` (sobre texto original, con mapa de offsets) |
| Búsqueda texto→página | `chunkingService.ts:486` | `locateInPages()` (exacta → normalizada → primera línea → página 1) |
| Bbox por línea | `chunkingService.ts:537` | `unionRanges()` agrupa ítems en filas (overlap vertical 40%) |
| Estrategias | `src/services/chunkingStrategies.ts:41-109` | `Generic` (parent 1000 / child 450/80) / `LegalNorm` (parent 1500 / child 600/100, con `cleanWithMap`) |
| Detección legal | `src/services/strategyDetector.ts:36` | `detect()`: lex 5 + estructural 30, umbral 14 (#NUM_LINE_RE) |
| Selección | `chunkingStrategies.ts:191` | `resolveChunkingStrategy()`: manual → auto(contenido) → heurístico |
| Aplicación | `chunkingStrategies.ts:229` | `splitWithStrategy()` limpia, parte y **recalcula location** contra el original vía `prepared.index` |
| Ingesta | `src/services/ingestionPipeline.ts:58` | llama `splitWithStrategy(fullContentText, pages, …)` dentro de transacción SQL |
| Persistencia | `ingestionPipeline.ts:113-160` | `document_paragraphs.metadata` guarda `{keywords, category, location}`; + `logging`/`entities`/`relations` |

---

## Contexto extendido del estado actual (integrado desde `log.md`)

Lo que sigue es el detalle del pipeline real que este plan debe respetar (y sobre el
que apoya cada fase). Datos completos en `log.md`.

### 5.1 Costura de texto preparado ↔ texto original (clave para el plan)

El chunking **no** asigna ubicaciones sobre el texto que fragmenta, sino sobre el texto
**original**. Cada estrategia devuelve un `PreparedText { text, index(offset) }` y tras
`splitHierarchical` se llama `locateOnOriginal(originalText, pages, preparedStart, preparedEnd, prepared.index)`:

```ts
// chunkingStrategies.ts:239 — recálculo de location contra el original
const children = result.children.map(ch => {
  const loc = ch.location;
  if (!loc) return ch;
  return { ...ch, location: chunker.locateOnOriginal(
      text, opts.pages, loc.startChar, loc.endChar, prepared.index) };
});
```
Consecuencia: **cualquier cambio de corte (split estructural, overlap) debe preservar
este recálculo** — de lo contrario el visor desalinea página/línea/bbox del archivo real.

### 5.2 Limpieza legal ya existe (`cleanWithMap`)

La estrategia `LegalNorm` ya une palabras cortadas por salto de página y **produce el
mapa de offsets** durante la limpieza (`chunkingStrategies.ts:91`). El plan no debe
reimplementar esto: `detectBoundaries` debe operar sobre el **texto preparado** y dejar
que `locateOnOriginal` traduzca después.

### 5.3 ChunkLocation (shape ya definido en DB)

```ts
interface ChunkLocation {
  pageNumber?: number;             // 1-indexed
  startChar?: number; endChar?: number;
  startLine?: number; endLine?: number;
  boundingBoxes?: BoundingBox[];   // normalizados 0..1, uno por línea (unionRanges)
}
```
El migration `006_chunk_locations` documenta este shape; **los documentos ya ingeridos
antes no tienen `location`** (deben re-ingestarse). El plan de split estructural no
cambia este shape, solo quién llena `startChar/endChar/startLine/endLine`.

### 5.4 Deudas actuales que condicionan el chunking

1. **PDFs OCR (`extractPDFPagesWithOCR`) no tienen items/ranges** → su `location` solo
   tiene `pageNumber`, sin `boundingBoxes`. Un split estructural por "frontera de
   página" no podrá dar bbox en OCR; solo tiene sentido en PDFs con capa de texto.
2. **`paragraphs` muerto en ingesta**: la ruta calcula `splitIntoParagraphs` solo para
   validar; el pipeline lo marca `@deprecated` y lo ignora.
3. **`content` duplica texto** (`documents.content` + binario en R2).
4. **Ingesta sensible a fallos de LLM/embedding**: un fallo de embedding aborta todo el
   documento; las entidades fallan gracioso (grafo vacío) pero enrich/embedding no.

---

## Fase 0 — Sanitización de layout PDF (header/footer stripping) ✅

**Origen:** recomendación del análisis técnico (contaminación por headers/footers y
números de página intermedios: "Boletín Oficial N° 34.120 - Página 12"). Un ARTÍCULO que
empieza al final de la página 3 y continúa en la 4 introduce texto espurio en el medio,
rompe los regex de fronteras o fragmenta erróneamente el artículo.

- Aplicar en `extractPDFPages`/`buildPage` (`chunkingService.ts:215/250`) **antes** del
  split: detectar líneas repetidas en cada página (headers/footers) y descartarlas.
- Mantener la sincronía con `ranges`/`items` (los offsets deben seguir apuntando al texto
  que ve el usuario).
- **Prioridad:** junto con la Fase 6, es la más señalada por el análisis para normativas.

---

## Fase 1 — Detector de fronteras (boundary detection) ✅

Nuevo módulo reutilizable por estrategia (resuelve límites como *lista de offsets*, igual que `splitByBlankLines` pero multi-señal). Debe ser **común** a todos los tipos de documento. Ubicación propuesta por el roadmap de ejecución: **`src/services/chunking/boundaryDetector.ts`** (módulo aislado y unit-testable).

```
interface BoundaryMarker { re: RegExp; label?: string }

interface BoundaryMatch { start: number; end: number; kind: 'heading'|'numbered'|'paragraph'|'page'|'list'; label?: string }

detectBoundaries(text): BoundaryMatch[]
```

Señales:
- **Encabezados**: `#`, `##`, y `PDF_HEADING_RE` (`chunkingService.ts:28`).
- **Numeración legal**: `Artículo/Art. N°`, `1)`, `a)`, `I.`, `IV.` (reutilizar `NUM_LINE_RE` de `strategyDetector.ts:25`).
- **Párrafos**: `\n\n` (ya cubierto por `splitByBlankLines`, `chunkingService.ts:599`).
- **Página/columna**: para PDF, las fronteras de `pages` (layout del text layer, `chunkingService.ts:250` `buildPage`).

**Integración:** `detectBoundaries` se ejecuta sobre el texto **preparado** de la
estrategia (ver §5.1). Para compatibilidad, `splitBytesLoaded` puede usarlo como
backend del `splitSlices()` actual (`chunkingService.ts:575`). Antes de escribir
marcadores nuevos, evaluar reutilizar la lógica de `splitPDF()` (`chunkingService.ts:142`)
y `groupBlocks()` (`chunkingService.ts:655`), evitando duplicar reglas.

Criterio de aceptación: dado un texto con `Artículo 1 … Artículo 2`, producir los offsets de ambos límites contiguos.

---

## Fase 2 — Split estructural (`splitStructural`)

Nuevo splitter en `ChunkingService` que, en lugar de cortar ciegamente en `maxChars`, **camina los `detectBoundaries` y corta en la última frontera ≤ tope**.

- Firma propuesta: `splitStructural(text, maxChars, opts?: { overlapChars?: number; minChars?: number }): Array<{ text, start, end }>`.
- Si no hay frontera antes del tope (bloque muy largo sin marcadores), cae a un corte por frase/oración (o salto de línea) → último espacio/salida, como hoy.
- **Compatibilidad**: `splitSlices()` puede usar `splitStructural` como backend para no romper la API actual (`splitHierarchical` consume `{ text, start }`).

Criterio: ningún chunk parte dentro de un `Artículo`; cada chunk termina en frontera o en fin de oración.

---

## Fase 3 — Overlap

El overlap se aplica **arriba** de las estrategias, en `splitWithStrategy`, sin tocar el núcleo:

- Opción `overlapChars` (default ~50–100 chars) en `StrategySplittingOptions`.
- Al construir los `child` chunks, cada hijo extiende su `start` hacia atrás `overlapChars` cuando el `start` lo permite (sobre texto preparado).
- La ubicación final se recalcula igual vía `locateOnOriginal` (los offsets ya son sobre el texto original).

Criterio: el chunk *n* incluye el final del *n-1*; la recuperación pierde menos contexto en cortes.

---

## Fase 4 — Parent-child sobre bordes

Hoy `splitHierarchical` hace parent (bloques grandes) → child (sub-bloques). Reforzar para que **ambos niveles respeten fronteras**:

- Parent: se cierran en el límite superior que sea frontera de sección/numeración.
- Child: se cortan en fronteras menores (párrafo / fratido de lista) + overlap.
- Mantener `parentIndex → startChildIndex/endChildIndex` y `startChildIndex/endChildIndex` (schema DB sin cambios).
- **Deduplicación de grafo (preventivo)**: al aplicar overlap, la misma entidad puede
  repetirse en varios hijos adyacentes. En `ingestionPipeline.ts`, deduplicar entidades
  con un `Set<entity_name,entity_type>` (por documento o por tramo) antes de insertar en
  `document_entities`, para no duplicar nodos del grafo. Esto fue señalado por el
  roadmap de ejecución (Sprint 3) y se incorpora para mantener consistencia.

---

## Fase 5 — Rango core vs extended en `location` ✅

**Origen:** recomendación del análisis técnico (overlap). Al solapar, los caracteres finales
del Child *N* coinciden con los iniciales del *N+1*; al saltar desde una entidad en la zona
de overlap, `locateInPages`/`spansToBoxes` del visor podrían resaltar el bloque equivocado.

- Enriquecer `ChunkLocation` para conservar el rango útil **sin** overlap
  (`coreStartChar/coreEndChar`) además del ampliado con overlap (`extendedStartChar/endChar`).
- En `splitWithStrategy`, al aplicar `overlapChars`, llenar ambos rangos; el visor resalta
  por defecto el `core`, y solo usa el `extended` cuando el texto objetivo cae en solape.
- Shape compatible con `metadata.location` (agrega campos opcionales; no rompe migración 006).

---

## Fase 6 — Contexto normativo (AST / jerarquía) ✅

**Origen:** recomendación del análisis técnico (Gap Crítico Legal). Los documentos legales
son árboles `Título → Capítulo → Sección → Artículo → Inciso/Numeral → Párrafo`, pero el
detector produce límites **planos**. Un hijo que corta en el Inciso *b)* pierde el dato de a
qué ARTÍCULO/Capítulo pertenece si ese contexto no se propaga.

- Construir un AST normativo corto a partir de `detectBoundaries` (encabezados y numeración
  jerárquica) y, al enriquecer, anteponer un header sintético al child
  (`[Ley 27.541 > Título II > Art. 14 > Inciso b]`) antes de pasarlo a `LLM.enrichChunk`.
- No cambia el chunking; agrega contexto al texto que se vectoriza/consulta.

---

## Fase 7 — Hook adaptativo por densidad ✅ (opcional)

Para no duplicar lógica por estrategia, exponer un `sizeFor(segment)` opcional en `ChunkingStrategyConfig`:

- Default: devuelve los `parentMaxChars/childMaxChars` actuales (comportamiento = hoy, **cero regresión**).
- Estrategia futura "densidad": en zonas legales densas → tamaños menores; párrafos corridos → mayores; cortar siempre en `detectBoundaries`.
- Se habilita por una nueva bandera de ingesta (p. ej. `adaptive=true`) o una 4ª opción en la UI.

---

## Fase 8 — Evaluación empírica ✅

La partición óptima se mide, no se asume:
- Métrica de recuperación (recall@k de `hybridSearchService`) con y sin cada cambio (baseline fijo vs. estructural vs. overlap vs. adaptativo).
- Cobertura de entidades/citas en respuestas (`ragEngine`/`iterativeRAGEngine`).
- Un script/put junto a `generate-tests.mjs` para correr el mismo corpus legal con varias configs y comparar.

---

## Criterios de aceptación (de revisión del código actual)

- [ ] Ningún corte parte dentro de un `Artículo`/sección numerada (estructura-aware).
- [ ] Child chunks adyacentes comparten `overlapChars` mínimo.
- [ ] `parent` y `child` respetan fronteras; índices parent/child intactos en DB.
- [ ] `location` sigue calculándose sobre el **texto original** y no desalinea el visor (mantener `locateOnOriginal`).
- [ ] Backward-compat: sin cambiar configs, la salida es equivalente a la actual (salvo el corte en fronteras).
- [ ] Tests unitarios de `detectBoundaries`, `splitStructural`, overlap y adaptativo; suite del repo en verde salvo las 4 fallas preexistentes de mocks DB.
- [ ] (F7) `sizeFor` permite partición adaptativa por densidad sin regresión al omitirlo. ✅
- [ ] (F8) `npm run eval:chunking` compara configs y estrategias con métricas de adhesión a fronteras. ✅
- [ ] (F0) PDF sin headers/footers intermedios rompiendo las fronteras. ✅
- [ ] (F5) `location` diferencia `core` vs `extended`; el visor usa `core` por defecto. ✅
- [ ] (F6) cada child de normativa es enriquecido con su encabezado jerárquico (AST). ✅

---

## Riesgos y decisiones

- **Cambio transversal**: tocar `splitSlices`/`splitHierarchical` afecta a todas las estrategias → el plan lo hace **común** (detector + split estructural) y deja tamaños por estrategia intactos.
- **Overlap duplica texto**: sube tokens/vectores entre un 5–15%; validar costo. Debe aplicarse sobre el texto preparado y **recalcularse la location contra el original** (§5.1) para no desalinear el visor.
- **Fronteras falsas**: no todo "1)" es legal; calibrar `detectBoundaries` con corpus real (la heurística de `strategyDetector` ya pondera estructura 30 → usar ese umbral como guía).
- **PDFs OCR sin layout**: el split por "frontera de página" solo aporta bbox en PDFs con capa de texto; en PDFs escaneados (`extractPDFPagesWithOCR`) no hay `items/ranges`, así que `boundingBoxes` no estará disponible (solo `pageNumber`). No exigir bbox ahí.
- **Compatibilidad de ubicación**: preserve `locateOnOriginal` y el `PreparedText.index` de cada estrategia; romper ese mapa rompe la navegación grafo→documento.
- **Re-ingesta**: los documentos ya subidos no tienen `location`; el split estructural no los arregla de forma retroactiva (re-ingest).
- **Orden**: fronteras primero (F0-2), luego overlap (F3) y parent-child+dedup (F4), luego rango core (F5), contexto normativo (F6); adaptativo (F7) y evaluación (F8) pueden ir después, sin bloquear las anteriores.

_Nota: todas las fases (0 a 8) están implementadas en este único plan._


🚀 Hoja de Ruta de Ejecución Inmediata (orden único integrado — Sprint 1 a 3 ✅ completos)
 Boundary Detector      Split Estructural       Overlap + Parent-Child
 (Módulo aislado)       (ChunkingService)       (splitWithStrategy + Visor)
Sprint 1: Fase 1 — Detector de Fronteras (boundaryDetector.ts)Objetivo: Un módulo puro, aislado y fácil de probar con unit tests.Crear archivo: src/services/chunking/boundaryDetector.ts.  Definir la interfaz y función principal:TypeScriptexport interface BoundaryMatch {
  start: number;
  end: number;
  kind: 'heading' | 'numbered' | 'paragraph' | 'page' | 'list';
  label?: string; // ej: "ARTÍCULO 5°"
}

export function detectBoundaries(text: string): BoundaryMatch[] { ... }
Reutilizar regexes existentes:Reutilizar NUM_LINE_RE de strategyDetector.ts (numeración legal).  Reutilizar PDF_HEADING_RE y PDF_INDEX_LINE_RE de chunkingService.ts.  Unificar con párrafos (\n\n).  Tests unitarios: Crear tests/boundaryDetector.test.ts pasando un fragmento de ley/normativa real y verificando que devuelva los offsets exactos de cada artículo sin fallar.  Sprint 2: Fase 2 — Split Estructural (splitStructural)Objetivo: Reemplazar el corte ciego por caracteres por un corte guiado por fronteras.Implementar en ChunkingService (src/services/chunkingService.ts):TypeScriptpublic splitStructural(
  text: string,
  maxChars: number,
  opts?: { minChars?: number }
): Array<{ text: string; start: number; end: number }> { ... }
Lógica de agrupación/corte:Recorrer los marcadores de detectBoundaries(text).  Acumular bloques de texto mientras la suma de longitud sea ≤ maxChars.  Si un único bloque (ej. un Artículo gigante) supera maxChars, aplicar fallback a oraciones/puntos seguidos (sliceOversized existente).  Compatibilidad: Hacer que splitSlices() consuma splitStructural() manteniendo la firma hacia splitHierarchical().  Sprint 3: Fases 3 y 4 — Overlap y Parent-ChildObjetivo: Preservar contexto en cortes y mantener sincronizado el visor.Agregar overlapChars en StrategySplittingOptions (src/services/chunkingStrategies.ts).  Aplicar Overlap sobre texto preparado: Ampliar los límites start del child $n$ hacia atrás $n-1$.  Garantizar el recálculo contra el original: Asegurar que cada child pase por locateOnOriginal(originalText, pages, preparedStart, preparedEnd, prepared.index).  Metadatos de Grafo (Preventivo): En ingestionPipeline.ts, aplicar un Set simple de deduplicación de entidades por (entity_name, entity_type) al recorrer los hijos con overlap para no duplicar nodos en la base de datos de grafos.🛠️ Recordatorio Técnico para el ComienzoTexto preparado vs. Original: Recuerda que la limpieza previa (como LegalNorm.prepare()) altera la longitud del texto. detectBoundaries y splitStructural deben correr sobre el texto preparado. Luego, locateOnOriginal traducirá automáticamente las coordenadas al PDF/documento original.  MDTests del repo: La suite preexistente debe seguir en verde.  
Sprint 4 [Fase 0] ✅: Sanitización de layout PDF (header/footer stripping) en extractPDFPages/buildPage, descartando líneas repetidas de encabezado/pie sin romper items/ranges.
Sprint 5 [Fase 5] ✅: Rango core vs extended en ChunkLocation al aplicar overlap; el visor resalta core por defecto.
Sprint 6 [Fase 6] ✅: AST normativo sobre detectBoundaries + header sintético en enrichChunk para normativas.
Sprint 7 [Fases 7-8] ⏳: Hook adaptativo por densidad (sizeFor) y evaluación empírica (recall@k / cobertura).  