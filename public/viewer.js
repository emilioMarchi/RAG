/**
 * RAG Studio — viewer.js
 * DocumentContextViewer: visor de documento fuente con salto a la ubicación exacta
 * de un chunk (página + bbox para PDF, rango de líneas para texto/código) y
 * resaltado con animación. Permite scroll libre del contexto completo.
 */

// ─── Refuerzos para el visor ─────────────────────────────────────────────
const viewerEl   = document.getElementById('doc-viewer');
const viewerTitle= document.getElementById('viewer-title');
const viewerTarget=document.getElementById('viewer-target');
const viewerScroll=document.getElementById('viewer-scroll');
const viewerPdf  = document.getElementById('viewer-pdf');
const viewerText = document.getElementById('viewer-text');
const viewerClose= document.getElementById('viewer-close');
const viewerMenu = document.getElementById('viewer-menu');
const viewerMenuSearch = document.getElementById('viewer-menu-search');
const btnSearchSel = document.getElementById('viewer-search-sel');

let lastDocInfo = null;   // { docId, mimeType, title }
let selectionText = null; // texto seleccionado dentro del visor
let lastSelectionMenuSelection = null;

function api(path, opts = {}) {
  return fetch((window.location.origin || '') + path, opts).then(async res => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  });
}

viewerClose.addEventListener('click', closeDocViewer);
viewerEl.addEventListener('click', (e) => {
  if (e.target === viewerEl) closeDocViewer();
});

// ─── Apertura principal ──────────────────────────────────────────────────
window.openDocViewer = async function (docId, location, mimeType, title, fragmentText) {
  if (!docId) return;
  lastDocInfo = { docId, mimeType: (mimeType || '').toLowerCase(), title: title || 'Documento' };
  const isPdf = lastDocInfo.mimeType.includes('pdf');
  const label = [
    location?.pageNumber ? `Página ${location.pageNumber}` : null,
    location?.startLine ? `Línea ${location.startLine}${location.endLine ? `–${location.endLine}` : ''}` : null,
  ].filter(Boolean).join(' · ');

  viewerTitle.textContent = lastDocInfo.title;
  viewerTarget.textContent = label ? `Fragmento → ${label}` : 'Documento completo';
  viewerEl.style.display = 'flex';

  // Limpiar contenedores y preparar el modo según tipo de archivo
  viewerPdf.innerHTML = '';
  viewerText.innerHTML = '';
  viewerText.classList.add('hidden');
  viewerPdf.style.display = 'none';

  if (isPdf) {
    viewerPdf.style.display = 'block';
    await renderPDF(docId, location, fragmentText);
  } else {
    viewerText.classList.remove('hidden');
    await renderText(docId, location);
  }
  viewerScroll.scrollTop = 0;
};

window.closeDocViewer = closeDocViewer;
function closeDocViewer() {
  viewerEl.style.display = 'none';
  viewerPdf.innerHTML = '';
  viewerText.innerHTML = '';
  hideMenu();
}

// ─── Visor PDF (pdf.js) ──────────────────────────────────────────────────
let pdfWorkerSet = false;
function ensurePdfWorker() {
  if (pdfWorkerSet) return;
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.worker.min.js';
  }
  pdfWorkerSet = true;
}

async function renderPDF(docId, location, fragmentText) {
  ensurePdfWorker();
  const res = await fetch(`/api/documents/${docId}/file`);
  if (!res.ok) throw new Error('No se pudo cargar el archivo PDF');
  const data = await res.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data }).promise;

  const targetPage = Math.max(1, Math.min(location?.pageNumber || 1, pdf.numPages));
  const targetBoxes = Array.isArray(location?.boundingBoxes) ? location.boundingBoxes.filter(b => b) : [];

  const maxPages = Math.min(pdf.numPages, 80);
  let targetWrapper = null;

  for (let n = 1; n <= maxPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, 1000 / base.width);
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = n;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const ctx = canvas.getContext('2d');
    // Render directo con el viewport escalado (sin transform): texto negro nítido.
    await page.render({ canvasContext: ctx, viewport, transform: undefined }).promise;
    wrapper.appendChild(canvas);

    // Capa de texto superpuesta al canvas para que el texto del PDF sea
    // seleccionable / buscable (el canvas es solo una imagen rasterizada).
    const tc = await page.getTextContent();
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width = Math.floor(viewport.width) + 'px';
    textLayer.style.height = Math.floor(viewport.height) + 'px';
    const textDivs = [];
    const textContentItemsStr = [];
    try {
      const tlTask = window.pdfjsLib.renderTextLayer({
        textContent: tc,
        container: textLayer,
        viewport,
        textDivs,
        textContentItemsStr,
      });
      await tlTask.promise;
    } catch (tlErr) {
      // Si la capa de texto falla, el visor sigue funcionando solo con canvas.
    }
    wrapper.appendChild(textLayer);

    // Marcado del fragmento: un único sistema, derivado de los spans de la capa
    // de texto (que pdf.js coloca pixel-perfect sobre el canvas). De ese modo el
    // resaltado queda siempre alineado con el texto real; los boundingBoxes solo
    // se usan como respaldo si no hay coincidencia de texto.
    if (n === targetPage) {
      let boxes = spansToBoxes(findFragmentSpans(textLayer, textDivs, fragmentText), textLayer);
      if (!boxes.length && targetBoxes.length) {
        boxes = targetBoxes
          .filter(b => b && b.x != null && b.y != null && b.width != null && b.height != null)
          .map(b => ({
            left: b.x * viewport.width,
            top: b.y * viewport.height,
            width: b.width * viewport.width,
            height: b.height * viewport.height,
          }));
      }
      for (const box of boxes) {
        const hl = document.createElement('div');
        hl.className = 'pdf-hl';
        hl.style.left = box.left + 'px';
        hl.style.top = box.top + 'px';
        hl.style.width = box.width + 'px';
        hl.style.height = box.height + 'px';
        wrapper.appendChild(hl);
      }
      wrapper.style.borderColor = 'var(--accent)';
      targetWrapper = wrapper;
    }
    viewerPdf.appendChild(wrapper);
  }

  if (targetWrapper) {
    targetWrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

// Devuelve los spans de la capa de texto que contienen el fragmento, mediante
// una coincidencia exacta y contigua sobre el texto normalizado (sin el fallback
// por palabras sueltas, que causaba marcas dispersas en distintas partes).
function findFragmentSpans(textLayer, textDivs, fragmentText) {
  const targets = textDivs && textDivs.length
    ? textDivs
    : Array.from((textLayer && textLayer.querySelectorAll('span')) || []);
  if (!fragmentText || targets.length === 0) return [];

  const norm = (s) => (s || '').replace(/\s+/g, ' ');
  const needle = norm(fragmentText.trim());
  if (!needle) return [];

  const normalized = targets.map(d => norm(d.textContent || ''));
  const joined = normalized.join('');
  const idx = joined.indexOf(needle);
  if (idx < 0) return []; // sin coincidencia → sin marcas dispersas

  const out = [];
  let acc = 0;
  for (let i = 0; i < targets.length; i++) {
    const len = Math.max(normalized[i].length, 1);
    const s = acc;
    const e = acc + len;
    if (e > idx && s < idx + needle.length) out.push(targets[i]);
    acc += len;
  }
  return out;
}

// Convierte los spans seleccionados en rectángulos por línea (uniendo los que
// comparten la misma fila vertical) con coordenadas relativas a la página.
function spansToBoxes(spans, textLayer) {
  if (!spans || spans.length === 0) return [];
  const base = textLayer.getBoundingClientRect();
  const rects = spans.map(s => {
    const r = s.getBoundingClientRect();
    return { left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top };
  });

  const rows = [];
  const overlapY = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  for (const r of rects) {
    const row = rows.find(x => {
      const ov = overlapY(x, r);
      const minH = Math.min(x.bottom - x.top, r.bottom - r.top);
      return minH > 0 && ov / minH > 0.4;
    });
    if (row) {
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
      row.left = Math.min(row.left, r.left);
      row.right = Math.max(row.right, r.right);
    } else {
      rows.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
  }

  rows.sort((a, b) => a.top - b.top);
  return rows.map(row => ({
    left: row.left,
    top: row.top,
    width: row.right - row.left,
    height: Math.max(row.bottom - row.top, 1),
  }));
}

// ─── Visor de Texto / Código / Markdown ─────────────────────────────────
async function renderText(docId, location) {
  const res = await fetch(`/api/documents/${docId}/file`);
  if (!res.ok) throw new Error('No se pudo cargar el archivo');
  const text = await res.text();

  const lines = text.split('\n');
  const frag = document.createDocumentFragment();
  const lineEls = [];

  for (let i = 0; i < lines.length; i++) {
    const div = document.createElement('div');
    div.className = 'viewer-line';
    div.dataset.line = i + 1;
    const no = document.createElement('span');
    no.className = 'viewer-line-no';
    no.textContent = String(i + 1);
    const code = document.createElement('span');
    code.className = 'viewer-line-code';
    code.textContent = lines[i] === '' ? ' ' : lines[i];
    div.appendChild(no);
    div.appendChild(code);
    frag.appendChild(div);
    lineEls.push(div);
  }
  viewerText.innerHTML = '';
  viewerText.appendChild(frag);

  const start = location?.startLine || 1;
  const end = location?.endLine || start;
  let firstHighlight = null;
  for (let i = start; i <= end && i <= lineEls.length; i++) {
    if (i >= 1) {
      lineEls[i - 1].classList.add('hl');
      if (!firstHighlight) firstHighlight = lineEls[i - 1];
    }
  }
  if (firstHighlight) {
    firstHighlight.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  btnSearchSel.style.display = location?.startLine ? 'inline-block' : 'none';
}

// ─── Selección → búsqueda semántica ─────────────────────────────────────
function currentSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  const text = sel.toString().trim();
  lastSelectionMenuSelection = viewerText.contains(sel.anchorNode) ? text : '';
  return text;
}

viewerText.addEventListener('mouseup', (e) => {
  const text = currentSelectionText();
  if (text && text.length > 2) {
    viewerMenu.style.display = 'block';
    positionMenu(e.clientX, e.clientY);
  } else {
    hideMenu();
  }
});

function positionMenu(x, y) {
  const rect = viewerEl.getBoundingClientRect();
  viewerMenu.style.left = Math.min(x, rect.right - 220) + 'px';
  viewerMenu.style.top = y + 8 + 'px';
}

function hideMenu() {
  viewerMenu.style.display = 'none';
}

viewerMenuSearch.addEventListener('click', () => {
  const q = lastSelectionMenuSelection;
  hideMenu();
  if (!q) return;
  if (window.searchGraphForText) window.searchGraphForText(q);
});

btnSearchSel.addEventListener('click', () => {
  const q = lastSelectionMenuSelection;
  if (q && window.searchGraphForText) window.searchGraphForText(q);
});

document.addEventListener('mousedown', (e) => {
  if (viewerMenu && !viewerMenu.contains(e.target)) hideMenu();
});