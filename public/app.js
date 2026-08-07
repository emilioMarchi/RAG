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
    input.accept = '.pdf,.docx,.txt,.md';
    input.multiple = true;
    input.onchange = async () => {
      for (const file of Array.from(input.files)) await uploadFile(file);
    };
    input.click();
  }
});

async function uploadFile(file) {
  const item = createUploadItem(file.name);
  const fd = new FormData();
  fd.append('file', file);

  setProgress(item, 30, 'Subiendo…');

  try {
    setProgress(item, 60, 'Procesando…');
    const res = await api('/api/upload', { method: 'POST', body: fd });
    setProgress(item, 100, `✓ ${res.paragraphsProcessed} fragmentos`, 'ok');
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
      // mínima alta evita que siga orbitando indefinidamente.
      minVelocity: 0.75,
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
    if (params.nodes.length === 0) { nodeDetail.style.display = 'none'; return; }
    const nodeId = params.nodes[0];
    const node = nodesDS.get(nodeId);
    if (!node) return;
    
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
  });

  nodeDetailCl.addEventListener('click', () => { nodeDetail.style.display = 'none'; });
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
      await updateSemanticRelations();
    });
  }

  // Toggle relations checkbox
  const toggleRelations = document.getElementById('toggle-relations');
  if (toggleRelations) {
    toggleRelations.addEventListener('change', async () => {
      network.setOptions({ physics: { enabled: true } });
      await updateSemanticRelations();
    });
  }
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
          allParagraphs.push(p);
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
            _docId: doc.id,
            _baseColors: colors,
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
    const response = await api('/api/query/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paragraphIds, threshold }),
    });

    const relations = response.relations || [];

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
      network.stabilize(100);
    }
  } catch (err) {
    console.error('Error al actualizar las relaciones semánticas:', err);
  }
}

// Expone globalmente para los clics en los badges del explorador
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

// ─── Chat ─────────────────────────────────────────────────────────────────────
btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
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

  const loadingEl = appendMsg('assistant', '…', true);

  try {
    const threshold = chatThresholdSlider ? parseFloat(chatThresholdSlider.value) / 100 : 0;
    
    const result = await api('/api/query/iterative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, topDocs: 5, topParagraphs: 4, similarityThreshold: threshold }),
    });

    loadingEl.querySelector('.chat-bubble').textContent = result.answer;
    loadingEl.querySelector('.chat-bubble').classList.remove('loading');

    if (result.iterations !== undefined) {
      const itEl = document.createElement('div');
      itEl.className = 'chat-iterations';
      itEl.textContent = `🔁 ${result.iterations} iteración${result.iterations === 1 ? '' : 'es'}`;
      loadingEl.appendChild(itEl);
    }

    if (result.sources?.length) {
      const sourcesEl = document.createElement('div');
      sourcesEl.className = 'chat-sources';
      sourcesEl.innerHTML = result.sources.map(s => `
        <div class="chat-source">
          <div class="chat-source-title">📄 ${s.doc_title}</div>
          <div class="chat-source-preview">${s.raw_content}</div>
        </div>`).join('');
      loadingEl.appendChild(sourcesEl);
    }
  } catch (e) {
    loadingEl.querySelector('.chat-bubble').textContent = '⚠ Error: ' + e.message;
    loadingEl.querySelector('.chat-bubble').classList.remove('loading');
  } finally {
    btnSend.disabled = false;
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }
}

function appendMsg(role, text, loading = false) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="chat-bubble${loading ? ' loading' : ''}">${text}</div>`;
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return div;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await initGraph();
  await fetchDocuments();
})();
