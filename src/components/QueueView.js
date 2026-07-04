/**
 * QueueView — Request queue + persistent history monitor.
 * Polls continuously regardless of active tab.
 * Primary display: request history with timestamps, status, timing, details.
 */

const POLL_INTERVAL_MS = 300;
const HISTORY_PAGE_SIZE = 20;

export default class QueueView {
  constructor(container) {
    this._container = container;
    this._timer = null;
    this._prevHistoryLen = 0;

    // Callback set by App: () => { processing, queueLength, items, history, activeLabel, activeStart }
    this.onGetState = null;
    this.onExport = null;
    this.onLoadStoryline = null;

    this._buildShell();
    document.getElementById('q-btn-export')?.addEventListener('click', () => {
      this.onExport?.();
    });
    document.getElementById('q-btn-load-storyline')?.addEventListener('click', () => {
      this._fileInput?.click();
    });
    this._fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this._handleFile(file);
      e.target.value = '';
    });
    this._timer = setInterval(() => this._refresh(), POLL_INTERVAL_MS);
  }

  async _handleFile(file) {
    try {
      const text = await file.text();
      const archive = JSON.parse(text);
      this.onLoadStoryline?.(archive);
    } catch (err) {
      console.error('[QueueView] Failed to load storyline file:', err);
    }
  }

  setActive(_active) {}
  setDisconnected() {}

  // -------------------------------------------------------------------

  _buildShell() {
    this._container.classList.add('q-view-root');
    this._container.innerHTML = [
      '<div class="q-view-toolbar">',
      '  <div class="q-view-toolbar-title">Request Queue</div>',
      '  <div class="q-view-toolbar-right">',
      '    <button class="q-view-toolbar-btn q-btn-load-storyline" id="q-btn-load-storyline" title="Load a .storyline.json archive and enter replay mode">Load Storyline…</button>',
      '    <button class="q-view-toolbar-btn q-btn-export" id="q-btn-export" title="Export storyline archive">Export</button>',
      '    <input type="file" id="q-file-input" accept=".json,application/json" style="display:none">',
      '    <div class="q-view-toolbar-subtitle">History + live state · 300ms poll</div>',
      '  </div>',
      '</div>',
      '<div class="q-view-body">',
      '  <section class="q-view-section">',
      '    <div class="q-view-section-head">',
      '      <div class="q-view-section-title">Live State</div>',
      '      <div id="q-view-state-meta" class="q-view-section-meta"></div>',
      '    </div>',
      '    <div class="q-view-cards">',
      '      <div class="q-view-card">',
      '        <div class="q-view-card-label">Processing</div>',
      '        <div class="q-view-card-value" id="q-val-processing">—</div>',
      '      </div>',
      '      <div class="q-view-card">',
      '        <div class="q-view-card-label">Active</div>',
      '        <div class="q-view-card-value" id="q-val-active">—</div>',
      '      </div>',
      '      <div class="q-view-card">',
      '        <div class="q-view-card-label">Queued</div>',
      '        <div class="q-view-card-value" id="q-val-queued">—</div>',
      '      </div>',
      '      <div class="q-view-card">',
      '        <div class="q-view-card-label">History</div>',
      '        <div class="q-view-card-value" id="q-val-total">0</div>',
      '      </div>',
      '    </div>',
      '  </section>',
      '  <section class="q-view-section">',
      '    <div class="q-view-section-head">',
      '      <div class="q-view-section-title">Queue</div>',
      '      <div id="q-view-items-meta" class="q-view-section-meta"></div>',
      '    </div>',
      '    <div class="q-view-table-wrap">',
      '      <table class="q-view-table">',
      '        <thead>',
      '          <tr><th>#</th><th>Label</th><th>Prio</th></tr>',
      '        </thead>',
      '        <tbody id="q-view-items-body"></tbody>',
      '      </table>',
      '    </div>',
      '    <div id="q-view-empty" class="q-view-empty" style="display:none">',
      '      <div class="q-view-empty-icon">Ø</div>',
      '      <div class="q-view-empty-text">Queue is empty</div>',
      '    </div>',
      '  </section>',
      '  <section class="q-view-section">',
      '    <div class="q-view-section-head">',
      '      <div class="q-view-section-title">Request History</div>',
      '      <div id="q-view-hist-meta" class="q-view-section-meta"></div>',
      '    </div>',
      '    <div class="q-view-table-wrap">',
      '      <table class="q-view-table">',
      '        <thead>',
      '          <tr>',
      '            <th>#</th><th>T+ms</th><th>Label</th><th>Prio</th>',
      '            <th>Elapsed</th><th>Status</th><th>Detail</th>',
      '          </tr>',
      '        </thead>',
      '        <tbody id="q-view-hist-body"></tbody>',
      '      </table>',
      '    </div>',
      '    <div id="q-view-hist-empty" class="q-view-empty">',
      '      <div class="q-view-empty-icon">Ø</div>',
      '      <div class="q-view-empty-text">No requests yet</div>',
      '    </div>',
      '  </section>',
      '</div>',
    ].join('');

    this._meta = this._container.querySelector('#q-view-state-meta');
    this._fileInput = this._container.querySelector('#q-file-input');
    this._valProcessing = this._container.querySelector('#q-val-processing');
    this._valActive = this._container.querySelector('#q-val-active');
    this._valQueued = this._container.querySelector('#q-val-queued');
    this._valTotal = this._container.querySelector('#q-val-total');
    this._itemsMeta = this._container.querySelector('#q-view-items-meta');
    this._itemsBody = this._container.querySelector('#q-view-items-body');
    this._emptyEl = this._container.querySelector('#q-view-empty');
    this._histMeta = this._container.querySelector('#q-view-hist-meta');
    this._histBody = this._container.querySelector('#q-view-hist-body');
    this._histEmpty = this._container.querySelector('#q-view-hist-empty');

    this._baseTime = Date.now();
  }

  _refresh() {
    const state = this.onGetState?.();
    if (!state) return;

    const now = Date.now();
    this._meta.textContent = new Date(now).toLocaleTimeString();

    // --- Live state cards ---
    const processing = state.processing;
    this._valProcessing.textContent = processing ? 'ACTIVE' : 'idle';
    this._valProcessing.className = 'q-view-card-value ' +
      (processing ? 'q-view-badge-busy' : 'q-view-badge-idle');

    if (processing && state.activeLabel) {
      const elapsed = state.activeStart ? ` (${now - state.activeStart}ms)` : '';
      this._valActive.textContent = state.activeLabel + elapsed;
      this._valActive.className = 'q-view-card-value q-view-badge-flight';
    } else {
      this._valActive.textContent = 'none';
      this._valActive.className = 'q-view-card-value';
    }

    this._valQueued.textContent = String(state.queueLength);
    this._valQueued.className = 'q-view-card-value ' +
      (state.queueLength > 0 ? 'q-view-badge-busy' : '');

    // --- Queue table ---
    const items = state.items ?? [];
    this._itemsMeta.textContent = items.length > 0
      ? `${items.length} pending` : 'empty';
    this._itemsBody.innerHTML = items.map((item, i) => [
      '<tr>',
      `  <td class="q-view-cell-num">${i + 1}</td>`,
      `  <td class="q-view-cell-label" title="${this._esc(item._path || item.label)}">${this._esc(item.label)}</td>`,
      `  <td class="q-view-cell-prio q-view-prio-${item.priority}">${item.priority}</td>`,
      '</tr>',
    ].join('')).join('');
    this._emptyEl.style.display = items.length === 0 ? 'block' : 'none';

    // --- History table ---
    const history = state.history ?? [];
    this._valTotal.textContent = String(history.length);
    this._histMeta.textContent = `${history.length} entries (last 200)`;

    if (history.length === 0) {
      this._histBody.innerHTML = '';
      this._histEmpty.style.display = 'block';
      return;
    }

    this._histEmpty.style.display = 'none';

    // Render most recent entries first (reversed), show last N
    const entries = [...history].reverse().slice(0, HISTORY_PAGE_SIZE);

    this._histBody.innerHTML = entries.map((e, i) => {
      const tOffset = e.startTime ? (e.startTime - this._baseTime) : 0;
      const timeStr = tOffset >= 0 ? `+${tOffset}ms` : `${tOffset}ms`;
      const statusCls = `q-view-status-${e.status}`;
      const statusIcon = { ok: '✓', error: '✕', cancelled: '◌' }[e.status] || '?';
      const detail = e.detail ? this._esc(String(e.detail).substring(0, 80)) : '';

      return [
        '<tr class="q-view-hist-row">',
        `  <td class="q-view-cell-num">${history.length - i}</td>`,
        `  <td class="q-view-cell-time">${timeStr}</td>`,
        `  <td class="q-view-cell-label" title="${this._esc(e.path || '')}">${this._esc(e.label)}</td>`,
        `  <td class="q-view-cell-prio q-view-prio-${e.priority}">${e.priority}</td>`,
        `  <td class="q-view-cell-elapsed">${e.elapsedMs}ms</td>`,
        `  <td class="q-view-cell-status ${statusCls}">${statusIcon} ${e.status}</td>`,
        `  <td class="q-view-cell-detail">${detail}</td>`,
        '</tr>',
      ].join('');
    }).join('');

    this._prevHistoryLen = history.length;
  }

  _esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
