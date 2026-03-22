const DEFAULT_ROOTS = [
  'Debugger',
  'Debugger.Sessions',
  '@$cursession',
  '@$cursession.Processes',
  '@$curprocess',
  '@$curprocess.Threads',
  '@$curprocess.Modules',
  '@$curthread',
  '@$curstack',
  '@$curframe',
];

const DEFAULT_SNIPPETS = [
  { label: 'Current Session', expr: '@$cursession', depth: 2 },
  { label: 'Session Processes', expr: '@$cursession.Processes', depth: 2 },
  { label: 'Current Process', expr: '@$curprocess', depth: 2 },
  { label: 'Current Thread', expr: '@$curthread', depth: 2 },
  { label: 'Current Process Threads', expr: '@$curprocess.Threads', depth: 2 },
  { label: 'Current Process Modules', expr: '@$curprocess.Modules', depth: 2 },
  { label: 'Current Stack', expr: '@$curstack', depth: 1 },
  { label: 'Current Frame', expr: '@$curframe', depth: 1 },
];

export default class ModelView {
  constructor(container) {
    this._container = container;
    this._active = false;
    this._connected = false;
    this._loading = false;
    this._result = null;
    this._roots = [...DEFAULT_ROOTS];
    this._snippets = [...DEFAULT_SNIPPETS];

    this.onExecute = null;
    this.onRefresh = null;

    this._buildShell();
    this._renderRoots();
    this._renderSnippets();
    this._renderOutputPlaceholder('Not connected to a debug session.');
    this._syncUiState();
  }

  setActive(active) {
    this._active = active;
    if (active) {
      this._queryInput?.focus();
      this._queryInput?.select();
    }
  }

  setLoading(loading) {
    this._loading = Boolean(loading);
    this._syncUiState();
  }

  setDisconnected() {
    this._connected = false;
    this._result = null;
    this._syncUiState();
    this._setMeta('Disconnected');
    this._renderOutputPlaceholder('Not connected to a debug session.');
  }

  setConnected() {
    this._connected = true;
    this._syncUiState();
  }

  setError(message) {
    this._result = null;
    this._commandEl.textContent = '(no model path)';
    this._setMeta('Error');
    this._outputEl.innerHTML = `<div class="model-empty-output">${this._esc(message || 'Model query failed.')}</div>`;
  }

  setResult(payload) {
    const model = payload?.model ?? {};
    this._result = model;

    if (Array.isArray(model.roots) && model.roots.length > 0) {
      this._roots = model.roots.map((entry) => String(entry));
      this._renderRoots();
    }

    if (Array.isArray(model.snippets) && model.snippets.length > 0) {
      this._snippets = model.snippets.map((entry) => ({
        label: String(entry?.label ?? 'Snippet'),
        expr: String(entry?.expr ?? ''),
        depth: Number.isFinite(Number(entry?.depth)) ? Number(entry.depth) : 2,
      }));
      this._renderSnippets();
    }

    const summary = model.summary ?? {};
    const propertyCount = Number(summary.propertyCount ?? model.properties?.length ?? 0);
    const itemCount = Number(summary.itemCount ?? model.items?.length ?? 0);
    this._commandEl.textContent = String(model.expression || '(no model path)');
    this._setMeta(`${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'} · ${itemCount} item${itemCount === 1 ? '' : 's'}`);
    this._renderModelResult(model);
  }

  _buildShell() {
    this._container.classList.add('model-root');
    this._container.innerHTML = [
      '<div class="model-toolbar">',
      '  <div class="model-title">Model Explorer</div>',
      '  <div class="model-subtitle">Browse model paths and invoke methods: path.to.Method(arg1, \"arg2\")</div>',
      '  <div class="model-toolbar-right">',
      '    <span id="model-loading" class="model-loading" style="display:none"><span class="spinner"></span> Loading...</span>',
      '    <button id="model-refresh" class="model-btn" type="button">↻ Refresh</button>',
      '  </div>',
      '</div>',
      '<div class="model-layout">',
      '  <aside class="model-panel model-left">',
      '    <div class="model-panel-title">Root Paths</div>',
      '    <div id="model-roots" class="model-roots"></div>',
      '  </aside>',
      '  <section class="model-panel model-main">',
      '    <form id="model-query-form" class="model-query-form">',
      '      <input id="model-query-input" type="text" spellcheck="false" autocomplete="off" placeholder="@$curprocess.Modules">',
      '      <select id="model-depth-select" title="Browse depth">',
      '        <option value="0">Depth 0</option>',
      '        <option value="1">Depth 1</option>',
      '        <option value="2" selected>Depth 2</option>',
      '        <option value="3">Depth 3</option>',
      '        <option value="4">Depth 4</option>',
      '      </select>',
      '      <button id="model-run" type="submit">Browse</button>',
      '    </form>',
      '    <div class="model-quick-wrap">',
      '      <div class="model-panel-title">Quick Actions</div>',
      '      <div id="model-snippets" class="model-snippets"></div>',
      '    </div>',
      '    <div class="model-output-head">',
      '      <div class="model-output-head-main">',
      '        <div id="model-command" class="model-command">(no model path)</div>',
      '        <div id="model-meta" class="model-meta">No result</div>',
      '      </div>',
      '    </div>',
      '    <div id="model-output" class="model-output"></div>',
      '  </section>',
      '</div>',
    ].join('');

    this._loadingEl = this._container.querySelector('#model-loading');
    this._refreshBtn = this._container.querySelector('#model-refresh');
    this._rootsEl = this._container.querySelector('#model-roots');
    this._snippetsEl = this._container.querySelector('#model-snippets');
    this._form = this._container.querySelector('#model-query-form');
    this._queryInput = this._container.querySelector('#model-query-input');
    this._depthSelect = this._container.querySelector('#model-depth-select');
    this._runBtn = this._container.querySelector('#model-run');
    this._commandEl = this._container.querySelector('#model-command');
    this._metaEl = this._container.querySelector('#model-meta');
    this._outputEl = this._container.querySelector('#model-output');

    this._refreshBtn?.addEventListener('click', () => {
      if (this.onRefresh) this.onRefresh();
    });

    this._form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this._submitQuery();
    });

    this._rootsEl?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-root-path]');
      if (!button) return;
      const path = String(button.getAttribute('data-root-path') || '').trim();
      if (!path) return;
      this._queryInput.value = path;
      this._depthSelect.value = '2';
      this._submitQuery();
    });

    this._snippetsEl?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-snippet-index]');
      if (!button) return;
      const index = Number(button.getAttribute('data-snippet-index'));
      const snippet = Number.isFinite(index) ? this._snippets[index] : null;
      if (!snippet) return;

      this._queryInput.value = snippet.expr || '';
      this._depthSelect.value = String(Math.max(0, Math.min(4, Number(snippet.depth ?? 2))));
      this._submitQuery();
    });

    this._outputEl?.addEventListener('click', (event) => {
      const invokeButton = event.target.closest('[data-model-invoke]');
      if (invokeButton) {
        const methodPath = String(invokeButton.getAttribute('data-model-invoke') || '').trim();
        if (!methodPath) return;
        this._queryInput.value = `${methodPath}()`;
        this._submitQuery();
        return;
      }

      const button = event.target.closest('[data-model-path]');
      if (!button) return;
      const path = String(button.getAttribute('data-model-path') || '').trim();
      if (!path) return;
      this._queryInput.value = path;
      this._submitQuery();
    });
  }

  _syncUiState() {
    const blocked = this._loading || !this._connected;
    if (this._loadingEl) this._loadingEl.style.display = this._loading ? 'inline-flex' : 'none';
    if (this._queryInput) this._queryInput.disabled = blocked;
    if (this._depthSelect) this._depthSelect.disabled = blocked;
    if (this._runBtn) {
      this._runBtn.disabled = blocked;
      this._runBtn.textContent = this._loading ? 'Browsing...' : 'Browse';
    }
    if (this._refreshBtn) this._refreshBtn.disabled = this._loading;
  }

  async _submitQuery() {
    if (!this.onExecute || this._loading || !this._connected) return;

    const expression = String(this._queryInput?.value ?? '').trim();
    const depth = Number(this._depthSelect?.value ?? '2');

    if (!expression) {
      this._setMeta('Expression is required');
      this._renderOutputPlaceholder('Enter a model path or alias.');
      return;
    }

    this.setLoading(true);
    try {
      const response = await this.onExecute({ expression, depth });
      this.setResult(response);
    } catch (error) {
      this.setError(error?.message || 'Model query failed.');
    } finally {
      this.setLoading(false);
    }
  }

  _renderRoots() {
    if (!this._rootsEl) return;
    this._rootsEl.innerHTML = this._roots.map((path) => {
      const safe = this._esc(path);
      return `<button type="button" class="model-root-chip" data-root-path="${safe}">${safe}</button>`;
    }).join('');
  }

  _renderSnippets() {
    if (!this._snippetsEl) return;
    this._snippetsEl.innerHTML = this._snippets.map((snippet, index) => {
      const label = this._esc(snippet.label || `Snippet ${index + 1}`);
      const expr = this._esc(snippet.expr || '');
      return [
        `<button type="button" class="model-snippet" data-snippet-index="${index}">`,
        `  <span class="model-snippet-label">${label}</span>`,
        `  <span class="model-snippet-expr">${expr}</span>`,
        '</button>',
      ].join('');
    }).join('');
  }

  _renderOutputPlaceholder(text) {
    this._commandEl.textContent = '(no model path)';
    this._outputEl.innerHTML = `<div class="model-empty-output">${this._esc(text)}</div>`;
  }

  _renderModelResult(model) {
    if (!this._outputEl) return;

    if (model?.error) {
      this._outputEl.innerHTML = `<div class="model-empty-output">${this._esc(model.error)}</div>`;
      return;
    }

    const summary = model.summary ?? {};
    const properties = Array.isArray(model.properties) ? model.properties : [];
    const items = Array.isArray(model.items) ? model.items : [];
    const notes = Array.isArray(model.notes) ? model.notes : [];

    this._outputEl.innerHTML = [
      '<div class="model-result-grid">',
      this._renderSummarySection(summary),
      this._renderChildrenSection('Properties', properties, false),
      this._renderChildrenSection('Collection Items', items, true),
      this._renderNotesSection(notes),
      '</div>',
    ].join('');
  }

  _renderSummarySection(summary) {
    const rows = [
      ['Path', summary.path || '—'],
      ['Kind', summary.kind || '—'],
      ['Display', summary.display || '—'],
      ['Address', summary.address || '—'],
      ['Value Type', summary.valueType || '—'],
      ['Properties', String(summary.propertyCount ?? 0)],
      ['Items', String(summary.itemCount ?? 0)],
    ];

    const body = rows.map(([key, value]) => [
      '<div class="model-kv-row">',
      `  <div class="model-kv-key">${this._esc(key)}</div>`,
      `  <div class="model-kv-value">${this._formatValue(value)}</div>`,
      '</div>',
    ].join('')).join('');

    return [
      '<section class="model-result-section">',
      '  <div class="model-panel-title">Object Summary</div>',
      `  <div class="model-kv-list">${body}</div>`,
      '</section>',
    ].join('');
  }

  _renderChildrenSection(title, rows, isItems) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const header = isItems
      ? ['Index', 'Kind', 'Display', 'Address', 'Path']
      : ['Name', 'Kind', 'Display', 'Address', 'Path'];

    const body = safeRows.map((row) => {
      const first = isItems ? this._esc(String(row.index ?? row.label ?? '—')) : this._esc(row.label || '—');
      const path = this._esc(row.path || '');
      const rawPath = String(row.path || '').trim();
      const isInvokable = this._isInvokableKind(row.kind || row.declaredKind || '');
      return [
        '<tr>',
        `  <td>${first}</td>`,
        `  <td>${this._renderKindBadge(row.kind || row.declaredKind || '—')}</td>`,
        `  <td>${this._formatValue(row.display || row.value || '—')}</td>`,
        `  <td>${this._formatValue(row.address || '—')}</td>`,
        `  <td><div class="model-path-actions">${isInvokable ? `<button type="button" class="model-invoke-action" data-model-invoke="${path}" title="Invoke ${path}">Invoke</button>` : ''}<button type="button" class="model-path-action" data-model-path="${path}" title="${path}"><span class="model-path-pill-label">Path</span><span class="model-path-pill-value">${this._esc(rawPath || 'Open')}</span></button></div></td>`,
        '</tr>',
      ].join('');
    }).join('');

    return [
      '<section class="model-result-section">',
      `  <div class="model-panel-title">${this._esc(title)}</div>`,
      safeRows.length > 0
        ? [
            '  <div class="model-table-wrap">',
            '    <table class="model-table">',
            `      <thead><tr>${header.map((column) => `<th>${this._esc(column)}</th>`).join('')}</tr></thead>`,
            `      <tbody>${body}</tbody>`,
            '    </table>',
            '  </div>',
          ].join('')
        : '  <div class="model-empty-output small">No entries.</div>',
      '</section>',
    ].join('');
  }

  _renderNotesSection(notes) {
    const safeNotes = Array.isArray(notes) ? notes : [];
    return [
      '<section class="model-result-section">',
      '  <div class="model-panel-title">Notes</div>',
      safeNotes.length > 0
        ? `<div class="model-note-list">${safeNotes.map((note) => `<div class="model-note-item">${this._esc(note)}</div>`).join('')}</div>`
        : '  <div class="model-empty-output small">No notes.</div>',
      '</section>',
    ].join('');
  }

  _renderKindBadge(kind) {
    const rawKind = String(kind || 'Unknown').trim() || 'Unknown';
    const lower = rawKind.toLowerCase();
    const classList = ['model-kind-badge'];

    if (lower.includes('synthetic')) {
      classList.push('kind-synthetic');
    } else if (lower.includes('intrinsic') || lower.includes('scalar') || lower.includes('primitive')) {
      classList.push('kind-intrinsic');
    } else if (lower.includes('array') || lower.includes('collection') || lower.includes('list') || lower.includes('iterable')) {
      classList.push('kind-collection');
    } else if (lower.includes('object')) {
      classList.push('kind-object');
    } else if (lower.includes('method') || lower.includes('function') || lower.includes('callable')) {
      classList.push('kind-method');
    } else if (lower.includes('error') || lower.includes('invalid')) {
      classList.push('kind-error');
    } else {
      classList.push('kind-default');
    }

    return `<span class="${classList.join(' ')}">${this._esc(rawKind)}</span>`;
  }

  _isInvokableKind(kind) {
    const lower = String(kind || '').toLowerCase();
    return lower.includes('method') || lower.includes('synthetic');
  }

  _formatValue(value) {
    const text = String(value ?? '');
    const parts = text.split(/(0x[0-9a-fA-F]+|@[A-Za-z_$][\w.$\[\]]*|\b(?:true|false|null|undefined)\b|\b\d+\b)/g);
    return parts.map((part) => {
      if (!part) return '';
      if (/^0x[0-9a-fA-F]+$/.test(part)) {
        return `<span class="model-token model-token-address">${this._esc(part)}</span>`;
      }
      if (/^@[A-Za-z_$][\w.$\[\]]*$/.test(part)) {
        return `<span class="model-token model-token-symbol">${this._esc(part)}</span>`;
      }
      if (/^(true|false|null|undefined)$/.test(part)) {
        return `<span class="model-token model-token-keyword">${this._esc(part)}</span>`;
      }
      if (/^\d+$/.test(part)) {
        return `<span class="model-token model-token-number">${this._esc(part)}</span>`;
      }
      return this._esc(part);
    }).join('');
  }

  _setMeta(text) {
    if (this._metaEl) this._metaEl.textContent = String(text || '');
  }

  _esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
