/**
 * RAG Studio — viewer.js
 * DocumentContextViewer: visor de documento fuente con salto a la ubicación exacta
 * de un chunk (página + bbox para PDF, rango de líneas para texto/código) y
 * resaltado con animación. Permite scroll libre del contexto completo.
 */

// ─── Refuerzos para el visor ─────────────────────────────────────────────
const viewerEl   = document.getElementById('doc-viewer');
const viewerTitle = document.getElementById('viewer-title');
const viewerTarget=document.getElementById('viewer-target');
const viewerScroll=document.getElementById('viewer-scroll');
const viewerPdf  = document.getElementById('viewer-pdf');
const viewerText = document.getElementById('viewer-text');
const viewerClose= document.getElementById('viewer-close');
const viewerMenu = document.getElementById('viewer-menu');
const viewerMenuSearch = document.getElementById('viewer-menu-search');
const btnSearchSel = document.getElementById('viewer-search-sel');

// Elementos del buscador interno
const searchBoxEl = document.getElementById('viewer-pdf-search-box');
const searchInputEl = document.getElementById('viewer-search-input');
const searchPrevEl = document.getElementById('viewer-search-prev');
const searchNextEl = document.getElementById('viewer-search-next');
const searchResultsEl = document.getElementById('viewer-search-results');

let lastDocInfo = null;   // { docId, mimeType, title }
let selectionText = null; // texto seleccionado dentro del visor
let lastSelectionMenuSelection = null;

// Estado del buscador interno
let currentSearchQuery = '';
let searchResults = []; // [{ page, lineIndex, spanIndex, textNodeIndex, matchIndex, ... }]
let activeSearchIndex = -1;
let pdfPagesText = []; // cache de textos de páginas del pdf { pageNumber -> string }
let docViewerPdfInstance = null; // Referencia al objeto pdfjs actual
let docViewerRenderedItems = []; // Referencia al array rendered de páginas
let rawTextLines = []; // Para búsqueda en archivos de texto plano

// ─── Navegador de Chunks (Fragmentos) y Selector de Color ──────────────────
const chunkNavEl = document.getElementById('viewer-chunk-nav');
const chunkStatusEl = document.getElementById('viewer-chunk-status');
const chunkPrevEl = document.getElementById('viewer-chunk-prev');
const chunkNextEl = document.getElementById('viewer-chunk-next');
const highlightColorInput = document.getElementById('viewer-highlight-color');
const pdfScaleSelect = document.getElementById('viewer-pdf-scale');
const scaleBoxEl = document.getElementById('viewer-scale-box');

let currentDocumentChunks = []; // todos los chunks del documento actual con ubicación válida
let activeChunkIndex = -1;      // índice del chunk actual
let currentActiveChunk = null;   // referencia al chunk activo actualmente

let currentPdfObjects = [];        // objetos de página precargados
let currentPdfLocation = null;      // ubicación original
let currentPdfFragmentText = null;    // fragmento original

if (pdfScaleSelect) {
  pdfScaleSelect.addEventListener('change', () => {
    if (docViewerPdfInstance) {
      reRenderPdfWithNewScale();
    }
  });
}

function hexToRgba(hex, alpha) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateHighlightColorStyles(hexColor) {
  const bgRgba = hexToRgba(hexColor, 0.35);
  const pulseRgba = hexToRgba(hexColor, 0.6);
  localStorage.setItem('viewer-highlight-color-hex', hexColor);

  document.documentElement.style.setProperty('--pdf-hl-color', bgRgba);
  document.documentElement.style.setProperty('--pdf-hl-pulse-color', pulseRgba);
  
  const textBgRgba = hexToRgba(hexColor, 0.18);
  const textBorderRgba = hexColor;
  document.documentElement.style.setProperty('--text-hl-color', textBgRgba);
  document.documentElement.style.setProperty('--text-hl-border-color', textBorderRgba);
}

// Inicializar el color preferido del resaltador
const defaultColor = localStorage.getItem('viewer-highlight-color-hex') || '#f59e0b';
if (highlightColorInput) {
  highlightColorInput.value = defaultColor;
  updateHighlightColorStyles(defaultColor);
  highlightColorInput.addEventListener('input', (e) => {
    updateHighlightColorStyles(e.target.value);
  });
}

function updateChunkNavUI() {
  if (!chunkStatusEl || !chunkPrevEl || !chunkNextEl) return;
  if (currentDocumentChunks.length === 0) {
    chunkStatusEl.textContent = 'Frag. 0/0';
    chunkPrevEl.disabled = true;
    chunkNextEl.disabled = true;
    return;
  }
  chunkStatusEl.textContent = `Frag. ${activeChunkIndex + 1}/${currentDocumentChunks.length}`;
  chunkPrevEl.disabled = activeChunkIndex <= 0;
  chunkNextEl.disabled = activeChunkIndex >= currentDocumentChunks.length - 1;
}

function clearActiveChunkHighlights() {
  document.querySelectorAll('.pdf-hl').forEach(el => el.remove());
  document.querySelectorAll('.viewer-line.hl').forEach(el => el.classList.remove('hl'));
}

function applyHighlightToRenderedPage(item, chunk) {
  const activeChunkText = chunk.raw_content;
  const activeChunkPage = chunk.location?.pageNumber;
  const textLayer = item.wrapper.querySelector('.textLayer');
  
  if (!activeChunkText) {
    item.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  
  let spans = [];
  if (activeChunkPage) {
    // Primero intenta resaltado exacto en la página especificada
    const localNeedleClean = getPageLocalNeedle(item.n, activeChunkText);
    if (localNeedleClean) {
      const textDivs = textLayer ? Array.from(textLayer.querySelectorAll('span')) : [];
      const pageItem = { n: item.n, wrapper: item.wrapper, viewport: item.viewport, textLayer, textDivs };
      const localSpans = findCleanFragmentOnPage(pageItem, localNeedleClean);
      if (localSpans.length) {
        spans = localSpans;
      }
    }
    // Si no se encontró en la página exacta, buscar en todas las páginas (fragmento cruzado)
    if (spans.length === 0) {
      const textDivs = textLayer ? Array.from(textLayer.querySelectorAll('span')) : [];
      const pageItem = { n: item.n, wrapper: item.wrapper, viewport: item.viewport, textLayer, textDivs };
      const crossPageSpans = findFragmentAcrossPages([pageItem], activeChunkText);
      if (crossPageSpans.size > 0) {
        for (const [pageNum, pageSpans] of crossPageSpans) {
          if (pageNum === item.n) {
            spans = pageSpans;
            break;
          }
        }
      }
    }
  } else {
    // Sin página definida: buscar en todas las páginas
    const textDivs = textLayer ? Array.from(textLayer.querySelectorAll('span')) : [];
    const pageItem = { n: item.n, wrapper: item.wrapper, viewport: item.viewport, textLayer, textDivs };
    spans = findFragmentAcrossPages([pageItem], activeChunkText)?.get(item.n) || [];
  }
  
  if (spans.length) {
    const boxes = spansToBoxes(spans, textLayer);
    let firstHl = null;
    for (const box of boxes) {
      const hl = makeHighlight(box);
      item.wrapper.appendChild(hl);
      if (!firstHl) firstHl = hl;
    }
    if (firstHl) {
      setTimeout(() => {
        firstHl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 100);
    }
  } else {
    item.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

async function jumpToChunk(index) {
  if (index < 0 || index >= currentDocumentChunks.length) return;
  activeChunkIndex = index;
  updateChunkNavUI();

  const chunk = currentDocumentChunks[activeChunkIndex];
  clearActiveChunkHighlights();
  currentActiveChunk = chunk;

  const label = [
    chunk.location?.pageNumber ? `Página ${chunk.location.pageNumber}` : null,
    chunk.location?.startLine ? `Línea ${chunk.location.startLine}${chunk.location.endLine ? `–${chunk.location.endLine}` : ''}` : null,
  ].filter(Boolean).join(' · ');
  viewerTarget.textContent = label ? `Fragmento → ${label}` : 'Documento completo';

  const isPdf = lastDocInfo && lastDocInfo.mimeType.includes('pdf');
  if (isPdf) {
    if (!docViewerPdfInstance || !docViewerRenderedItems) return;
    const pageNum = chunk.location.pageNumber || 1;
    const item = docViewerRenderedItems.find(r => r.n === pageNum);
    if (!item) return;

    if (!item.rendered) {
      item.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      applyHighlightToRenderedPage(item, chunk);
    }
  } else {
    const start = chunk.location.startLine || 1;
    const end = chunk.location.endLine || start;
    let firstHighlight = null;
    for (let i = start; i <= end; i++) {
      const lineEl = viewerText.querySelector(`.viewer-line[data-line="${i}"]`);
      if (lineEl) {
        lineEl.classList.add('hl');
        if (!firstHighlight) firstHighlight = lineEl;
      }
    }
    if (firstHighlight) {
      firstHighlight.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

if (chunkPrevEl && chunkNextEl) {
  chunkPrevEl.addEventListener('click', () => {
    if (activeChunkIndex > 0) {
      jumpToChunk(activeChunkIndex - 1);
    }
  });

  chunkNextEl.addEventListener('click', () => {
    if (activeChunkIndex < currentDocumentChunks.length - 1) {
      jumpToChunk(activeChunkIndex + 1);
    }
  });
}

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
window.openDocViewer = async function (docId, location, mimeType, title, fragmentText, paragraphId = null) {
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

  // Reiniciar buscador interno
  searchInputEl.value = '';
  searchResults = [];
  activeSearchIndex = -1;
  currentSearchQuery = '';
  searchResultsEl.textContent = '0/0';
  pdfPagesText = [];
  docViewerPdfInstance = null;
  docViewerRenderedItems = [];
  rawTextLines = [];

  // Elementos separadores condicionales
  const sep1 = document.getElementById('viewer-sep-1');
  const sep2 = document.getElementById('viewer-sep-2');

  if (isPdf) {
    if (searchBoxEl) searchBoxEl.style.display = 'flex';
    if (scaleBoxEl) scaleBoxEl.style.display = 'flex';
    if (sep1) sep1.style.display = 'block';
    if (sep2) sep2.style.display = 'block';
    if (pdfScaleSelect) pdfScaleSelect.value = 'auto'; // Zoom por defecto
  } else {
    if (searchBoxEl) searchBoxEl.style.display = 'none';
    if (scaleBoxEl) scaleBoxEl.style.display = 'none';
    if (sep1) sep1.style.display = 'none';
    if (sep2) sep2.style.display = 'none';
  }

  // Reiniciar navegador de fragmentos
  currentDocumentChunks = [];
  activeChunkIndex = -1;
  currentActiveChunk = paragraphId || location ? { location, raw_content: fragmentText, id: paragraphId } : null;
  if (chunkNavEl) chunkNavEl.style.display = 'none';

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

  // Cargar chunks para permitir navegación
  try {
    const chunks = await api(`/api/documents/${docId}/paragraphs`);
    currentDocumentChunks = chunks.filter(c => c.location && (c.location.pageNumber || c.location.startLine));
    if (currentDocumentChunks.length > 0) {
      if (paragraphId) {
        activeChunkIndex = currentDocumentChunks.findIndex(c => c.id === paragraphId);
      }
      if (activeChunkIndex === -1 && location) {
        activeChunkIndex = currentDocumentChunks.findIndex(c => 
          (location.pageNumber != null && c.location.pageNumber != null && c.location.pageNumber === location.pageNumber) ||
          (location.startLine != null && c.location.startLine != null && c.location.startLine === location.startLine) ||
          (location.startChar != null && c.location.startChar != null && c.location.startChar === location.startChar) ||
          (location.endChar != null && c.location.endChar != null && c.location.endChar === location.endChar)
        );
      }
      if (activeChunkIndex === -1) {
        activeChunkIndex = 0;
      }
      
      currentActiveChunk = currentDocumentChunks[activeChunkIndex];
      const activeChunkLabel = [
        currentActiveChunk.location?.pageNumber ? `Página ${currentActiveChunk.location.pageNumber}` : null,
        currentActiveChunk.location?.startLine ? `Línea ${currentActiveChunk.location.startLine}${currentActiveChunk.location.endLine ? `–${currentActiveChunk.location.endLine}` : ''}` : null,
      ].filter(Boolean).join(' · ');
      viewerTarget.textContent = activeChunkLabel ? `Fragmento → ${activeChunkLabel}` : 'Documento completo';

      if (chunkNavEl) chunkNavEl.style.display = 'flex';
      updateChunkNavUI();
    }
  } catch (err) {
    console.error('Error al cargar fragmentos del documento:', err);
  }
};

window.closeDocViewer = closeDocViewer;
function closeDocViewer() {
  viewerEl.style.display = 'none';
  viewerPdf.innerHTML = '';
  viewerText.innerHTML = '';
  hideMenu();
  if (pdfIntersectionObserver) {
    pdfIntersectionObserver.disconnect();
    pdfIntersectionObserver = null;
  }
  if (searchBoxEl) searchBoxEl.style.display = 'none';
  if (scaleBoxEl) scaleBoxEl.style.display = 'none';
  
  const sep1 = document.getElementById('viewer-sep-1');
  const sep2 = document.getElementById('viewer-sep-2');
  if (sep1) sep1.style.display = 'none';
  if (sep2) sep2.style.display = 'none';
  
  clearSearchHighlights();

  // Limpiar estado de fragmentos
  currentDocumentChunks = [];
  activeChunkIndex = -1;
  currentActiveChunk = null;
  if (chunkNavEl) chunkNavEl.style.display = 'none';

  // Limpiar estado de PDF zoom
  currentPdfObjects = [];
  currentPdfLocation = null;
  currentPdfFragmentText = null;
  if (pdfScaleSelect) pdfScaleSelect.value = 'auto';
}

// ─── Visor PDF (pdf.js) ──────────────────────────────────────────────────
let pdfIntersectionObserver = null;
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
  
  if (pdfIntersectionObserver) {
    pdfIntersectionObserver.disconnect();
    pdfIntersectionObserver = null;
  }

  const res = await fetch(`/api/documents/${docId}/file`);
  if (!res.ok) throw new Error('No se pudo cargar el archivo PDF');
  const data = await res.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data }).promise;

  const maxPages = Math.min(pdf.numPages, 80);
  pdfPagesText = [];
  currentPdfObjects = [];
  currentPdfLocation = location;
  currentPdfFragmentText = fragmentText;
  docViewerPdfInstance = pdf;

  // Precargar de forma concurrente el texto y los objetos de página
  const pagePromises = [];
  for (let n = 1; n <= maxPages; n++) {
    pagePromises.push(
      pdf.getPage(n).then(async (page) => {
        const tc = await page.getTextContent();
        pdfPagesText[n] = tc.items.map(item => item.str).join(' ');
        return page;
      }).catch(err => {
        console.error(`Error precargando página ${n}:`, err);
        return null;
      })
    );
  }

  const pagesObjects = await Promise.all(pagePromises);
  currentPdfObjects = pagesObjects.filter(Boolean);

  // Renderizar usando la escala configurada
  await reRenderPdfWithNewScale();
}

async function reRenderPdfWithNewScale() {
  if (!docViewerPdfInstance) return;

  if (pdfIntersectionObserver) {
    pdfIntersectionObserver.disconnect();
    pdfIntersectionObserver = null;
  }

  viewerPdf.innerHTML = '';
  const rendered = [];
  const scaleVal = pdfScaleSelect ? pdfScaleSelect.value : 'auto';

  // Configurar el IntersectionObserver para cargar las páginas perezosamente
  pdfIntersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const pageNum = Number(entry.target.dataset.page);
        const item = rendered.find(r => r.n === pageNum);
        if (item && !item.rendered) {
          renderPageContent(item, docViewerPdfInstance, currentPdfLocation, currentPdfFragmentText);
        }
      }
    });
  }, {
    root: viewerScroll,
    rootMargin: '300px 0px', // Pre-cargar páginas con 300px de margen vertical
    threshold: 0.01
  });

  docViewerRenderedItems = rendered;

  const maxPages = currentPdfObjects.length;
  for (let n = 1; n <= maxPages; n++) {
    const page = currentPdfObjects[n - 1];
    if (!page) continue;
    
    const base = page.getViewport({ scale: 1 });
    let scale;
    if (scaleVal === 'auto') {
      const containerWidth = viewerScroll.clientWidth - 40;
      scale = Math.min(1.8, containerWidth / base.width);
    } else {
      scale = parseFloat(scaleVal);
    }
    
    const viewport = page.getViewport({ scale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = n;
    wrapper.style.width = Math.floor(viewport.width) + 'px';
    wrapper.style.height = Math.floor(viewport.height) + 'px';

    const loader = document.createElement('div');
    loader.className = 'pdf-page-loader';
    loader.textContent = `Cargando página ${n}...`;
    wrapper.appendChild(loader);

    viewerPdf.appendChild(wrapper);

    rendered.push({
      n,
      wrapper,
      viewport,
      loader,
      rendered: false
    });

    pdfIntersectionObserver.observe(wrapper);
  }

  const activePageNo = currentActiveChunk?.location?.pageNumber || currentPdfLocation?.pageNumber || 1;
  const targetPageNo = Math.max(1, Math.min(activePageNo, maxPages));

  // Forzar el renderizado inmediato de la página objetivo para inyectar los resaltados
  const targetItem = rendered.find(r => r.n === targetPageNo);
  if (targetItem) {
    await renderPageContent(targetItem, docViewerPdfInstance, currentPdfLocation, currentPdfFragmentText);
  }

  // Hacer scroll centrado al fragmento resaltado, o al inicio de la página en su defecto
  setTimeout(() => {
    if (targetItem) {
      const hlDiv = targetItem.wrapper.querySelector('.pdf-hl');
      if (hlDiv) {
        hlDiv.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        targetItem.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
  }, 100);
}

async function renderPageContent(item, pdf, location, fragmentText) {
  if (item.rendered) return;
  item.rendered = true;

  try {
    const page = await pdf.getPage(item.n);
    const viewport = item.viewport;
    const wrapper = item.wrapper;

    // Crear y configurar canvas
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const ctx = canvas.getContext('2d');

    // Remover loader
    if (item.loader && item.loader.parentNode) {
      wrapper.removeChild(item.loader);
    }

    wrapper.appendChild(canvas);

    // Renderizar página en el canvas
    await page.render({ canvasContext: ctx, viewport, transform: undefined }).promise;

    // Crear capa de texto
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
      // Ignorar fallos de capa de texto
    }
    wrapper.appendChild(textLayer);

    // ── Resaltados para esta página específica (Búsqueda de fragmento en texto) ──
    const activeChunkText = currentActiveChunk ? currentActiveChunk.raw_content : fragmentText;
    const activeChunkPage = currentActiveChunk?.location?.pageNumber;
    
    if (!activeChunkText) return;
    
    let spans = [];
    if (activeChunkPage) {
      // Primero intenta el resaltado exacto en la página especificada
      const localNeedleClean = getPageLocalNeedle(item.n, activeChunkText);
      if (localNeedleClean) {
        const pageItem = { n: item.n, wrapper, viewport, textLayer, textDivs };
        const localSpans = findCleanFragmentOnPage(pageItem, localNeedleClean);
        if (localSpans.length) {
          spans = localSpans;
        }
      }
      // Si no se encontró en la página exacta, intentar búsqueda en todas las páginas
      // (para fragmentos que cruzan límites de página)
      if (spans.length === 0) {
        const pageItem = { n: item.n, wrapper, viewport, textLayer, textDivs };
        const crossPageSpans = findFragmentAcrossPages([pageItem], activeChunkText);
        if (crossPageSpans.size > 0) {
          for (const [pageNum, pageSpans] of crossPageSpans) {
            if (pageNum === item.n) {
              spans = pageSpans;
              break;
            }
          }
        }
      }
    } else {
      // Sin página definida: buscar en todas las páginas
      const pageItem = { n: item.n, wrapper, viewport, textLayer, textDivs };
      spans = findFragmentAcrossPages([pageItem], activeChunkText)?.get(item.n) || [];
    }
    
    if (spans.length) {
      const boxes = spansToBoxes(spans, textLayer);
      for (const box of boxes) {
        wrapper.appendChild(makeHighlight(box));
      }
      setTimeout(() => {
        const firstHl = wrapper.querySelector('.pdf-hl');
        if (firstHl) {
          firstHl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 100);
    }
  } catch (err) {
    console.error(`Error renderizando página ${item.n}:`, err);
    if (item.loader) {
      item.loader.textContent = `Error al cargar la página ${item.n}`;
    }
  }
}

// Resuelve la porción del fragmento de texto limpio (sin espacios) que corresponde a una página
function getPageLocalNeedle(pageNum, fragmentText) {
  if (!fragmentText || !pdfPagesText || pdfPagesText.length === 0) return null;

  // Convertir los textos planos de todas las páginas a limpio sin espacios
  const cleanPageTexts = pdfPagesText.map(t => (t || '').replace(/\s+/g, ''));
  const fullCleanText = cleanPageTexts.join('');

  // Calcular desplazamientos de caracteres limpios acumulados por página
  const pageOffsets = [];
  let acc = 0;
  for (let n = 1; n < cleanPageTexts.length; n++) {
    pageOffsets[n] = acc;
    acc += cleanPageTexts[n].length;
  }

  const cleanNeedle = fragmentText.replace(/\s+/g, '');
  const globalIdx = fullCleanText.toLowerCase().indexOf(cleanNeedle.toLowerCase());

  if (globalIdx === -1) return null;

  const globalStart = globalIdx;
  const globalEnd = globalIdx + cleanNeedle.length;

  const pageStart = pageOffsets[pageNum];
  const pageEnd = pageStart + (cleanPageTexts[pageNum] || '').length;

  // Evaluar solapamiento vertical/horizontal con la página actual
  const overlapStart = Math.max(globalStart, pageStart);
  const overlapEnd = Math.min(globalEnd, pageEnd);

  if (overlapStart < overlapEnd) {
    const localStart = overlapStart - pageStart;
    const localEnd = overlapEnd - pageStart;
    return cleanPageTexts[pageNum].substring(localStart, localEnd);
  }

  return null;
}

// Busca un fragmento limpio (sin espacios) directamente en los spans de una sola página
function findCleanFragmentOnPage(pageItem, cleanNeedle) {
  const spans = pageItem.textDivs && pageItem.textDivs.length
    ? pageItem.textDivs
    : Array.from((pageItem.textLayer && pageItem.textLayer.querySelectorAll('span')) || []);

  const globalCharMap = [];
  let nonSpaceText = '';

  for (const span of spans) {
    const text = span.textContent || '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (/\s/.test(char)) continue;
      nonSpaceText += char;
      globalCharMap.push(span);
    }
  }

  const idx = nonSpaceText.toLowerCase().indexOf(cleanNeedle.toLowerCase());
  const matchedSpans = [];
  if (idx !== -1) {
    for (let i = idx; i < idx + cleanNeedle.length; i++) {
      const span = globalCharMap[i];
      if (span && !matchedSpans.includes(span)) {
        matchedSpans.push(span);
      }
    }
  }
  return matchedSpans;
}

function makeHighlight(box) {
  const hl = document.createElement('div');
  hl.className = 'pdf-hl';
  hl.style.left = box.left + 'px';
  hl.style.top = box.top + 'px';
  hl.style.width = box.width + 'px';
  hl.style.height = box.height + 'px';
  return hl;
}

// Busca el fragmento a lo largo de todas las páginas renderizadas (el texto de un
// chunk puede cruzar límites de página o verse alterado por la limpieza). Devuelve
// un Map { pageNumber -> [spans] } con los spans que contienen partes del fragmento,
// o un Map vacío si no hay coincidencia.
function findFragmentAcrossPages(rendered, fragmentText) {
  const out = new Map();
  if (!rendered || rendered.length === 0) return out;

  // Normalizar eliminando todo tipo de espacios en blanco para evitar problemas
  // con la división de spans de PDF.js
  const cleanStr = (s) => (s || '').replace(/\s+/g, '');
  const needle = cleanStr(fragmentText);
  if (!needle) return out;

  // 1. Recolectar spans de las páginas y construir el mapa de caracteres a nivel global
  const globalCharMap = [];
  let nonSpaceText = '';

  for (const { n, textLayer, textDivs } of rendered) {
    const targets = textDivs && textDivs.length
      ? textDivs
      : Array.from((textLayer && textLayer.querySelectorAll('span')) || []);

    for (const span of targets) {
      const text = span.textContent || '';
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (/\s/.test(char)) {
          // Es un espacio en blanco en el DOM, lo ignoramos para la aguja limpia
          continue;
        }
        nonSpaceText += char;
        globalCharMap.push({ pageNum: n, span });
      }
    }
  }

  // 2. Buscar la aguja limpia en el texto plano consolidado libre de espacios
  const idx = nonSpaceText.toLowerCase().indexOf(needle.toLowerCase());
  if (idx !== -1) {
    // 3. Mapear la coincidencia exacta de vuelta a sus spans originales en el DOM
    for (let i = idx; i < idx + needle.length; i++) {
      const mapped = globalCharMap[i];
      if (mapped) {
        if (!out.has(mapped.pageNum)) {
          out.set(mapped.pageNum, []);
        }
        const list = out.get(mapped.pageNum);
        if (!list.includes(mapped.span)) {
          list.push(mapped.span);
        }
      }
    }
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
  rawTextLines = lines;
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
  lastSelectionMenuSelection = (viewerText.contains(sel.anchorNode) || viewerPdf.contains(sel.anchorNode)) ? text : '';
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

viewerPdf.addEventListener('mouseup', (e) => {
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

// ─── Funciones del Buscador Interno de Documentos ──────────────────────────
function clearSearchHighlights() {
  // Limpiar resaltados de PDF
  document.querySelectorAll('.pdf-search-hl').forEach(el => el.remove());
  // Limpiar resaltados de Texto/Código
  document.querySelectorAll('.viewer-search-match-line, .viewer-search-match-line-active').forEach(el => {
    el.classList.remove('viewer-search-match-line', 'viewer-search-match-line-active');
  });
}

function executeSearch(query) {
  clearSearchHighlights();
  searchResults = [];
  activeSearchIndex = -1;
  searchResultsEl.textContent = '0/0';

  if (!query) return;

  const isPdf = lastDocInfo && lastDocInfo.mimeType.includes('pdf');
  const q = query.toLowerCase();

  if (isPdf) {
    if (!docViewerPdfInstance) return;
    for (let pageNum = 1; pageNum < pdfPagesText.length; pageNum++) {
      const text = pdfPagesText[pageNum] || '';
      let idx = text.toLowerCase().indexOf(q);
      while (idx !== -1) {
        searchResults.push({
          type: 'pdf',
          page: pageNum,
          index: idx,
          query: query
        });
        idx = text.toLowerCase().indexOf(q, idx + q.length);
      }
    }
  } else {
    for (let lineIdx = 0; lineIdx < rawTextLines.length; lineIdx++) {
      const text = rawTextLines[lineIdx] || '';
      let idx = text.toLowerCase().indexOf(q);
      while (idx !== -1) {
        searchResults.push({
          type: 'text',
          line: lineIdx + 1,
          index: idx,
          query: query
        });
        idx = text.toLowerCase().indexOf(q, idx + q.length);
      }
    }
  }

  if (searchResults.length > 0) {
    activeSearchIndex = 0;
    navigateToSearchMatch(0);
  } else {
    searchResultsEl.textContent = '0/0';
  }
}

async function navigateToSearchMatch(idx) {
  if (searchResults.length === 0 || idx < 0 || idx >= searchResults.length) return;

  clearSearchHighlights();
  searchResultsEl.textContent = `${idx + 1}/${searchResults.length}`;

  const match = searchResults[idx];

  if (match.type === 'pdf') {
    if (!docViewerPdfInstance || !docViewerRenderedItems) return;
    const item = docViewerRenderedItems.find(r => r.n === match.page);
    if (!item) return;

    // Asegurar que la página esté renderizada
    if (!item.rendered) {
      await renderPageContent(item, docViewerPdfInstance, lastDocInfo.location, lastDocInfo.fragmentText);
    }

    // Scroll a la página
    item.wrapper.scrollIntoView({ block: 'start', behavior: 'smooth' });

    // Buscar y dibujar coincidencias en el DOM de la capa de texto
    const textLayer = item.wrapper.querySelector('.textLayer');
    if (textLayer) {
      const pageItem = {
        n: item.n,
        wrapper: item.wrapper,
        viewport: item.viewport,
        textLayer: textLayer,
        textDivs: Array.from(textLayer.querySelectorAll('span'))
      };

      const matchedLinePerPage = findFragmentAcrossPages([pageItem], match.query);
      const spans = matchedLinePerPage.get(item.n) || [];
      if (spans.length) {
        const boxes = spansToBoxes(spans, textLayer);
        let activeHl = null;
        boxes.forEach((box, bIdx) => {
          const hl = document.createElement('div');
          hl.className = 'pdf-search-hl';
          hl.style.left = box.left + 'px';
          hl.style.top = box.top + 'px';
          hl.style.width = box.width + 'px';
          hl.style.height = box.height + 'px';
          
          if (bIdx === 0) {
            hl.classList.add('pdf-search-hl-active');
            activeHl = hl;
          }
          item.wrapper.appendChild(hl);
        });

        if (activeHl) {
          setTimeout(() => {
            activeHl.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 100);
        }
      }
    }
  } else {
    // Modo texto
    const lineEl = viewerText.querySelector(`.viewer-line[data-line="${match.line}"]`);
    if (lineEl) {
      lineEl.classList.add('viewer-search-match-line', 'viewer-search-match-line-active');
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// ─── Listeners del Buscador Interno ────────────────────────────────────────
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const query = searchInputEl.value.trim();
    if (query !== currentSearchQuery) {
      currentSearchQuery = query;
      executeSearch(query);
    } else if (searchResults.length > 0) {
      activeSearchIndex = (activeSearchIndex + 1) % searchResults.length;
      navigateToSearchMatch(activeSearchIndex);
    }
  }
});

searchPrevEl.addEventListener('click', () => {
  if (searchResults.length === 0) return;
  activeSearchIndex = (activeSearchIndex - 1 + searchResults.length) % searchResults.length;
  navigateToSearchMatch(activeSearchIndex);
});

searchNextEl.addEventListener('click', () => {
  if (searchResults.length === 0) return;
  activeSearchIndex = (activeSearchIndex + 1) % searchResults.length;
  navigateToSearchMatch(activeSearchIndex);
});