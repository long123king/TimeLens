export default class PeView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this.onRefresh = null;
    this._resizeHandler = () => this._scheduleConnectorRender();

    this._buildShell();
    window.addEventListener('resize', this._resizeHandler);
  }

  setActive(active) {
    this._active = active;
    if (active) {
      this._scheduleConnectorRender();
    }
  }

  setLoading(loading) {
    if (this._loadingEl) {
      this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    }
  }

  setDisconnected() {
    this._data = null;
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
  }

  setError(message) {
    this._renderPlaceholder('✕', message || 'Unable to load PE data.');
  }

  setData(data) {
    this._data = data;
    if (!data?.available) {
      this._renderPlaceholder('◌', 'PE data is unavailable for the current image.');
      return;
    }
    this._render();
  }

  _buildShell() {
    this._container.classList.add('pe-root');

    const toolbar = document.createElement('div');
    toolbar.className = 'pe-toolbar';
    toolbar.innerHTML = [
      '<div class="pe-toolbar-title">PE Structure</div>',
      '<div class="pe-toolbar-subtitle">Visualize DOS header, NT headers, directories, imports, exports, and their relationships</div>',
      '<div class="pe-toolbar-right">',
      '<span id="pe-loading" class="pe-loading" style="display:none"><span class="spinner"></span> Loading...</span>',
      '<button class="pe-btn" id="pe-refresh">↻ Refresh</button>',
      '</div>'
    ].join('');
    this._container.appendChild(toolbar);

    this._loadingEl = toolbar.querySelector('#pe-loading');
    toolbar.querySelector('#pe-refresh')?.addEventListener('click', () => {
      if (this.onRefresh) this.onRefresh();
    });

    this._body = document.createElement('div');
    this._body.className = 'pe-body';
    this._container.appendChild(this._body);

    this._renderPlaceholder('◌', 'Loading PE structure...');
  }

  _renderPlaceholder(icon, message) {
    this._body.innerHTML = [
      '<div class="pe-empty">',
      `  <div class="pe-empty-icon">${this._esc(icon)}</div>`,
      `  <div class="pe-empty-text">${this._esc(message)}</div>`,
      '</div>',
    ].join('');
  }

  _render() {
    const data = this._data ?? {};
    const imports = Array.isArray(data.imports) ? data.imports : [];
    const directories = Array.isArray(data.dataDirectories) ? data.dataDirectories : [];
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const exportsNode = data.exports ?? null;
    const relationshipMap = this._buildRelationshipMap(data, imports, directories, exportsNode);

    this._body.innerHTML = [
      '<div class="pe-layout">',
      '  <section class="pe-summary"></section>',
      '  <section class="pe-graph-section">',
      '    <div class="pe-section-head">',
      '      <div class="pe-section-title">Logical Graph</div>',
      '      <div class="pe-section-meta">Headers, directories, and descriptors linked by parsed PE relationships</div>',
      '    </div>',
      '    <div class="pe-graph-shell">',
      '      <svg class="pe-graph-links" aria-hidden="true"></svg>',
      '      <div class="pe-graph" id="pe-graph"></div>',
      '    </div>',
      '  </section>',
      '  <section class="pe-details"></section>',
      '  <section class="pe-panel pe-relationship-section">',
      '    <div class="pe-section-head">',
      '      <div class="pe-section-title">Relationship Map</div>',
      '      <div class="pe-section-meta">Readable source-to-target relationship summary</div>',
      '    </div>',
      '    <div class="pe-relationship-strip" id="pe-relationship-strip"></div>',
      '  </section>',
      '</div>'
    ].join('');

    const summaryEl = this._body.querySelector('.pe-summary');
    const graphEl = this._body.querySelector('#pe-graph');
    const detailsEl = this._body.querySelector('.pe-details');
    const relationshipStripEl = this._body.querySelector('#pe-relationship-strip');
    this._linksSvg = this._body.querySelector('.pe-graph-links');
    this._graphEl = graphEl;

    summaryEl.appendChild(this._renderSummary(data));
    this._renderGraph(graphEl, data, imports, directories, exportsNode);
    relationshipStripEl.innerHTML = this._buildRelationshipMarkup(data.relationships, relationshipMap);
    detailsEl.appendChild(this._renderDetails(data, sections, directories, imports, exportsNode, notes));
    this._scheduleConnectorRender();
  }

  _buildRelationshipMap(data, imports, directories, exportsNode) {
    const map = new Map();
    map.set('dos', {
      title: data.headers?.dos?.name || 'DOS Header',
      tone: 'cyan',
      address: data.headers?.dos?.address || '—',
    });
    map.set('nt', {
      title: data.headers?.nt?.name || 'NT Headers',
      tone: 'amber',
      address: data.headers?.nt?.address || '—',
    });

    (directories || []).forEach((entry) => {
      if (!entry?.id) return;
      const tone = Number(entry.index) === 0 ? 'green' : (Number(entry.index) === 1 ? 'blue' : 'slate');
      map.set(String(entry.id), {
        title: entry.name || 'Directory',
        tone,
        address: entry.address || '—',
      });
    });

    if (exportsNode) {
      map.set('export', {
        title: exportsNode.name || 'Export Directory',
        tone: 'rose',
        address: exportsNode.descriptorAddress || exportsNode.address || '—',
      });
    }

    (imports || []).slice(0, 8).forEach((entry) => {
      if (!entry?.id) return;
      map.set(String(entry.id), {
        title: entry.name || 'Import Descriptor',
        tone: 'violet',
        address: entry.descriptorAddress || entry.address || '—',
      });
    });

    return map;
  }

  _buildRelationshipMarkup(relationships, relationshipMap) {
    const edges = Array.isArray(relationships) ? relationships : [];
    if (edges.length === 0) {
      return '<div class="pe-relationship-empty">No explicit relationships were emitted for this image.</div>';
    }

    return edges.map((edge, index) => {
      const from = relationshipMap.get(String(edge.from)) || { title: String(edge.from || 'unknown'), tone: 'slate', address: '—' };
      const to = relationshipMap.get(String(edge.to)) || { title: String(edge.to || 'unknown'), tone: 'slate', address: '—' };
      const label = edge.label || 'relates to';
      return [
        '<article class="pe-relationship-card">',
        `  <div class="pe-relationship-index">#${index + 1}</div>`,
        '  <div class="pe-relationship-flow">',
        `    <span class="pe-rel-chip tone-${this._esc(from.tone)}">${this._esc(from.title)}</span>`,
        `    <span class="pe-rel-address-inline">${this._esc(from.address || '—')}</span>`,
        '    <span class="pe-rel-arrow" aria-hidden="true">→</span>',
        `    <span class="pe-rel-label">${this._esc(label)}</span>`,
        '    <span class="pe-rel-arrow" aria-hidden="true">→</span>',
        `    <span class="pe-rel-chip tone-${this._esc(to.tone)}">${this._esc(to.title)}</span>`,
        `    <span class="pe-rel-address-inline">${this._esc(to.address || '—')}</span>`,
        '  </div>',
        '</article>'
      ].join('');
    }).join('');
  }

  _renderSummary(data) {
    const wrap = document.createElement('div');
    wrap.className = 'pe-summary-grid';

    const cards = [
      ['Image Base', data.imageBase || '—', data.moduleName || 'Current image'],
      ['Architecture', data.architecture || '—', 'NT Optional Header magic'],
      ['Import Descriptors', String((data.imports || []).length), 'IMAGE_IMPORT_DESCRIPTOR entries'],
      ['Exports', data.exports ? String(data.exports.numberOfFunctions || 0) : '0', 'Exported functions'],
    ];

    for (const [label, value, meta] of cards) {
      const card = document.createElement('div');
      card.className = 'pe-stat';
      card.innerHTML = [
        `<div class="pe-stat-label">${this._esc(label)}</div>`,
        `<div class="pe-stat-value">${this._esc(value)}</div>`,
        `<div class="pe-stat-meta">${this._esc(meta)}</div>`
      ].join('');
      wrap.appendChild(card);
    }

    return wrap;
  }

  _renderGraph(graphEl, data, imports, directories, exportsNode) {
    const visibleImports = imports.slice(0, 4);
    const importDir = directories.find((entry) => Number(entry.index) === 1) || null;
    const exportDir = directories.find((entry) => Number(entry.index) === 0) || null;

    const graph = document.createElement('div');
    graph.className = 'pe-graph-grid';

    const row1 = document.createElement('div');
    row1.className = 'pe-graph-row pe-graph-row-top';
    row1.append(
      this._createNodeCard(data.headers?.dos, 'dos', 'accent-cyan'),
      this._createNodeCard(data.headers?.nt, 'nt', 'accent-amber')
    );

    const row2 = document.createElement('div');
    row2.className = 'pe-graph-row pe-graph-row-mid';
    row2.append(
      this._createDirectoryNode(exportDir, 'accent-green'),
      this._createDirectoryNode(importDir, 'accent-blue')
    );

    const row3 = document.createElement('div');
    row3.className = 'pe-graph-row pe-graph-row-bottom';
    if (exportsNode) {
      row3.appendChild(this._createExportNode(exportsNode));
    }
    visibleImports.forEach((entry) => row3.appendChild(this._createImportNode(entry)));

    graph.append(row1, row2, row3);
    graphEl.replaceChildren(graph);
  }

  _createNodeCard(node, nodeId, accentClass) {
    const element = document.createElement('article');
    element.className = `pe-node ${accentClass}`;
    element.dataset.nodeId = nodeId;

    if (!node) {
      element.innerHTML = '<div class="pe-node-title">Unavailable</div><div class="pe-node-meta">No parsed data</div>';
      return element;
    }

    const fields = Array.isArray(node.fields) ? node.fields.slice(0, 5) : [];
    element.innerHTML = [
      `<div class="pe-node-kind">${this._esc(node.name || nodeId)}</div>`,
      `<div class="pe-node-address">${this._esc(node.address || '—')}</div>`,
      `<div class="pe-node-fields">${fields.map((field) => `<div class="pe-node-field"><span>${this._esc(field.name || '')}</span><strong>${this._esc(field.value || '—')}</strong></div>`).join('')}</div>`
    ].join('');
    return element;
  }

  _createDirectoryNode(entry, accentClass) {
    const element = document.createElement('article');
    element.className = `pe-node ${accentClass}`;
    element.dataset.nodeId = entry?.id || 'dir';
    element.innerHTML = [
      `<div class="pe-node-kind">${this._esc(entry?.name || 'Directory')}</div>`,
      `<div class="pe-node-address">${this._esc(entry?.address || '—')}</div>`,
      '<div class="pe-node-fields">',
      `  <div class="pe-node-field"><span>RVA</span><strong>${this._esc(entry?.virtualAddress || '—')}</strong></div>`,
      `  <div class="pe-node-field"><span>Size</span><strong>${this._esc(entry?.size || '—')}</strong></div>`,
      '</div>'
    ].join('');
    return element;
  }

  _createImportNode(entry) {
    const count = Array.isArray(entry?.functions) ? entry.functions.length : 0;
    const element = document.createElement('article');
    element.className = 'pe-node accent-violet';
    element.dataset.nodeId = entry?.id || 'import';
    element.innerHTML = [
      `<div class="pe-node-kind">${this._esc(entry?.name || 'Import')}</div>`,
      `<div class="pe-node-address">${this._esc(entry?.descriptorAddress || '—')}</div>`,
      '<div class="pe-node-fields">',
      `  <div class="pe-node-field"><span>Thunk</span><strong>${this._esc(entry?.firstThunk || '—')}</strong></div>`,
      `  <div class="pe-node-field"><span>Functions</span><strong>${this._esc(String(count))}</strong></div>`,
      '</div>'
    ].join('');
    return element;
  }

  _createExportNode(entry) {
    const element = document.createElement('article');
    element.className = 'pe-node accent-rose';
    element.dataset.nodeId = 'export';
    element.innerHTML = [
      `<div class="pe-node-kind">${this._esc(entry?.name || 'IMAGE_EXPORT_DIRECTORY')}</div>`,
      `<div class="pe-node-address">${this._esc(entry?.descriptorAddress || '—')}</div>`,
      '<div class="pe-node-fields">',
      `  <div class="pe-node-field"><span>DLL</span><strong>${this._esc(entry?.dllName || '—')}</strong></div>`,
      `  <div class="pe-node-field"><span>Names</span><strong>${this._esc(String(entry?.numberOfNames ?? 0))}</strong></div>`,
      '</div>'
    ].join('');
    return element;
  }

  _renderDetails(data, sections, directories, imports, exportsNode, notes) {
    const wrap = document.createElement('div');
    wrap.className = 'pe-detail-grid';

    wrap.appendChild(this._buildTablePanel('Sections', sections, ['name', 'virtualAddress', 'virtualSize', 'rawSize', 'address']));
    wrap.appendChild(this._buildTablePanel('Data Directories', directories, ['name', 'virtualAddress', 'size', 'address']));
    wrap.appendChild(this._buildImportsPanel(imports));
    wrap.appendChild(this._buildExportsPanel(exportsNode));

    if (notes.length > 0) {
      const notesPanel = document.createElement('section');
      notesPanel.className = 'pe-panel pe-notes';
      notesPanel.innerHTML = [
        '<div class="pe-section-head"><div class="pe-section-title">Notes</div></div>',
        `<div class="pe-notes-list">${notes.map((note) => `<div class="pe-note-item">${this._esc(note)}</div>`).join('')}</div>`
      ].join('');
      wrap.appendChild(notesPanel);
    }

    return wrap;
  }

  _buildTablePanel(title, rows, columns) {
    const section = document.createElement('section');
    section.className = 'pe-panel';
    const safeRows = Array.isArray(rows) ? rows : [];
    section.innerHTML = [
      `<div class="pe-section-head"><div class="pe-section-title">${this._esc(title)}</div><div class="pe-section-meta">${safeRows.length} item(s)</div></div>`,
      this._buildTableMarkup(safeRows, columns)
    ].join('');
    return section;
  }

  _buildImportsPanel(imports) {
    const section = document.createElement('section');
    section.className = 'pe-panel pe-imports-panel';

    const cards = (imports || []).slice(0, 8).map((entry) => {
      const functions = Array.isArray(entry.functions) ? entry.functions.slice(0, 6) : [];
      return [
        '<article class="pe-import-card">',
        `  <div class="pe-import-name">${this._esc(entry.name || 'Import')}</div>`,
        `  <div class="pe-import-meta">Descriptor ${this._esc(entry.descriptorAddress || '—')}</div>`,
        `  <div class="pe-import-funcs">${functions.map((fn) => `<span>${this._esc(fn.name || (fn.ordinal != null ? `Ordinal ${fn.ordinal}` : 'Unnamed'))}</span>`).join('')}</div>`,
        '</article>'
      ].join('');
    }).join('');

    section.innerHTML = [
      `<div class="pe-section-head"><div class="pe-section-title">Imports</div><div class="pe-section-meta">${this._esc(String((imports || []).length))} descriptor(s)</div></div>`,
      `<div class="pe-import-grid">${cards || '<div class="pe-table-empty">No imports.</div>'}</div>`
    ].join('');
    return section;
  }

  _buildExportsPanel(exportsNode) {
    const section = document.createElement('section');
    section.className = 'pe-panel pe-exports-panel';
    const rows = Array.isArray(exportsNode?.functions) ? exportsNode.functions.slice(0, 16) : [];
    section.innerHTML = [
      `<div class="pe-section-head"><div class="pe-section-title">Exports</div><div class="pe-section-meta">${this._esc(String(rows.length))} function(s) shown</div></div>`,
      exportsNode ? this._buildTableMarkup(rows, ['ordinal', 'name', 'rva', 'address', 'forwarder']) : '<div class="pe-table-empty">No export directory.</div>'
    ].join('');
    return section;
  }

  _buildTableMarkup(rows, columns) {
    if (!rows || rows.length === 0) {
      return '<div class="pe-table-empty">No data.</div>';
    }
    const head = columns.map((column) => `<th>${this._esc(column)}</th>`).join('');
    const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${this._esc(row?.[column] ?? '—')}</td>`).join('')}</tr>`).join('');
    return `<div class="pe-table-wrap"><table class="pe-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  _scheduleConnectorRender() {
    if (!this._active || !this._graphEl || !this._linksSvg) return;
    window.requestAnimationFrame(() => this._renderConnectors());
  }

  _renderConnectors() {
    const data = this._data;
    if (!data?.available || !this._graphEl || !this._linksSvg) return;

    const graphRect = this._graphEl.getBoundingClientRect();
    const width = Math.max(1, Math.round(graphRect.width));
    const height = Math.max(1, Math.round(graphRect.height));
    this._linksSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this._linksSvg.setAttribute('width', String(width));
    this._linksSvg.setAttribute('height', String(height));

    const nodes = new Map();
    this._graphEl.querySelectorAll('[data-node-id]').forEach((element) => {
      const rect = element.getBoundingClientRect();
      nodes.set(element.dataset.nodeId, {
        x: rect.left - graphRect.left + rect.width / 2,
        y: rect.top - graphRect.top + rect.height / 2,
      });
    });

    const relationships = Array.isArray(data.relationships) ? data.relationships : [];
    const paths = relationships.map((edge) => {
      const from = nodes.get(String(edge.from));
      const to = nodes.get(String(edge.to));
      if (!from || !to) return '';
      const midX = (from.x + to.x) / 2;
      const d = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
      const labelX = midX;
      const labelY = (from.y + to.y) / 2 - 8;
      return [
        `<path class="pe-link-path" d="${d}" />`,
        `<text class="pe-link-label" x="${labelX}" y="${labelY}">${this._esc(edge.label || '')}</text>`
      ].join('');
    }).join('');

    this._linksSvg.innerHTML = [
      '<defs>',
      '  <marker id="pe-arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">',
      '    <path d="M0,0 L10,4 L0,8 Z" fill="#83d0ff"></path>',
      '  </marker>',
      '</defs>',
      paths,
    ].join('');
  }

  _esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}