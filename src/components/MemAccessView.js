/**
 * MemAccessView — TTD Memory Access browser
 * Time range set via percent input boxes (no slider).
 * Every request always includes start and end percent values.
 * Default: 0%–5%.
 */
export default class MemAccessView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this.onSearch = null;    // async (params) => data
    this.onClickPosition = null;  // (major, minor, threadId) => void

    this._timeStartPct = 0;
    this._timeEndPct = 5;

    // Pagination
    this._currentPage = 0;
    this._pageSize = 500;

    this._buildShell();
  }

  setActive(active) { this._active = active; }

  acceptPrefill(startAddr, endAddr, mode = 'R') {
    if (this._startInput) this._startInput.value = startAddr || '';
    if (this._endInput) this._endInput.value = endAddr || '';
    if (this._modeSelect) this._modeSelect.value = mode;
  }

  setTraceInfo(traceInfo) {
    this._traceInfo = traceInfo;
    this._updateTraceLabel();
  }

  setLoading(loading) {
    if (this._loadingEl) this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    if (this._submitBtn) {
      this._submitBtn.disabled = loading;
      this._submitBtn.textContent = loading ? 'Querying…' : 'Query';
    }
    if (this._prevPageBtn) this._prevPageBtn.disabled = loading;
    if (this._nextPageBtn) this._nextPageBtn.disabled = loading;
  }

  setDisconnected() { this._data = null; this._renderPlaceholder('◎', 'Not connected to a debug session.'); }
  setError(message) { this._renderPlaceholder('✕', message || 'Query failed.'); }
  setData(data) { this._data = data; this._currentPage = 0; this._render(); }

  // -------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------

  _buildShell() {
    this._container.classList.add('ma-root');
    this._container.innerHTML = [
      '<div class="ma-toolbar">',
      '  <div class="ma-toolbar-title">Memory Access</div>',
      '  <span id="ma-trace-label" class="ma-trace-label"></span>',
      '  <div class="ma-toolbar-right">',
      '    <span id="ma-loading" class="ma-loading" style="display:none"><span class="spinner"></span> </span>',
      '  </div>',
      '</div>',
      '<div class="ma-body">',
      '  <section class="ma-query-panel">',
      '    <div class="ma-section-head">',
      '      <div class="ma-section-title">Query</div>',
      '      <div class="ma-section-meta">Set the time range as a percentage of the trace, then click Query.</div>',
      '    </div>',
      '    <form id="ma-query-form" class="ma-query-form">',
      '      <button id="ma-prev-page" class="ma-btn small secondary ma-nav-btn" type="button" title="Prev 32B" disabled>◀</button>',
      '      <div class="ma-field">',
      '        <label for="ma-start-addr">Start Address</label>',
      '        <input id="ma-start-addr" type="text" spellcheck="false" autocomplete="off" placeholder="0x7ff758f65000">',
      '      </div>',
      '      <div class="ma-field">',
      '        <label for="ma-end-addr">End Address</label>',
      '        <input id="ma-end-addr" type="text" spellcheck="false" autocomplete="off" placeholder="0x7ff758f65020">',
      '      </div>',
      '      <button id="ma-next-page" class="ma-btn small secondary ma-nav-btn" type="button" title="Next 32B" disabled>▶</button>',
      '      <div class="ma-field">',
      '        <label for="ma-mode">Mode</label>',
      '        <select id="ma-mode">',
      '          <option value="R">R (Reads)</option>',
      '          <option value="W">W (Writes)</option>',
      '          <option value="RW">RW (Both)</option>',
      '          <option value="E">E (Execute)</option>',
      '        </select>',
      '      </div>',
      '      <button class="ma-btn primary" id="ma-query-submit" type="submit">Query</button>',
      '    </form>',
      // Time range — percent boxes only
      '    <div class="ma-time-range">',
      '      <div class="ma-time-range-label">',
      '        <span>Time Range</span>',
      '      </div>',
      '      <div class="ma-time-inputs">',
      '        <div class="ma-field ma-time-pct-field">',
      '          <label for="ma-time-start-pct">Start %</label>',
      '          <input id="ma-time-start-pct" type="number" min="0" max="100" step="0.1" value="0">',
      '        </div>',
      '        <span class="ma-time-sep">–</span>',
      '        <div class="ma-field ma-time-pct-field">',
      '          <label for="ma-time-end-pct">End %</label>',
      '          <input id="ma-time-end-pct" type="number" min="0" max="100" step="0.1" value="5">',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="ma-query-chips">',
      '      <button type="button" class="ma-chip" data-start="0x7ff758f65000" data-end="0x7ff758f65020" data-mode="R">taskmgr .data reads (32B)</button>',
      '      <button type="button" class="ma-chip" data-start="0x7ff758f65000" data-end="0x7ff758f65020" data-mode="W">taskmgr .data writes (32B)</button>',
      '    </div>',
      '  </section>',
      '  <section class="ma-results-panel">',
      '    <div class="ma-section-head">',
      '      <div class="ma-section-title">Results</div>',
      '      <div id="ma-results-meta" class="ma-section-meta">—</div>',
      '    </div>',
      '    <div id="ma-pagination" class="ma-pagination" style="display:none">',
      '      <button id="ma-page-prev" class="ma-btn small secondary" type="button">◀ Prev</button>',
      '      <span id="ma-page-indicator" class="ma-page-indicator">Page 1 / 1</span>',
      '      <select id="ma-page-size" class="ma-page-size">',
      '        <option value="100">100 / page</option>',
      '        <option value="500" selected>500 / page</option>',
      '        <option value="1000">1000 / page</option>',
      '        <option value="5000">5000 / page</option>',
      '      </select>',
      '      <button id="ma-page-next" class="ma-btn small secondary" type="button">Next ▶</button>',
      '    </div>',
      '    <div class="ma-table-wrap">',
      '      <table class="ma-table">',
      '        <thead><tr><th>#</th><th>Type</th><th>Address</th><th>Size</th><th>Value</th><th>Old Value</th><th>Position</th><th>IP</th><th>IP Symbol</th><th>TID</th></tr></thead>',
      '        <tbody id="ma-results-body"></tbody>',
      '      </table>',
      '    </div>',
      '    <div id="ma-placeholder" class="ma-placeholder"></div>',
      '  </section>',
      '</div>'
    ].join('');

    this._loadingEl = this._container.querySelector('#ma-loading');
    this._prevPageBtn = this._container.querySelector('#ma-prev-page');
    this._nextPageBtn = this._container.querySelector('#ma-next-page');
    this._form = this._container.querySelector('#ma-query-form');
    this._startInput = this._container.querySelector('#ma-start-addr');
    this._endInput = this._container.querySelector('#ma-end-addr');
    this._modeSelect = this._container.querySelector('#ma-mode');
    this._submitBtn = this._container.querySelector('#ma-query-submit');
    this._resultsMeta = this._container.querySelector('#ma-results-meta');
    this._resultsBody = this._container.querySelector('#ma-results-body');
    this._placeholder = this._container.querySelector('#ma-placeholder');
    this._pagination = this._container.querySelector('#ma-pagination');
    this._pagePrevBtn = this._container.querySelector('#ma-page-prev');
    this._pageNextBtn = this._container.querySelector('#ma-page-next');
    this._pageIndicator = this._container.querySelector('#ma-page-indicator');
    this._pageSizeSelect = this._container.querySelector('#ma-page-size');
    this._traceLabel = this._container.querySelector('#ma-trace-label');
    this._timeStartPctInput = this._container.querySelector('#ma-time-start-pct');
    this._timeEndPctInput = this._container.querySelector('#ma-time-end-pct');

    // Events
    this._form?.addEventListener('submit', (e) => { e.preventDefault(); this._submitSearch(); });
    this._container.querySelectorAll('.ma-query-chips .ma-chip').forEach((b) => {
      b.addEventListener('click', () => {
        this._startInput.value = b.dataset.start || '';
        this._endInput.value = b.dataset.end || '';
        if (b.dataset.mode) this._modeSelect.value = b.dataset.mode;
        this._submitSearch();
      });
    });
    this._prevPageBtn?.addEventListener('click', () => this._stepPage(-1));
    this._nextPageBtn?.addEventListener('click', () => this._stepPage(1));
    this._timeStartPctInput?.addEventListener('change', () => {
      this._timeStartPct = this._clampPct(parseFloat(this._timeStartPctInput.value));
    });
    this._timeEndPctInput?.addEventListener('change', () => {
      this._timeEndPct = this._clampPct(parseFloat(this._timeEndPctInput.value));
    });
    this._resultsBody?.addEventListener('click', (e) => {
      const row = e.target.closest('.ma-row');
      if (!row || !this.onClickPosition) return;
      const { major, minor, tid } = row.dataset;
      if (major) this.onClickPosition(major, minor, tid);
    });

    // Pagination events
    this._pagePrevBtn?.addEventListener('click', () => this._goToPage(this._currentPage - 1));
    this._pageNextBtn?.addEventListener('click', () => this._goToPage(this._currentPage + 1));
    this._pageSizeSelect?.addEventListener('change', () => {
      this._pageSize = parseInt(this._pageSizeSelect.value, 10) || 500;
      this._goToPage(0);
    });

    this._renderPlaceholder('◌', 'Enter addresses, set the time range, and click Query.');
  }

  // -------------------------------------------------------------------
  // Helper
  // -------------------------------------------------------------------

  _clampPct(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v));
  }

  // -------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------

  async _submitSearch() {
    if (!this.onSearch) return;
    const startAddr = String(this._startInput?.value ?? '').trim();
    const endAddr = String(this._endInput?.value ?? '').trim();
    const mode = String(this._modeSelect?.value ?? 'W');
    if (!startAddr || !endAddr) {
      this.setError('Both start and end addresses are required.');
      return;
    }
    try {
      if (BigInt(endAddr) <= BigInt(startAddr)) { this.setError('End must be > start.'); return; }
    } catch {
      this.setError('Invalid hex address format.'); return;
    }

    // Read current percent values from inputs
    this._timeStartPct = this._clampPct(parseFloat(this._timeStartPctInput?.value ?? 0));
    this._timeEndPct = this._clampPct(parseFloat(this._timeEndPctInput?.value ?? 5));

    try {
      this.setLoading(true);
      const params = {
        startAddr, endAddr, mode,
        timeStartPct: this._timeStartPct,
        timeEndPct: this._timeEndPct,
      };
      this.setData(await this.onSearch(params));
    } catch (error) {
      this.setError(error?.message || 'Query failed.');
    } finally {
      this.setLoading(false);
    }
  }

  _stepPage(direction) {
    const startText = String(this._startInput?.value ?? '').trim();
    if (!startText) return;
    let start; try { start = BigInt(startText); } catch { return; }
    const PAGE = 0x20n;
    const newStart = start + BigInt(direction) * PAGE;
    if (newStart < 0n) return;
    this._startInput.value = `0x${newStart.toString(16)}`;
    this._endInput.value = `0x${(newStart + PAGE).toString(16)}`;
    this._submitSearch();
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  _renderPlaceholder(icon, text) {
    this._resultsMeta.textContent = '—';
    this._placeholder.innerHTML = `<div class="ma-empty"><div class="ma-empty-icon">${this._esc(icon)}</div><div class="ma-empty-text">${this._esc(text)}</div></div>`;
    this._placeholder.style.display = 'flex';
    this._resultsBody.innerHTML = '';
    if (this._pagination) this._pagination.style.display = 'none';
  }

  _render() {
    const accesses = Array.isArray(this._data?.accesses) ? this._data.accesses : [];
    const totalCount = this._data?.totalCount ?? accesses.length;
    const collectedCount = this._data?.collectedCount ?? accesses.length;
    const timedOut = this._data?.timedOut ?? false;
    const timingMs = this._data?.timing?.elapsedMs ?? 0;

    let meta = `${collectedCount} / ${totalCount.toLocaleString()} events · ${timingMs}ms`;
    if (timedOut) meta += ' (timed out)';
    meta += ` · ${this._timeStartPct}%–${this._timeEndPct}%`;
    this._resultsMeta.textContent = meta;

    if (accesses.length === 0) {
      const msg = timedOut && totalCount > 0
        ? `Timed out — ${totalCount.toLocaleString()} events. Narrow the time window.`
        : (this._data?.message || 'No memory access events found.');
      this._renderPlaceholder(timedOut ? '⏱' : totalCount > 0 ? '⚠' : 'Ø', msg);
      return;
    }
    if (timedOut) { this._renderPlaceholder('⚠', `Partial — ${collectedCount} of ${totalCount.toLocaleString()}. Narrow the time window.`); return; }

    // Pagination — slice accesses for the current page
    const totalPages = Math.max(1, Math.ceil(collectedCount / this._pageSize));
    if (this._currentPage >= totalPages) this._currentPage = totalPages - 1;
    const startIdx = this._currentPage * this._pageSize;
    const endIdx = Math.min(startIdx + this._pageSize, collectedCount);
    const pageAccesses = accesses.slice(startIdx, endIdx);

    this._placeholder.style.display = 'none';
    this._resultsBody.innerHTML = pageAccesses.map((a, i) => {
      const globalIdx = startIdx + i + 1;
      const pos = this._formatPosition(a);
      return `<tr class="ma-row" data-major="${a.startPos?.major ?? ''}" data-minor="${a.startPos?.minor ?? 0}" data-tid="${a?.threadId ?? ''}">`
        + `<td class="ma-cell-num">${globalIdx}</td>`
        + `<td class="ma-cell-type ma-type-${this._esc(a?.accessType ?? '').toLowerCase()}">${this._esc(a?.accessType ?? '')}</td>`
        + `<td class="ma-cell-addr">${this._esc(a?.address ?? '—')}</td>`
        + `<td class="ma-cell-num">${a?.size ?? '—'}</td>`
        + `<td class="ma-cell-val">${this._esc(a?.value ?? '—')}</td>`
        + `<td class="ma-cell-val ma-oldval">${this._esc(a?.overwrittenValue ?? '—')}</td>`
        + `<td class="ma-cell-pos">${pos}</td>`
        + `<td class="ma-cell-addr">${this._esc(a?.ip ?? '—')}</td>`
        + `<td class="ma-cell-sym" title="${this._esc(a?.ipSymbol ?? '')}">${this._esc(a?.ipSymbol ?? '')}</td>`
        + `<td class="ma-cell-num">${a?.threadId ?? '—'}</td></tr>`;
    }).join('');

    this._updatePagination(totalPages);
  }

  /** Format position for display. Backend now correctly computes startPos
   *  from the previous event's end position (TTD only stores TimeEnd). */
  _formatPosition(a) {
    const start = a?.startPos;
    if (!start) return '\u2014';  // em dash
    try {
      const sm = (typeof start.major === 'bigint' ? start.major : BigInt(start.major ?? '0')).toString(16).toUpperCase();
      const sn = (typeof start.minor === 'bigint' ? start.minor : BigInt(start.minor ?? 0)).toString(16).toUpperCase();
      return `${sm}:${sn}`;
    } catch {
      return '\u2014';
    }
  }

  _updatePagination(totalPages) {
    if (!this._pagination) return;
    this._pagination.style.display = '';
    if (this._pagePrevBtn) this._pagePrevBtn.disabled = this._currentPage <= 0;
    if (this._pageNextBtn) this._pageNextBtn.disabled = this._currentPage >= totalPages - 1;
    if (this._pageIndicator) this._pageIndicator.textContent = `Page ${this._currentPage + 1} / ${totalPages}`;
  }

  _goToPage(page) {
    const totalCount = this._data?.collectedCount ?? (this._data?.accesses?.length ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / this._pageSize));
    const newPage = Math.max(0, Math.min(page, totalPages - 1));
    if (newPage === this._currentPage) return;
    this._currentPage = newPage;
    this._render();
  }

  _updateTraceLabel() {
    if (!this._traceLabel) return;
    const t = this._traceInfo;
    if (!t?.available) { this._traceLabel.textContent = ''; return; }
    this._traceLabel.textContent = `Trace: ${t.firstPos?.major ?? '?'}:${t.firstPos?.minor ?? 0} → ${t.lastPos?.major ?? '?'}:${t.lastPos?.minor ?? 0}`;
  }

  _esc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
}
