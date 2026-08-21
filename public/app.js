/**
 * RAG Studio — app.js
 * Frontend logic: document management, vis-network graph, chat RAG.
 */

// ─── API base URL ───────────────────────────────────────────────────────────
// ─── API base URL ───────────────────────────────────────────────────────────
let BASE_URL = window.location.origin; // Usa el dominio actual en la web

// Ocultar controles y ajustar interfaz si es navegador web convencional
if (!window.electronAPI) {
  const tb = document.getElementById('titlebar');
  if (tb) tb.style.display = 'none';
  document.documentElement.style.setProperty('--titlebar-h', '0px');
}

// ─── State ──────────────────────────────────────────────────────────────────
let documents = [];
let currentPage = 1;
const PAGE_SIZE = 8;

let network = null;
let nodesDS = null;
let edgesDS = null;
let allParagraphs = []; // { id, document_id, paragraph_index, raw_content, contextualized_text }
let semanticRelations = []; // Cache of calculated semantic relations

// ─── vis-network global reference ───────────────────────────────────────────
function getVis() {
  return window.vis;
}

// ─── DOM refs ────────────────────────────────────────────────────────────────
const docList      = document.getElementById('doc-list');
const docCount     = document.getElementById('doc-count');
const pagination   = document.getElementById('pagination');
const uploadZone   = document.getElementById('upload-zone');
const uploadQueue  = document.getElementById('upload-queue');
const btnPickFile  = document.getElementById('btn-pick-file');
const graphCont    = document.getElementById('graph-container');
const graphInput   = document.getElementById('graph-query-input');
const btnGQuery    = document.getElementById('btn-graph-query');
const nodeDetail   = document.getElementById('node-detail');
const nodeDetailT  = document.getElementById('node-detail-title');
const nodeDetailB  = document.getElementById('node-detail-body');
const nodeDetailCl = document.getElementById('node-detail-close');
const nodeDetailView = document.getElementById('node-detail-view');
const nodeDetailEgo = document.getElementById('node-detail-ego');
const btnEgoExit   = document.getElementById('btn-ego-exit');
let lastSelNode = null;
let egoCenterId = null; // Modo fragmento: null = grafo completo, uuid = fragmento centro
const chatMsgs     = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const btnSend      = document.getElementById('btn-send');
const btnResetG    = document.getElementById('btn-reset-graph');
const btnFitG      = document.getElementById('btn-fit-graph');

// ─── Window controls ─────────────────────────────────────────────────────────
if (window.electronAPI) {
  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
  document.getElementById('btn-close').addEventListener('click',    () => window.electronAPI.close());
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── Resizer ──────────────────────────────────────────────────────────────────
const panelLeft = document.getElementById('panel-left');
const resizer   = document.getElementById('resizer');
let isResizing  = false;

resizer.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizer.classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  const newW = Math.min(Math.max(e.clientX, 220), 600);
  panelLeft.style.width = newW + 'px';
});
document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizer.classList.remove('active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (network) network.redraw();
});

// ─── API helpers ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(BASE_URL + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ─── Documents ───────────────────────────────────────────────────────────────
async function fetchDocuments() {
  try {
    documents = await api('/api/documents');
    renderDocList();
    // La capa inter-documental solo tiene sentido con 2+ documentos
    const crossdocBox = document.getElementById('crossdoc-container');
    if (crossdocBox) {
      crossdocBox.style.display = documents.length > 1 ? '' : 'none';
      if (documents.length <= 1) {
        const c = document.getElementById('toggle-crossdoc');
        if (c) c.checked = false;
      }
    }
    await refreshGraph();
  } catch (e) {
    console.error('fetchDocuments', e);
  }
}

function renderDocList() {
  docCount.textContent = documents.length;
  const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const slice = documents.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (slice.length === 0) {
    docList.innerHTML = '<div class="empty-state">No hay documentos cargados aún.</div>';
  } else {
    docList.innerHTML = slice.map(d => {
      const ext = (d.mime_type || '').split('/').pop()?.split('.').pop() || '?';
      const date = new Date(d.created_at).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' });
      const frags = d.paragraph_count ?? '—';
      return `
        <div class="doc-row" data-id="${d.id}" title="${d.title}">
          <span class="doc-row-name">${d.title}</span>
          <span class="doc-row-type">${ext}</span>
          <span class="doc-row-frags">${frags}</span>
          <button class="doc-row-del" data-id="${d.id}" title="Eliminar">🗑</button>
        </div>`;
    }).join('');
  }

  // Pagination
  if (totalPages <= 1) {
    pagination.innerHTML = '';
  } else {
    pagination.innerHTML = Array.from({ length: totalPages }, (_, i) =>
      `<button class="page-btn${i + 1 === currentPage ? ' active' : ''}" data-page="${i+1}">${i+1}</button>`
    ).join('');
  }
}

// Event delegation for doc list
docList.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('.doc-row-del');
  if (delBtn) {
    const id = delBtn.dataset.id;
    if (!confirm('¿Eliminar este documento y todos sus fragmentos?')) return;
    try {
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      await fetchDocuments();
    } catch (err) {
      alert('Error al eliminar: ' + err.message);
    }
  }
});

pagination.addEventListener('click', (e) => {
  const btn = e.target.closest('.page-btn');
  if (btn) {
    currentPage = parseInt(btn.dataset.page);
    renderDocList();
  }
});

// ─── Upload ───────────────────────────────────────────────────────────────────
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  for (const file of files) await uploadFile(file);
});

btnPickFile.addEventListener('click', async () => {
  if (window.electronAPI) {
    const paths = await window.electronAPI.openFile();
    if (!paths || paths.length === 0) return;
    const { readFileSync } = await import('node:fs');  // only in electron context
    for (const p of paths) {
      const buffer = readFileSync(p);
      const name = p.split(/[\\/]/).pop();
      const file = new File([buffer], name);
      await uploadFile(file);
    }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.docx,.txt,.md,.xml';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      input.remove();
      for (const file of files) await uploadFile(file);
    };
    input.click();
  }
});

async function uploadFile(file) {
  const item = createUploadItem(file.name);
  const fd = new FormData();
  fd.append('file', file);

  const strategy = document.getElementById('ingest-strategy')?.value || 'auto';
  fd.append('chunkingStrategy', strategy);
  if (strategy === 'legal') {
    fd.append('domain', 'legal');
    fd.append('fileType', 'pdf_normativo');
  } else if (strategy === 'generic') {
    fd.append('domain', 'general');
  }

  setProgress(item, 30, 'Subiendo…');

  try {
    setProgress(item, 60, 'Procesando…');
    const res = await api('/api/upload', { method: 'POST', body: fd });
    const stratName = res.strategy === 'legal' ? 'Legal' : res.strategy === 'generic' ? 'Genérica' : '';
    const stratOrigin = res.strategySource === 'detected' ? ' (detectada)' : res.strategySource === 'manual' ? ' (manual)' : '';
    setProgress(item, 100, `✓ ${res.childChunksStored ?? res.paragraphsProcessed ?? ''} fragmentos${stratName ? ` · ${stratName}${stratOrigin}` : ''}`, 'ok');
    setTimeout(() => item.remove(), 4000);
    await fetchDocuments();
  } catch (err) {
    setProgress(item, 100, '✗ ' + err.message, 'err');
  }
}

function createUploadItem(name) {
  const el = document.createElement('div');
  el.className = 'upload-item';
  el.innerHTML = `
    <span class="upload-item-name">${name}</span>
    <div class="upload-item-bar"><div class="upload-item-bar-fill" style="width:0%"></div></div>
    <span class="upload-item-status"></span>`;
  uploadQueue.appendChild(el);
  return el;
}
function setProgress(item, pct, msg, cls = '') {
  item.querySelector('.upload-item-bar-fill').style.width = pct + '%';
  const s = item.querySelector('.upload-item-status');
  s.textContent = msg;
  s.className = 'upload-item-status ' + cls;
}

// Helper para generar paleta de colores HSLA consistente y armoniosa por documento
function getDocumentColors(index, total) {
  const hue = (index * (360 / Math.max(total, 1))) % 360;
  return {
    hue: hue,
    docBg: `hsla(${hue}, 55%, 22%, 1)`,
    docBorder: `hsla(${hue}, 85%, 60%, 1)`,
    docHoverBg: `hsla(${hue}, 70%, 35%, 1)`,
    docHoverBorder: `hsla(${hue}, 85%, 65%, 1)`,
    docText: `hsla(${hue}, 85%, 65%, 1)`,
    
    fragBg: `hsla(${hue}, 45%, 15%, 1)`,
    fragBorder: `hsla(${hue}, 65%, 45%, 1)`,
    fragHoverBg: `hsla(${hue}, 60%, 28%, 1)`,
    fragHoverBorder: `hsla(${hue}, 75%, 55%, 1)`,
    fragText: `hsla(${hue}, 70%, 75%, 1)`,
    
    hierarchyEdge: `hsla(${hue}, 65%, 45%, 0.28)`,
    sequentialEdge: `hsla(${hue}, 65%, 45%, 0.14)`
  };
}

// ─── Graph (vis-network) ──────────────────────────────────────────────────────
async function initGraph() {
  const vis = getVis();
  nodesDS = new vis.DataSet();
  edgesDS = new vis.DataSet();

  const options = {
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -220, // Mayor repulsión para evitar colapso
        centralGravity: 0.005,       // Poca gravedad central para separar clusters
        springLength: 180,           // Longitud base para las relaciones jerárquicas
        springConstant: 0.06         // Flexibilidad
      },
      stabilization: { 
        enabled: true, 
        iterations: 400,
        updateInterval: 25
      },
      // La física queda activa tras estabilizar para que los nodos se puedan
      // arrastrar de forma elástica (moviendo el clúster conectado). La velocidad
      // mínima alta hace que los nodos se detengan una vez asentados, evitando
      // que sigan orbitando indefinidamente y que sea difícil clickearlos.
      minVelocity: 4,
      maxVelocity: 50,
      timestep: 0.5,
      wind: { x: 0, y: 0 },
      adaptiveTimestep: true,
      smoothSimulation: true
    },
    nodes: {
      shape: 'dot',
      font: { color: '#8b949e', size: 11, face: 'Inter' },
      borderWidth: 1.5,
      chosen: true,
    },
    edges: {
      width: 1,
      color: { color: '#30363d', hover: '#484f58' },
      smooth: { type: 'continuous', roundness: 0.5 },
      arrows: { to: false },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
      zoomView: true,
      dragView: true,
    },
    layout: { improvedLayout: true },
  };

  network = new vis.Network(graphCont, { nodes: nodesDS, edges: edgesDS }, options);

  // Cuando se estabiliza por primera vez simplemente dejamos la física en
  // movimiento suave (no la apagamos) para que los nodos puedan arrastrarse
  // elásticamente, tanto con relaciones activas como sin ellas.
  network.on("stabilizationIterationsDone", function () {
    network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
  });

  network.on('click', (params) => {
    if (params.nodes.length === 0) { nodeDetail.style.display = 'none'; updateNodeViewButton(null); return; }
    const nodeId = params.nodes[0];
    const node = nodesDS.get(nodeId);
    if (!node) return;

    // En modo fragmento el clic sobre un vecino SOLO muestra su detalle;
    // NO re-centra el grafo. Para re-centrar se usa el botón "🌐 Ver sus relaciones".
    let title = node.label || node.id;
    if (node._type === 'frag' && node._docId) {
      const doc = documents.find(d => d.id === node._docId);
      if (doc) {
        title += ` — ${doc.title}`;
      }
    }
    
    nodeDetailT.textContent = title;
    nodeDetailB.textContent = node._content || '';
    nodeDetail.style.display = 'block';
    updateNodeViewButton(node); // solo muestra el botón "Ver en PDF/documento"
  });

  nodeDetailCl.addEventListener('click', () => { nodeDetail.style.display = 'none'; });

  // Modo fragmento: ver SOLO las relaciones del fragmento seleccionado
  nodeDetailEgo.addEventListener('click', () => {
    if (!lastSelNode || lastSelNode._type !== 'frag') return;
    enterEgoMode(lastSelNode._paraId || lastSelNode.id.replace('frag-', ''));
  });
  btnEgoExit.addEventListener('click', () => exitEgoMode());

  // Botón único para abrir el visor del documento original (fragmento seleccionado)
  nodeDetailView.addEventListener('click', () => {
    if (!lastSelNode || lastSelNode._type !== 'frag' || !lastSelNode._docId) return;
    const doc = documents.find(d => d.id === lastSelNode._docId);
    window.openDocViewer?.(lastSelNode._docId, lastSelNode._location, lastSelNode._docMime, doc?.title, lastSelNode._content);
  });
  btnResetG.addEventListener('click', () => {
    network.setOptions({ physics: { enabled: true } });
    network.stabilize(150);
  });
  btnFitG.addEventListener('click', () => network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } }));

  // Slider events
  const slider = document.getElementById('similarity-threshold');
  const thresholdVal = document.getElementById('threshold-val');
  if (slider && thresholdVal) {
    slider.addEventListener('input', (e) => {
      thresholdVal.textContent = e.target.value;
    });
    slider.addEventListener('change', async () => {
      // Reactivar físicas dinámicas para reacomodar tras cambiar el slider
      network.setOptions({ physics: { enabled: true } });
      if (egoCenterId) {
        await renderEgoGraph();
      } else {
        await updateSemanticRelations();
      }
    });
  }

  // Toggle relations checkbox
  const toggleRelations = document.getElementById('toggle-relations');
  if (toggleRelations) {
    toggleRelations.addEventListener('change', async () => {
      network.setOptions({ physics: { enabled: true } });
      if (egoCenterId) {
        await renderEgoGraph();
      } else {
        await updateSemanticRelations();
      }
    });
  }

  // Toggle capa inter-documental (solo relaciones entre documentos)
  const crossdocToggle = document.getElementById('toggle-crossdoc');
  if (crossdocToggle) {
    crossdocToggle.addEventListener('change', async () => {
      network.setOptions({ physics: { enabled: true } });
      if (egoCenterId) {
        await renderEgoGraph();
      } else {
        await updateSemanticRelations();
      }
    });
  }
}

// ─── Modo fragmento (ego-graph unitario) ────────────────────────────────────
// Muestra UN fragmento como centro y SOLO sus relaciones semánticas con otros
// fragmentos (1 hop). El slider gradua el umbral/cantidad igual que en el grafo
// completo. Hacer clic en un vecino re-centra el grafo en él.
function enterEgoMode(paraId) {
  if (!nodesDS || !edgesDS || !paraId) return;

  let node = nodesDS.get(`frag-${paraId}`);
  const para = allParagraphs.find(p => p.id === paraId);

  if (!node && !para) return;
  if (!node && para) {
    const colors = getDocumentColors(
      Math.max(documents.findIndex(d => d.id === para.document_id), 0),
      Math.max(documents.length, 1)
    );
    node = {
      id: `frag-${paraId}`,
      label: `F${para.paragraph_index + 1}`,
      _type: 'frag',
      _paraId: paraId,
      _docId: para.document_id,
      _docMime: documents.find(d => d.id === para.document_id)?.mime_type,
      _baseColors: colors,
      _location: para.location,
      _content: para.raw_content,
    };
  }

  // Conservar el contenido original del fragmento centro para el panel lateral
  lastSelNode = node;
  egoCenterId = paraId;
  if (btnEgoExit) btnEgoExit.style.display = 'inline-flex';
  network.setOptions({ physics: { enabled: true } });
  renderEgoGraph();
}

function exitEgoMode() {
  egoCenterId = null;
  if (btnEgoExit) btnEgoExit.style.display = 'none';
  nodeDetail.style.display = 'none';
  refreshGraph();
}

async function renderEgoGraph() {
  if (!egoCenterId || !nodesDS || !edgesDS) return;

  const centerPara = allParagraphs.find(p => p.id === egoCenterId);
  if (!centerPara) return;

  const docIdx = documents.findIndex(d => d.id === centerPara.document_id);
  const colors = getDocumentColors(Math.max(docIdx, 0), Math.max(documents.length, 1));

  const slider = document.getElementById('similarity-threshold');
  const sliderPct = slider ? parseFloat(slider.value) : 75;
  const threshold = sliderPct / 100;
  const maxRelations = Math.round(2000 * ((100 - sliderPct) / 50));

  const paragraphIds = allParagraphs.map(p => p.id);

  const crossDocToggle = document.getElementById('toggle-crossdoc');
  const crossDoc = crossDocToggle ? crossDocToggle.checked : false;

  let relations = [];
  try {
    const response = await api('/api/query/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paragraphIds, threshold, maxRelations, centerId: egoCenterId, crossDoc }),
    });
    relations = response.relations || [];
    semanticRelations = relations;
  } catch (err) {
    console.error('Error al cargar relaciones del fragmento:', err);
  }

  // Reconstruir el grafo: solo centro + vecinos con relación + aristas 1-hop
  nodesDS.clear();
  edgesDS.clear();

  nodesDS.add({
    id: `frag-${egoCenterId}`,
    label: `F${centerPara.paragraph_index + 1}`,
    size: 18,
    color: {
      background: colors.docBorder,
      border: '#ffffff',
      hover: { background: colors.docHoverBorder, border: '#ffffff' }
    },
    font: { color: '#ffffff', size: 13, bold: true },
    _type: 'frag',
    _paraId: egoCenterId,
    _docId: centerPara.document_id,
    _docMime: documents.find(d => d.id === centerPara.document_id)?.mime_type,
    _baseColors: colors,
    _location: centerPara.location,
    _content: centerPara.raw_content,
  });

  const added = new Set([egoCenterId]);
  relations.forEach(rel => {
    const otherId = rel.source_id === egoCenterId ? rel.target_id : rel.source_id;
    if (added.has(otherId)) return;
    added.add(otherId);

    const other = allParagraphs.find(p => p.id === otherId);
    if (!other) return;

    const oColors = getDocumentColors(
      Math.max(documents.findIndex(d => d.id === other.document_id), 0),
      Math.max(documents.length, 1)
    );

    nodesDS.add({
      id: `frag-${otherId}`,
      label: `F${other.paragraph_index + 1}`,
      size: 10,
      color: {
        background: oColors.fragBg,
        border: oColors.fragBorder,
        hover: { background: oColors.fragHoverBg, border: oColors.fragHoverBorder }
      },
      font: { color: oColors.fragText, size: 10 },
      _type: 'frag',
      _paraId: otherId,
_docId: other.document_id,
      _docMime: documents.find(d => d.id === other.document_id)?.mime_type,
      _location: other.location,
      _content: other.raw_content,
    });

    const pct = Math.round(rel.similarity * 100);
    edgesDS.add({
      from: `frag-${egoCenterId}`,
      to: `frag-${otherId}`,
      label: `${pct}%`,
      width: 1 + rel.similarity * 4,
      length: 160 + 140 * (1 - rel.similarity),
      color: { color: getSemanticColor(rel.similarity), hover: getSemanticColor(rel.similarity) },
      font: { color: '#8b949e', size: 10, background: '#0d1117' },
      physics: true,
      _type: 'semantic'
    });
  });

  network.stabilize(200);

  // Actualizar el panel de detalle con el resumen del fragmento centro
  nodeDetailT.textContent = `F${centerPara.paragraph_index + 1} — Fragmento central`;
  nodeDetailB.textContent = centerPara.raw_content || '';
  if (relations.length > 0) {
    nodeDetailB.textContent += `\n\n--- ${relations.length} relación(es) semántica(s) ---`;
  }
  nodeDetail.style.display = 'block';
  updateNodeViewButton({
    _type: 'frag',
    _paraId: egoCenterId,
    _docId: centerPara.document_id,
  });
}

async function refreshGraph() {
  if (!nodesDS) return;

  // Reactivar físicas para reacomodar los nuevos elementos
  network.setOptions({ physics: { enabled: true } });

  nodesDS.clear();
  edgesDS.clear();
  allParagraphs = [];

  const totalDocs = documents.length;

  const legendContainer = document.getElementById('graph-legend');
  if (legendContainer) {
    if (totalDocs === 0) {
      legendContainer.innerHTML = '<span class="legend-item-static">No hay documentos</span>';
    } else {
      legendContainer.innerHTML = '';
    }
  }

  // Fetch paragraphs for all docs
  documents.forEach((doc, docIdx) => {
    const colors = getDocumentColors(docIdx, totalDocs);

    if (legendContainer) {
      legendContainer.innerHTML += `<span class="legend-item-static" title="${doc.title}"><span class="legend-dot" style="background:${colors.docBg};border:1px solid ${colors.docBorder}"></span>${doc.title.length > 12 ? doc.title.slice(0, 12) + '…' : doc.title}</span>`;
    }

    // Document node con color personalizado de su paleta
    nodesDS.add({
      id: `doc-${doc.id}`,
      label: doc.title.length > 22 ? doc.title.slice(0, 22) + '…' : doc.title,
      size: 22,
      color: { 
        background: colors.docBg, 
        border: colors.docBorder, 
        hover: { background: colors.docHoverBg, border: colors.docHoverBorder } 
      },
      font: { color: colors.docText, size: 13, bold: true },
      _type: 'doc',
      _docId: doc.id,
      _baseColors: colors,
      _content: `📄 ${doc.title}\nTipo: ${doc.mime_type || 'desconocido'}`,
    });

    // Fetch paragraphs for this doc
    api(`/api/documents/${doc.id}/paragraphs`)
      .then(paras => {
        // Ordenamos por paragraph_index para asegurar la consistencia secuencial
        paras.sort((a, b) => a.paragraph_index - b.paragraph_index);

        paras.forEach((p, idx) => {
          // El endpoint de párrafos no devuelve document_id: se adjunta aquí
          // para que el modo fragmento (ego) pueda ubicar colores y docs.
          const enriched = { ...p, document_id: doc.id };
          allParagraphs.push(enriched);

          const fragId = `frag-${p.id}`;
          
          nodesDS.add({
            id: fragId,
            label: `F${p.paragraph_index + 1}`,
            size: 10,
            color: { 
              background: colors.fragBg, 
              border: colors.fragBorder, 
              hover: { background: colors.fragHoverBg, border: colors.fragHoverBorder } 
            },
            font: { color: colors.fragText, size: 10 },
            _type: 'frag',
            _paraId: p.id,
            _docId: doc.id,
            _docMime: doc.mime_type,
            _baseColors: colors,
            _location: p.location,
            _content: p.raw_content,
          });

          // Enlace Jerárquico (Documento -> Fragmento)
          edgesDS.add({
            from: `doc-${doc.id}`,
            to: fragId,
            color: { color: colors.hierarchyEdge, hover: colors.fragBorder },
            _type: 'hierarchy',
            _docId: doc.id
          });

          // Enlace Secuencial (Fragmento anterior -> Fragmento actual)
          if (idx > 0) {
            const prevFragId = `frag-${paras[idx - 1].id}`;
            edgesDS.add({
              from: prevFragId,
              to: fragId,
              width: 0.8,
              color: { color: colors.sequentialEdge, hover: colors.fragBorder },
              arrows: { to: { enabled: true, scaleFactor: 0.5 } },
              physics: true,
              _type: 'sequential',
              _docId: doc.id
            });
          }
        });
      })
      .catch(e => {
        console.warn('paragraphs fetch skipped for', doc.id, e.message);
      })
      .finally(() => {
        // Ejecutar relaciones semánticas una vez cargados todos los documentos
        if (docIdx === totalDocs - 1) {
          setTimeout(updateSemanticRelations, 150);
        }
      });
  });
}

function getSemanticColor(similarity) {
  const t = Math.max(0, Math.min(1, (similarity - 0.7) / 0.3));
  
  const r = Math.round(124 + t * (63 - 124));
  const g = Math.round(58 + t * (185 - 58));
  const b = Math.round(237 + t * (80 - 237));
  
  return `rgba(${r}, ${g}, ${b}, ${0.3 + t * 0.7})`;
}

function getSemanticWidth(similarity) {
  return 1 + similarity * 4;
}

async function updateSemanticRelations() {
  if (!edgesDS) return;

  // 1. Eliminar relaciones semánticas anteriores
  const prevSemantic = edgesDS.get({
    filter: (edge) => edge._type === 'semantic'
  });
  if (prevSemantic.length > 0) {
    edgesDS.remove(prevSemantic.map(e => e.id));
  }

  if (allParagraphs.length === 0) return;

  const toggleRelations = document.getElementById('toggle-relations');
  const showRelations = toggleRelations ? toggleRelations.checked : true;

  if (!showRelations) {
    semanticRelations = [];
    return;
  }

  // 2. Obtener el umbral actual en formato decimal
  const slider = document.getElementById('similarity-threshold');
  const threshold = slider ? parseFloat(slider.value) / 100 : 0.75;

  try {
    const paragraphIds = allParagraphs.map(p => p.id);
    // La cantidad de relaciones pintadas se gradúa con el mismo slider:
    // umbral alto → pocas (solo las más similares), umbral bajo → hasta 2000.
    // El cap evita que vis-network se congele con miles de aristas.
    const sliderPct = slider ? parseFloat(slider.value) : 75;
    const maxRelations = Math.round(2000 * ((100 - sliderPct) / 50));

    // Capa inter-documental: solo relaciones entre fragmentos de documentos
    // distintos (requiere 2+ docs cargados).
    const crossDocToggle = document.getElementById('toggle-crossdoc');
    const crossDoc = crossDocToggle ? crossDocToggle.checked : false;

    const response = await api('/api/query/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paragraphIds, threshold, maxRelations, crossDoc }),
    });

    const relations = response.relations || [];

    relations.forEach(rel => {
      const { source_id, target_id, similarity } = rel;
      
      const width = getSemanticWidth(similarity);
      const color = getSemanticColor(similarity);

      edgesDS.add({
        from: `frag-${source_id}`,
        to: `frag-${target_id}`,
        width: width,
        color: { color: color, hover: color },
        length: 240 + 120 * (1 - similarity),
        physics: true,
        _type: 'semantic'
      });
    });

    semanticRelations = relations;

    if (relations.length > 0) {
      // Con pocas aristas la física reacomoda y el grafo queda clicable.
      // Con muchas, estabilizar 250 iteraciones congela la UI: se deja la
      // simulación libre y se repinta una sola vez.
      if (relations.length <= 200) {
        network.stabilize(250);
      } else {
        network.stabilize(30);
      }
    }
  } catch (err) {
    console.error('Error al actualizar las relaciones semánticas:', err);
  } finally {
    renderExplorer();
  }
}

function renderExplorer() {
  const explorerTree = document.getElementById('explorer-tree');
  if (!explorerTree) return;

  if (documents.length === 0) {
    explorerTree.innerHTML = '<div class="empty-state">No hay documentos para explorar.</div>';
    return;
  }

  let html = '';
  
  // Group paragraphs by document_id
  const parasByDoc = {};
  allParagraphs.forEach(p => {
    if (!parasByDoc[p.document_id]) parasByDoc[p.document_id] = [];
    parasByDoc[p.document_id].push(p);
  });

  documents.forEach(doc => {
    const ext = (doc.mime_type || '').split('/').pop()?.split('.').pop() || '?';
    const paras = parasByDoc[doc.id] || [];
    
    html += `
      <div class="explorer-doc-card collapsed">
        <div class="explorer-doc-title" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="explorer-doc-title-left">
            <span class="explorer-doc-arrow">▼</span>
            ${doc.title}
          </div>
          <span class="explorer-doc-badge">${ext.toUpperCase()}</span>
        </div>
        <div class="explorer-doc-content">
          ${paras.map((p, idx) => {
            // Find relations involving this paragraph
            const relations = semanticRelations.filter(r => r.source_id === p.id || r.target_id === p.id);
            
            let relationsHtml = '';
            relations.forEach(r => {
              const isSource = r.source_id === p.id;
              const relatedId = isSource ? r.target_id : r.source_id;
              const similarity = (r.similarity * 100).toFixed(1);
              const highClass = r.similarity > 0.82 ? ' high' : '';
              
              relationsHtml += `
                <span class="badge-relation badge-semantic${highClass}" onclick="window.focusNodeInGraph('frag-${relatedId}')" title="Ir al nodo relacionado">
                  ${isSource ? '→' : '←'} Semántico (${similarity}%)
                </span>
              `;
            });

            return `
              <div class="explorer-frag-row">
                <div class="explorer-frag-header">
                  <span class="explorer-frag-index">Fragmento ${p.paragraph_index + 1}</span>
                  <button class="badge-relation badge-seq" onclick="window.enterEgoMode('${p.id}')" title="Ver solo este fragmento y sus relaciones">🌐 Relaciones</button>
                  <button class="badge-relation badge-seq" onclick="window.focusNodeInGraph('frag-${p.id}')" title="Ver en grafo">Ver Nodo</button>
                </div>
                <div class="explorer-frag-text">${p.raw_content}</div>
                ${relationsHtml ? `<div class="explorer-relations-section">${relationsHtml}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  explorerTree.innerHTML = html;
}

// Expone globalmente para los clics en los badges del explorador
function updateNodeViewButton(node) {
  lastSelNode = node && node._type === 'frag' && node._docId ? node : null;
  if (!nodeDetailView) return;
  const show = !!lastSelNode;
  nodeDetailView.style.display = show ? 'block' : 'none';
  if (nodeDetailEgo) {
    nodeDetailEgo.style.display = show ? 'block' : 'none';
  }
  if (show) {
    const isPdf = node._docMime && String(node._docMime).toLowerCase().includes('pdf');
    nodeDetailView.textContent = isPdf ? 'Ver en PDF' : 'Ver en documento';
  }
}

window.enterEgoMode = function(paraId) {
  // Asegurarse de estar en la pestaña de grafo
  const graphTabBtn = document.querySelector('.tab[data-tab="graph"]');
  if (graphTabBtn) graphTabBtn.click();
  enterEgoMode(paraId);
};

window.focusNodeInGraph = function(nodeId) {
  const graphTabBtn = document.querySelector('.tab[data-tab="graph"]');
  if (graphTabBtn) graphTabBtn.click();

if (network && nodesDS.get(nodeId)) {
      // Mantener la física activa para un movimiento elástico fluido al enfocar
      network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
      network.selectNodes([nodeId]);
    network.focus(nodeId, {
      scale: 1.4,
      animation: { duration: 800, easingFunction: 'easeInOutQuad' }
    });

    const node = nodesDS.get(nodeId);
    let title = node.label || node.id;
    if (node._type === 'frag' && node._docId) {
      const doc = documents.find(d => d.id === node._docId);
      if (doc) {
        title += ` — ${doc.title}`;
      }
    }
    nodeDetailT.textContent = title;
    nodeDetailB.textContent = node._content || '';
    nodeDetail.style.display = 'block';
    updateNodeViewButton(node);
  }
};

// Graph query → highlight relevant nodes
btnGQuery.addEventListener('click', () => runGraphQuery());
graphInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runGraphQuery(); });

const btnClearQuery = document.getElementById('btn-clear-query');
if (btnClearQuery) {
  btnClearQuery.addEventListener('click', resetGraphQuery);
}

function resetGraphQuery() {
  graphInput.value = '';
  if (btnClearQuery) btnClearQuery.style.display = 'none';
  
  if (!nodesDS || !edgesDS) return;
  
  nodesDS.forEach(node => {
    if (node._baseColors) {
      if (node._type === 'doc') {
        nodesDS.update({
          id: node.id,
          size: 22,
          opacity: 1,
          color: { 
            background: node._baseColors.docBg, 
            border: node._baseColors.docBorder,
            hover: { background: node._baseColors.docHoverBg, border: node._baseColors.docHoverBorder }
          },
          font: { color: node._baseColors.docText, size: 13, bold: true }
        });
      } else if (node._type === 'frag') {
        nodesDS.update({
          id: node.id,
          size: 10,
          opacity: 1,
          color: { 
            background: node._baseColors.fragBg, 
            border: node._baseColors.fragBorder,
            hover: { background: node._baseColors.fragHoverBg, border: node._baseColors.fragHoverBorder }
          },
          font: { color: node._baseColors.fragText, size: 10, bold: false }
        });
      }
    }
  });

  // Restaurar aristas
  edgesDS.forEach(edge => {
    if (edge._type === 'semantic') {
      edgesDS.update({ id: edge.id, color: { opacity: 1.0 } });
    } else if (edge._type === 'hierarchy' || edge._type === 'sequential') {
      const docNode = nodesDS.get(`doc-${edge._docId}`);
      if (docNode && docNode._baseColors) {
        const colors = docNode._baseColors;
        edgesDS.update({
          id: edge.id,
          color: {
            color: edge._type === 'hierarchy' ? colors.hierarchyEdge : colors.sequentialEdge,
            opacity: 1.0
          }
        });
      }
    }
  });
}

async function runGraphQuery() {
  const q = graphInput.value.trim();
  if (!q) {
    resetGraphQuery();
    return;
  }
  
  if (btnClearQuery) btnClearQuery.style.display = 'inline-flex';

  btnGQuery.disabled = true;
  btnGQuery.textContent = '…';

  try {
    const result = await api('/api/query/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });

    const scores = result.scores || [];
    if (scores.length === 0) return;

    // Obtener los scores máximos y mínimos para normalizar y contrastar
    const maxScore = Math.max(...scores.map(s => s.score));
    const minScore = Math.min(...scores.map(s => s.score));
    const scoreRange = maxScore - minScore;

    const scoreMap = {};
    for (const s of scores) {
      scoreMap[`frag-${s.paragraph_id}`] = s.score;
    }

    // Actualizar todos los nodos del grafo
    nodesDS.forEach(node => {
      const colors = node._baseColors || {
        fragBg: '#1e1434', fragBorder: '#7c3aed', fragHoverBg: '#2a1a4a', fragHoverBorder: '#9d5cf9', fragText: '#7c3aed',
        docBg: '#1c2d45', docBorder: '#58a6ff', docHoverBg: '#243651', docHoverBorder: '#79beff', docText: '#58a6ff'
      };

      if (node._type === 'frag') {
        const score = scoreMap[node.id];
        
        if (score !== undefined && score > 0.05) {
          const normalized = scoreRange > 0 ? (score - minScore) / scoreRange : 1;
          
          if (normalized > 0.6) {
            const size = 14 + Math.round(normalized * 24); 
            // Highlight con color de borde pero bien brillante
            nodesDS.update({
              id: node.id,
              size,
              color: {
                background: colors.fragBorder, 
                border: '#ffffff',
                hover: { background: colors.fragHoverBg, border: '#ffffff' }
              },
              font: { color: '#ffffff', size: 12, bold: true },
              opacity: 1,
            });
          } else {
            nodesDS.update({
              id: node.id,
              size: 10,
              color: { 
                background: colors.fragBg, 
                border: colors.fragBorder,
                hover: { background: colors.fragHoverBg, border: colors.fragHoverBorder }
              },
              font: { color: colors.fragText, size: 10, bold: false },
              opacity: 0.4, 
            });
          }
        } else {
          nodesDS.update({
            id: node.id,
            size: 8,
            color: { 
              background: colors.fragBg, 
              border: colors.fragBorder,
              hover: { background: colors.fragHoverBg, border: colors.fragHoverBorder }
            },
            font: { color: colors.fragText, size: 8, bold: false },
            opacity: 0.1, 
          });
        }
      } else if (node._type === 'doc') {
        nodesDS.update({ id: node.id, opacity: 0.6 });
      }
    });

    // Filtrar relaciones y ramas para mostrar solo las relevantes en la búsqueda
    edgesDS.forEach(edge => {
      if (edge._type === 'semantic') {
        const fromScore = scoreMap[edge.from];
        const toScore = scoreMap[edge.to];
        
        const isFromRelevant = fromScore !== undefined && (scoreRange > 0 ? (fromScore - minScore) / scoreRange : 1) > 0.6;
        const isToRelevant = toScore !== undefined && (scoreRange > 0 ? (toScore - minScore) / scoreRange : 1) > 0.6;
        
        if (isFromRelevant && isToRelevant) {
          edgesDS.update({ id: edge.id, color: { opacity: 1.0 } });
        } else {
          // Ocultar relaciones semánticas irrelevantes en esta consulta
          edgesDS.update({ id: edge.id, color: { opacity: 0.0 } });
        }
      } else if (edge._type === 'hierarchy' || edge._type === 'sequential') {
        const targetNodeId = edge.to;
        const targetScore = scoreMap[targetNodeId];
        const isRelevant = targetScore !== undefined && (scoreRange > 0 ? (targetScore - minScore) / scoreRange : 1) > 0.6;
        
        edgesDS.update({ id: edge.id, color: { opacity: isRelevant ? 1.0 : 0.04 } });
      }
    });

    network.stabilize(100);
    network.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
  } catch (e) {
    console.error('Graph query error', e);
  } finally {
    btnGQuery.disabled = false;
    btnGQuery.textContent = 'Buscar';
  }
}

// Documento → Grafo: buscar similitud con el texto seleccionado en el visor
window.searchGraphForText = function (text) {
  const q = (text || '').trim();
  if (!q) return;
  graphInput.value = q;
  const graphTabBtn = document.querySelector('.tab[data-tab="graph"]');
  if (graphTabBtn) graphTabBtn.click();
  runGraphQuery();
};

// ─── Chat ─────────────────────────────────────────────────────────────────────
let sessionId = localStorage.getItem('rag_session_id');
if (!sessionId) {
  sessionId = 'session_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
  localStorage.setItem('rag_session_id', sessionId);
}

async function loadAgentHistory() {
  try {
    const history = await api(`/api/agent/history?sessionId=${sessionId}`);
    const chatMessages = history.filter(m => m.role === 'user' || m.role === 'assistant');
    if (chatMessages.length > 0) {
      const welcome = chatMsgs.querySelector('.chat-welcome');
      if (welcome) welcome.remove();

      chatMessages.forEach(msg => {
        appendMsg(msg.role, msg.content);
      });
    }
  } catch (e) {
    console.error('Error al cargar el historial del agente:', e);
  }
}
loadAgentHistory();

btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

const btnResetChat = document.getElementById('btn-reset-chat');
if (btnResetChat) {
  btnResetChat.addEventListener('click', async () => {
    if (!confirm('¿Estás seguro de que deseas iniciar una nueva conversación? Se borrará el historial.')) return;
    try {
      await api('/api/agent/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      
      // Limpiar UI e insertar pantalla de bienvenida
      chatMsgs.innerHTML = `
        <div class="chat-welcome">
          <div class="chat-welcome-icon">⬡</div>
          <h3>RAG Studio</h3>
          <p>Hacé preguntas sobre tus documentos cargados.</p>
          <div class="chat-welcome-hints" id="chat-hints">
            <button class="hint-chip" data-hint="¿De qué tratan los documentos cargados?">📄 ¿De qué tratan los documentos?</button>
            <button class="hint-chip" data-hint="Resume los temas principales de la base de conocimiento.">📝 Resumen de la base de conocimiento</button>
            <button class="hint-chip" data-hint="¿Qué información específica puedo encontrar aquí?">🔍 ¿Qué información hay disponible?</button>
            <button class="hint-chip" data-hint="¿Cuáles son los conceptos más importantes mencionados?">💡 Conceptos más importantes</button>
          </div>
        </div>`;
    } catch (e) {
      alert('Error al reiniciar la conversación: ' + e.message);
    }
  });
}

const chatMsgsContainer = document.getElementById('chat-messages');
if (chatMsgsContainer) {
  chatMsgsContainer.addEventListener('click', (e) => {
    const hint = e.target.closest('.hint-chip');
    if (hint) {
      chatInput.value = hint.dataset.hint;
      sendChat();
    }
  });
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
});

const chatThresholdSlider = document.getElementById('chat-similarity-threshold');
const chatThresholdVal = document.getElementById('chat-threshold-val');
if (chatThresholdSlider && chatThresholdVal) {
  chatThresholdSlider.addEventListener('input', (e) => {
    chatThresholdVal.textContent = e.target.value + '%';
  });
}

// ─── Modelo LLM: rotación manual desde el panel ────────────────────────────
const chatModelSelect = document.getElementById('chat-model-select');
async function loadLlmModels() {
  if (!chatModelSelect) return;
  try {
    const { active, catalog } = await api('/api/llm/models');
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    chatModelSelect.innerHTML = catalog.map(m => {
      const primary = active[0] === m ? ' · activo' : '';
      const backup = active[1] === m ? ' · fallback' : '';
      return `<option value="${m}"${active[0] === m ? ' selected' : ''}>${m}${primary || backup}</option>`;
    }).join('');
    chatModelSelect.disabled = false;
  } catch (e) {
    console.error('No se pudieron cargar los modelos LLM:', e);
  }
}
if (chatModelSelect) {
  chatModelSelect.disabled = true;
  chatModelSelect.addEventListener('change', async () => {
    const model = chatModelSelect.value;
    if (!model) return;
    try {
      const { active } = await api('/api/llm/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      loadLlmModels();
      appendMsg('assistant', `Modelo LLM rotado a: **${active[0]}**`);
    } catch (e) {
      alert('Error al rotar modelo: ' + e.message);
      loadLlmModels();
    }
  });
}
loadLlmModels();

// ─── Chat streaming (SSE) ────────────────────────────────────────────────────
const CHAT_PHASE_LABELS = {
  route: 'Clasificando tu consulta…',
  decompose: 'Analizando la consulta…',
  search: 'Buscando en la base de conocimiento…',
  rerank: 'Comparando fragmentos…',
  answer: 'Generando respuesta…',
};

async function streamAgentChat(url, body, handlers) {
  const res = await fetch(BASE_URL + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error('El servidor no pudo iniciar el stream (HTTP ' + res.status + ')');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const ev of events) {
      const line = ev.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      let data;
      try { data = JSON.parse(line.slice(6)); } catch { continue; }
      if (data.type === 'phase' && handlers.onPhase) handlers.onPhase(data.phase);
      else if (data.type === 'token' && handlers.onToken) handlers.onToken(data.text);
      else if (data.type === 'done') donePayload = data;
      else if (data.type === 'error') throw new Error(data.message || 'Error del motor');
    }
  }
  if (!donePayload) throw new Error('El stream terminó sin respuesta del motor');
  return donePayload;
}

async function sendChat() {
  const q = chatInput.value.trim();
  if (!q) return;

  // Remove welcome screen
  const welcome = chatMsgs.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  appendMsg('user', q);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  btnSend.disabled = true;

  const loadingEl = appendMsg('assistant', '', false);
  const bubble = loadingEl.querySelector('.chat-bubble');
  bubble.innerHTML = '';
  const contentEl = document.createElement('div');
  contentEl.className = 'chat-typing';
  bubble.appendChild(contentEl);

  const chatStatus = document.getElementById('chat-status');
  const setPhase = (phase) => {
    if (!chatStatus) return;
    chatStatus.textContent = CHAT_PHASE_LABELS[phase] || phase;
    chatStatus.classList.remove('hide');
  };

  let full = '';
  try {
    const done = await streamAgentChat('/api/agent/chat/stream', { query: q, sessionId }, {
      onPhase: setPhase,
      onToken: (text) => {
        full += text;
        contentEl.innerHTML = renderAnswer(full);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      },
    });

    if (chatStatus) chatStatus.classList.add('hide');
    bubble.innerHTML = renderAnswer(done.content, buildCitationLabels(done.sources));
    finalizeBubble(bubble);

    if (done.iterations > 0) {
      const itEl = document.createElement('div');
      itEl.className = 'chat-iterations';
      itEl.textContent = `🔁 ${done.iterations} iteración${done.iterations === 1 ? '' : 'es'}`;
      loadingEl.appendChild(itEl);
    }
  } catch (e) {
    if (chatStatus) chatStatus.classList.add('hide');
    bubble.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'chat-bubble';
    errEl.textContent = '⚠ Error: ' + e.message;
    loadingEl.replaceChild(errEl, bubble);
  } finally {
    btnSend.disabled = false;
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
}

function buildCitationLabels(sources) {
  const map = {};
  (sources || []).forEach(s => {
    if (!s.id) return;
    map[`frag-${s.id}`] = `${s.doc_title} · frag. ${(s.paragraph_index ?? 0) + 1}`;
  });
  return map;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Formateador determinista ─────────────────────────────────────────────────
// Convierte CUALQUIER respuesta —venga con markdown o toda corrida— al mismo
// HTML estructurado: saltos de línea antes de todo ítem (guión, número o letra),
// encabezados normativos en negrita, definiciones con su término en negrita,
// citas y código. No depende de cómo decida emitir la respuesta el LLM.

const LEGAL_HEADING_RE = /^(?:ART[IÍ]CULO\s*\d+°?|ART\.\s*\d+|(?:INCISO|CAP[IÍ]TULO|T[IÍ]TULO|SECC[IÍ]ON|ANEXO|PARTE)\s*\d+)\b/i;
const LIST_TAG = { ul: 'ul', ol: 'ol', alpha: 'ol' };
const LIST_ATTR = { ul: '', ol: '', alpha: ' class="alpha"' };
// Marcador de ítem: guión/viñeta ("-", "—", "•"), número ("1.", "1)", "1°", "1°.")
// o letra ("a)"). El patrón se comparte entre detección de señal, corte de línea
// y parseo de bloques para que SIEMPRE se detecten los mismos ítems.
const ITEM_MARK_SRC = '(?:[-–—•*]+|\\d{1,3}(?:[.)]|°[.)]?)|[a-z][.)])';
const ITEM_SIGNAL_RE = new RegExp('(?:[.:;\\n]|^)[ \\t]*(?:' + ITEM_MARK_SRC + ')\\s+\\S', 'g');
const ITEM_BREAK_RE = new RegExp(
  '([.:;\\n])[ \\t]+(?=(?:' + ITEM_MARK_SRC + ')\\s|ART[IÍ]CULO\\s*\\d+°?|(?:INCISO|CAP[IÍ]TULO|T[IÍ]TULO|SECC[IÍ]ON|ANEXO|PARTE)\\s*\\d+)',
  'gi'
);
const ITEM_LINE_RE = new RegExp('^(' + ITEM_MARK_SRC + ')\\s+(.+)$');

function normalizeRichText(text) {
  const headSignal = /(?:ART[IÍ]CULO|ART\.|INCISO|CAP[IÍ]TULO|T[IÍ]TULO|SECC[IÍ]ON|ANEXO|PARTE)\s*\d*/i.test(text);
  const itemSignal = (text.match(ITEM_SIGNAL_RE) || []).length;
  if (!headSignal && itemSignal < 2) {
    return text.replace(/[ \t]{2,}/g, ' ').trim();
  }

  let t = text;
  // Marcas de cita markdown ("> ") se ignoran para que NO exista formato de
  // cita diferenciado: todo se renderiza igual (párrafos/listas/negritas).
  t = t.replace(/^\s*>\s?/gm, '');
  // Artefactos de extracción de PDF: números de página sueltos y pies "archivo.pdf · frag. N".
  t = t.replace(/^\s*\d{1,4}\s*$/gm, '');
  t = t.replace(/^\s*(?:[^\n]*?\.pdf\s*)?[^\n]*?·\s?frag\.?\s*\d+\s*$/gim, '');

  // Salto de línea ANTES de ítems corridos (guión, viñeta, número, letra o grado
  // "1°.") y de encabezados normativos, cuando siguen a un punto, dos puntos,
  // punto y coma o un salto de línea ya existente. Esto garantiza estructura
  // aunque el LLM haya devuelto todo en una sola línea corrida.
  t = t.replace(ITEM_BREAK_RE, '$1\n');
  // Separa el título normativo de su intro (regla GENERAL para todo ARTICULO:
  // "ARTICULO 2° — (Definiciones). A los fines…" o "ARTICULO 32. — Procedimiento
  // de reparación. Previa…"): el encabezado queda en su línea y el cuerpo debajo.
  t = t.replace(/^(ART[IÍ]CULO\s*\d+°?\s*—?\s*\([^)]*\)\.?)\s+(?=[A-ZÁÉÍÓÚÑ0-9])/gi, '$1\n');
  // Reintegra el "—" que ITEM_BREAK_RE separó como viñeta falsa cuando sigue al
  // epígrafe normativo: "ARTICULO N." \n "— Título. Cuerpo…" → "ARTICULO N. — Título."
  // \n "Cuerpo…". El em dash es puntuación del encabezado (epígrafe), no un ítem
  // de lista: para NINGÚN ARTICULO debe aparecer un <ul> falso.
  t = t.replace(
    /^(ART[IÍ]CULO\s*\d+°?\s*\.?)\s*\n\s*[—–-]\s+([^.:\n]{1,160}?[.:])\s+(?=[A-ZÁÉÍÓÚÑ0-9])/gim,
    '$1 — $2\n'
  );
  // Por línea: quita comillas envolventes de transcripción ("1°. …"), números de
  // página pegados al final de línea (nunca en líneas de encabezado).
  t = t.split('\n').map(line => {
    const trim = line.trim();
    const clean = line.replace(/^["“«]\s*/, '').replace(/["”»]\s*$/, '');
    if (LEGAL_HEADING_RE.test(trim) || /^#+\s/.test(trim)) return clean.trim();
    return clean.trim().replace(/\s+\d{1,4}\s*$/, '');
  }).join('\n');

  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

function inlineMarkup(t) {
  return t
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Convierte el texto ya normalizado (líneas) en HTML por bloques.
function buildRichHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listKey = null;
  let para = [];
  let inList = false;

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(inlineMarkup).join('<br>') + '</p>');
    para = [];
  };
  const closeList = () => {
    if (listKey) {
      out.push('</' + LIST_TAG[listKey] + '>');
      listKey = null;
    }
    inList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();

    if (inCode) {
      if (trim.startsWith('```')) {
        out.push('<pre class="chat-code"><code>' + codeBuf.join('\n') + '</code></pre>');
        inCode = false;
        codeBuf = [];
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    if (trim.startsWith('```')) {
      flushPara();
      closeList();
      inCode = true;
      continue;
    }
    if (trim === '') {
      flushPara();
      closeList();
      continue;
    }
    // Encabezados markdown (#) y normativos (ARTICULO, INCISO, CAPITULO, …)
    if (/^#{1,4}\s/.test(trim)) {
      flushPara();
      closeList();
      out.push('<p class="chat-heading">' + inlineMarkup(trim.replace(/^#+\s*/, '')) + '</p>');
      continue;
    }
    if (LEGAL_HEADING_RE.test(trim)) {
      flushPara();
      closeList();
      out.push('<p class="chat-heading">' + inlineMarkup(trim) + '</p>');
      continue;
    }
    // Ítems: guión/viñeta → ul; número → ol; letra → ol. El marcador ORIGINAL
    // (número o letra) se conserva como texto literal para que el navegador NO
    // renumere desde 1: si el texto dice "4." se muestra "4.", no "1.".
    const item = trim.match(ITEM_LINE_RE);
    if (item) {
      flushPara();
      const marker = item[1];
      const key = /[-–—•*]/.test(marker) ? 'ul' : /^[a-z][.)]$/.test(marker) ? 'alpha' : 'ol';
      if (listKey !== key) {
        closeList();
        listKey = key;
        out.push('<' + LIST_TAG[key] + LIST_ATTR[key] + '>');
      }
      const literal = key === 'ul' ? '' : marker + ' ';
      out.push('<li>' + literal + inlineMarkup(item[2]) + '</li>');
      inList = true;
      continue;
    }
    if (inList) {
      // Continuación de un ítem (texto que sigue a la línea marcada)
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, '<br>' + inlineMarkup(trim) + '</li>');
      continue;
    }
    // Definiciones: "Término: explicación…" → término en negrita
    const def = trim.match(/^([A-ZÁÉÍÓÚÑ][^:]{1,60}):\s+(.+)$/);
    if (def) {
      flushPara();
      closeList();
      out.push('<p><strong>' + inlineMarkup(def[1]) + ':</strong> ' + inlineMarkup(def[2]) + '</p>');
      continue;
    }
    if (/^-{3,}$/.test(trim)) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }
    // Párrafo: las líneas seguidas van en un solo <p> con <br>
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join('');
}

// Renderiza la respuesta: normaliza estructura → bloques HTML → sanitiza
// (DOMPurify) → restaura las citas RAG como chips clicables.
function renderAnswer(text, labels = {}) {
  if (!text) return '';
  const chips = [];
  const withPlaceholders = text.replace(
    /\[\[(\d+)\]\]\(frag-([a-f0-9-]+)\)/g,
    (_, n, uuid) => {
      const key = `frag-${uuid}`;
      const label = (labels && labels[key]) || `Fuente ${n}`;
      chips.push(
        `<button class="citation-chip" onclick="window.focusNodeInGraph('${key}')" title="${key}">` +
        `<span class="citation-num">${n}</span>` +
        `<span class="citation-label">${escapeHtml(label)}</span>` +
        `</button>`
      );
      return '@@CIT' + String(chips.length - 1) + '@@';
    }
  );
  const normalized = normalizeRichText(withPlaceholders);
  const html = buildRichHtml(normalized);
  const safe = DOMPurify.sanitize(html);
  return safe.replace(/@@CIT(\d+)@@/g, (_, i) => chips[+i]);
}

// Aplica color de sintaxis a los bloques de código y abre links externos en pestaña nueva.
function finalizeBubble(bubble) {
  if (window.hljs) {
    bubble.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
  }
  bubble.querySelectorAll('a').forEach(a => {
    if (a.href && /^https?:/i.test(a.href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
}

function appendMsg(role, text, loading = false) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble${loading ? ' loading' : ''}`;
  if (loading || role === 'user') {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = renderAnswer(text);
    finalizeBubble(bubble);
  }
  div.appendChild(bubble);
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return div;
}


// ─── Quality / Evaluation ──────────────────────────────────────────────────────
const qualityCards = document.getElementById('quality-cards');
const qualityList = document.getElementById('quality-list');
const btnRefreshQuality = document.getElementById('btn-refresh-quality');

function scoreBadge(label, val) {
  if (val == null) return `<span class="quality-empty">—</span>`;
  const pct = Math.round(val * 100);
  const cls = val >= 0.8 ? ' good' : val >= 0.6 ? ' mid' : ' bad';
  return `<span class="quality-score${cls}">${label}: ${pct}%</span>`;
}

function decisionBadge(decision) {
  const map = { RELEVANT: 'good', PARTIAL: 'fair', IRRELEVANT: 'bad' };
  return `<span class="quality-score ${map[decision] || ''}">${decision || '—'}</span>`;
}

async function loadQuality() {
  if (!qualityCards || !qualityList) return;
  try {
    const [stats, list] = await Promise.all([
      api('/api/evaluations/stats'),
      api('/api/evaluations?limit=50'),
    ]);

    const cards = [
      { label: 'Consultas', value: stats.total, cls: '' },
      { label: 'Evaluadas', value: stats.evaluated, cls: stats.evaluated > 0 ? 'good' : '' },
      { label: 'Fidelidad prom.', value: stats.avg_faithfulness != null ? Math.round(stats.avg_faithfulness * 100) + '%' : '—', cls: stats.avg_faithfulness >= 0.8 ? 'good' : stats.avg_faithfulness != null && stats.avg_faithfulness >= 0.6 ? 'fair' : '' },
      { label: 'Relevancia prom.', value: stats.avg_relevance != null ? Math.round(stats.avg_relevance * 100) + '%' : '—', cls: stats.avg_relevance >= 0.8 ? 'good' : stats.avg_relevance != null && stats.avg_relevance >= 0.6 ? 'fair' : '' },
      { label: 'Latencia prom.', value: stats.avg_latency_ms != null ? stats.avg_latency_ms + ' ms' : '—', cls: '' },
      { label: 'Iteraciones prom.', value: stats.avg_iterations != null ? stats.avg_iterations : '—', cls: '' },
    ];

    qualityCards.innerHTML = cards.map(c =>
      `<div class="quality-card${c.cls ? ` ${c.cls}` : ''}">
         <div class="quality-card-value">${c.value}</div>
         <div class="quality-card-label">${c.label}</div>
       </div>`
    ).join('');

    if (list.length === 0) {
      qualityList.innerHTML = '<div class="empty-state">No hay evaluaciones registradas aún.</div>';
      return;
    }

    qualityList.innerHTML = list.map(e => `
      <div class="quality-row">
        <span class="quality-query" title="${e.query_text}">${e.query_text}</span>
        <span>${scoreBadge('', e.faithfulness_score)}</span>
        <span>${scoreBadge('', e.answer_relevance_score)}</span>
        <span>${decisionBadge(e.crag_decision)}</span>
        <span>${e.latency_ms != null ? e.latency_ms + ' ms' : '—'}</span>
        <span class="quality-date">${new Date(e.created_at).toLocaleString()}</span>
      </div>`).join('');
  } catch (e) {
    if (qualityCards) qualityCards.innerHTML = '<div class="empty-state">Error cargando estadísticas: ' + e.message + '</div>';
  }
}

if (btnRefreshQuality) btnRefreshQuality.addEventListener('click', loadQuality);
const qualityTabBtn = document.getElementById('tab-btn-quality');
if (qualityTabBtn) qualityTabBtn.addEventListener('click', () => loadQuality());

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await initGraph();
  await fetchDocuments();
})();
