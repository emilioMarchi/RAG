# Plan de integración: OCR local para PDFs escaneados

**Estado:** ✅ Implementado (2026-08-07)
**Fecha:** 2026-08-07
**Ámbito:** Solo backend web (Node/Express). **No se toca Electron.**

## Estado de implementación
- [x] Dependencias: `pdf-to-img@6.2.0` + `tesseract.js@7.0.0` instaladas (sin `canvas` nativo).
- [x] Fallback OCR en `ChunkingService.extractPDFWithOCR` (`src/services/chunkingService.ts`).
- [x] Datos de idioma localizados en `tessdata/spa.traineddata.gz` (`langPath` → carpeta local, offline).
- [x] Config por env: `OCR_LANG`, `OCR_SCALE`, `OCR_MAX_PAGES`, `OCR_ENABLED`.
- [x] Tests (27 pasando) + build `tsc` OK + verificación end-to-end del pipeline OCR local.
- [ ] (Opcional) Exponer método usado (`text` vs `ocr`) en el endpoint de ingesta.

---

## 1. Contexto y problema

La ingesta actual de PDFs (`src/services/chunkingService.ts:40`) usa `pdf-parse`, que solo
extrae la **capa de texto** del PDF. Cuando el PDF es escaneado (imágenes, sin capa de texto),
`data.text` sale **vacío o irrelevante**, y la ingesta no puede indexar ese contenido.

Se requiere un **OCR local** (sin API de terceros, sin salida de datos de la PC) como respaldo
automático.

## 2. Stack confirmado

| Paquete | Rol | Por qué |
|---|---|---|
| `pdf-to-img` (v6+) | Renderizar cada página del PDF a imagen | Soport a `pdfjs-dist@5` y **eliminó `node-canvas`** → sin binarios nativos en Windows. Sin Electron = sin rebuilds. |
| `tesseract.js` (v5/v6) | OCR (reconocimiento de texto) | Motor Tesseract compilado a WASM, corre en Node puro. |

Entorno: **Node v24, proyecto ESM** (`"type": "module"`), `tsconfig` strict + `moduleResolution: bundler`, rutas con `.js`.

**Por qué no **otras alternativas**:**
- Gemini/LLM con visión: rechazado por el requisito de no usar API. ✔
- `node-canvas`/`@d0paminedriven/pdfdown-ocr`: requieren dependencias nativas o tesseract de sistema → se descartan. ✔

---

## 3. Arquitectura

El flujo queda **totalmente dentro** de `ChunkingService.extractText`, sin tocar la ruta de ingesta:

```
extractText(file, mime)
  └─ es .pdf?
       └─ extractPDF(file)
            ├─ data = pdf-parse(buffer)          # vía rápida (PDFs con texto)
            ├─ si data.text tiene LONGO suficiente → devolver text
            └─ si no (PDF escaneado):
                 pdf-to-img → píxeles página a página
                 tesseract.js → OCR (español + inglés)
                 → concatenar y devolver
```

### Heurística de decisión
- **Umbral:** si el texto extraído por `pdf-parse` supera un mínimo (ej. `> 20` caracteres no- espacio),
  se usa tal cual (es el camino rápido, no cambia nada actual).
- **Fallback OCR:** si el texto es vacío o está por debajo del umbral, se dispara el pipeline OCR.
- **Límite de páginas:** cap de páginas a OCR (ej. `MAX_OCR_PAGES`, defaultValue 60) para evitar
  tareas enormes; opcional un máximo de páginas total.

---

## 4. Pasos de implementación

### 4.1 Instalar dependencias
```bash
npm install pdf-to-img tesseract.js
```
> `pdf-to-img` v6 no arrastra preconjuntos nativos. Verificar que `node_modules` no contenga `canvas`.

### 4.2 Cargadores perezosos (lazy `import()`)
Como `index.ts` y `console.ts` instancian `ChunkingService` al arranque, y `tesseract.js` + `pdf-to-img`
son pesados, importarlos **solo dentro de `extractPDF`** (igual que ya se hace con `pdf-parse` en
`chunkingService.ts:44`). Así no se penaliza el arranque ni PDFs de texto.

Código ejemplo (en `extractPDF`, fallback):
```ts
// cargar pdf-to-img (ESM)
const { pdf } = await import('pdf-to-img');
// cargar tesseract.js
const Tesseract = await import('tesseract.js');

const document = await pdf(filePath, { scale: 2 });
let ocrText = '';
const worker = await Tesseract.createWorker('spa');

for await (const image of document) {
  const { data: { text } } = await worker.recognize(image);
  ocrText += text + '\n\n';
}
await worker.terminate();
return ocrText;
```

### 4.3 workerPath en runtime
En Node, `tesseract.js` necesita localizar su worker WASM. Configurar `workerPath`, `langPath` y
`corePath` apuntando a los `dist` incluidos en `node_modules` (o a `file://` vía
`new URL('...', import.meta.url)`), para que funcione **offline** y sin red.

### 4.4 Configuración
Agregar constantes/config en `ChunkingService` (o `env`):
- `OCR_MIN_TEXT_LENGTH` (umbral, default ~20)
- `OCR_SCALE` (default 2): más alto = mejor precisión, más RAM.
- `OCR_LANG` (default `'spa'`; combinable `'eng+spa'`).
- `OCR_MAX_PAGES` (default 60).
- `OCR_ENABLED` (boolean, default true), para poder apagar si hace falta.

### 4.5 Manejo de errores
Si el OCR falla para una página, capturar y continuar con la siguiente; si falla del todo,
devolver el texto parcial (o el string vacío y dejar que el pipeline falle como hoy).

### 4.6 Actualizar la UI indicando "PDF escaneado"
Opcional: expón en el endpoint de ingesta qué método se usó (`'text' | 'ocr'`) para mostrarlo
en la consola/UI. Fuera de alcance inicial.

---

## 5. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `Tesseract WASM ~2–4 MB + lang `download`a`| Primer uso descarga, caché después | En runtime fijar datos locales en `node_modules` (offline). |
| CPU/RAM altas en PDFs largos | `~600MB–1GB RAM, 1–3s/paginación` | Dejar OCR como fallback; côtea `OCR_MAX_PAGES`. |
| Precisión en lo malo (escaneos) | Baja solo para textos ruidosos | Ajustar `OCR_SCALE` y lang. |
| Dependencias nativas (canvas) | Setup Web en Windows | `pdf- v6` no usa canvas; **verificar** tras instalar. |
| `tsconfig strict` tipos de `tesseract.js` | Errores TS en build | Usar `as any` puntual (ya se hace con `pdf-parse` en línea 44) o `skipLibCheck` ya activo. |

---

## 6. Criterio de aceptación

1. PDF con texto → sigue funcionando igual (camino rápido, sin OCR). ✔
2. PDF escaneado → produce texto indexable vía OCR. ✔
3. 100% local: sin llamadas HTTP externas pendiente de la precisión del OCR. ✔
4. Sin dependencias nativas (no `canvas`/build en Windows). ✔
5. Arranque del servicio no se ve afectado (carga diferida). ✔

**Verificar con:**
- `npm run build` (tsc strict pasa).
- `npm run console` → `/ingest <ruta-a-scan.pdf>` y ver párrafos > 0.
- Probar `npm run test` si hay tests existentes (vitest).

---

## 7. Archivos a modificar

| Archivo | Cambio |
|---|---|
| `package.json` | Agregar `pdf- to-img` + `tesseract.js` (deps). |
| `src/services/chunkingService.ts` | Nuevo método `extractPDFWithOCR`; ajustar `extract`(`:40`) para el fallback; constantes/config. |
| (`src/config/env.ts`) | Solo si se quieren los umbrales configurables por env. |

---

## 8. Fuera de alcance (ahí)
- OCR en imágenes sueltas (PJPG/PNG) como documentos.
- Detección de layout / columnas.
- Generación de capa de texto PDF "searchable" (solo extracción, no reescritura del PDF).