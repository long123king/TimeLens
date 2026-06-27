export default class StringsView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this._lastQuery = '';
    this._lastLimit = 100;
    this.onSearch = null;
    this.onRefresh = null;
    this.onViewSvg = null;

    this._buildShell();
  }

  setActive(active) {
    this._active = active;
    if (active) {
      this._queryInput?.focus();
    }
  }

  setLoading(loading) {
    if (this._loadingEl) {
      this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    }
    if (this._submitBtn) {
      this._submitBtn.disabled = loading;
      this._submitBtn.textContent = loading ? 'Searching...' : 'Search';
    }
  }

  setDisconnected() {
    this._data = null;
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
  }

  setError(message) {
    this._renderPlaceholder('✕', message || 'String search failed.');
  }

  setData(data) {
    this._data = data;
    this._render();
  }

  _buildShell() {
    this._container.classList.add('str-root');
    this._container.innerHTML = [
      '<div class="str-toolbar">',
      '  <div class="str-toolbar-title">Strings</div>',
      '  <div class="str-toolbar-subtitle">Smart search scans writable user-memory first, then falls back to loaded module images for ASCII and UTF-16 strings</div>',
      '  <div class="str-toolbar-right">',
      '    <span id="str-loading" class="str-loading" style="display:none"><span class="spinner"></span> Searching...</span>',
      '    <button class="str-btn secondary" id="str-refresh" type="button">↻ Refresh</button>',
      '  </div>',
      '</div>',
      '<div class="str-body">',
      '  <section class="str-query-panel">',
      '    <div class="str-section-head">',
      '      <div class="str-section-title">Search Query</div>',
      '      <div class="str-section-meta">ASCII and UNICODE are executed separately with a fast writable-pass and a narrower image fallback</div>',
      '    </div>',
      '    <form id="str-query-form" class="str-query-form">',
      '      <input id="str-query-input" type="text" spellcheck="false" autocomplete="off" placeholder="kernel32, LoadLibraryW, /flag, config, hello">',
      '      <input id="str-limit-input" type="number" min="1" max="500" step="1" value="100" title="Result limit">',
      '      <button class="str-btn primary" id="str-query-submit" type="submit">Search</button>',
      '    </form>',
      '    <div class="str-query-hint">Use a plain string. The backend starts with writable pages and only falls back to loaded module images when the fast pass misses.</div>',
      '    <div class="str-query-chips">',
      '      <button type="button" class="str-chip" data-query="http">http</button>',
      '      <button type="button" class="str-chip" data-query="kernel32">kernel32</button>',
      '      <button type="button" class="str-chip" data-query="LoadLibrary">LoadLibrary</button>',
      '      <button type="button" class="str-chip" data-query="Microsoft">Microsoft</button>',
      '    </div>',
      '  </section>',
      '  <section class="str-results-panel">',
      '    <div class="str-result-column ascii">',
      '      <div class="str-section-head">',
      '        <div class="str-section-title">ASCII Results</div>',
      '        <div id="str-ascii-meta" class="str-section-meta">0 matches</div>',
      '      </div>',
      '      <div id="str-ascii-results" class="str-result-list"></div>',
      '    </div>',
      '    <div class="str-result-column unicode">',
      '      <div class="str-section-head">',
      '        <div class="str-section-title">UNICODE Results</div>',
      '        <div id="str-unicode-meta" class="str-section-meta">0 matches</div>',
      '      </div>',
      '      <div id="str-unicode-results" class="str-result-list"></div>',
      '    </div>',
      '  </section>',
      '  <section class="str-notes-panel">',
      '    <div class="str-section-head">',
      '      <div class="str-section-title">Notes</div>',
      '      <div class="str-section-meta">Search details and backend observations</div>',
      '    </div>',
      '    <div id="str-notes" class="str-notes"></div>',
      '  </section>',
      '</div>'
    ].join('');

    this._loadingEl = this._container.querySelector('#str-loading');
    this._form = this._container.querySelector('#str-query-form');
    this._queryInput = this._container.querySelector('#str-query-input');
    this._limitInput = this._container.querySelector('#str-limit-input');
    this._submitBtn = this._container.querySelector('#str-query-submit');
    this._asciiMeta = this._container.querySelector('#str-ascii-meta');
    this._unicodeMeta = this._container.querySelector('#str-unicode-meta');
    this._asciiList = this._container.querySelector('#str-ascii-results');
    this._unicodeList = this._container.querySelector('#str-unicode-results');
    this._notesEl = this._container.querySelector('#str-notes');

    this._container.querySelector('#str-refresh')?.addEventListener('click', () => {
      if (String(this._queryInput?.value ?? '').trim()) {
        this._submitSearch();
        return;
      }
      if (this._lastQuery) {
        this._queryInput.value = this._lastQuery;
        if (this._limitInput) this._limitInput.value = String(this._lastLimit);
        this._submitSearch();
        return;
      }
      if (this.onRefresh) this.onRefresh();
    });

    this._form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this._submitSearch();
    });

    this._container.querySelectorAll('.str-chip').forEach((button) => {
      button.addEventListener('click', () => {
        const query = String(button.dataset.query || '').trim();
        if (!query) return;
        this._queryInput.value = query;
        this._submitSearch();
      });
    });

    this._container.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('.str-view-svg-btn') : null;
      if (!button) return;

      const address = String(button.getAttribute('data-address') || '').trim();
      if (!address || !this.onViewSvg) return;
      this.onViewSvg(address);
    });

    this._renderPlaceholder('◌', 'Run a search to populate ASCII and UNICODE result lanes.');
  }

  async _submitSearch() {
    if (!this.onSearch) return;
    const query = String(this._queryInput?.value ?? '').trim();
    const limit = Number(this._limitInput?.value ?? 100);

    if (!query) {
      this.setError('Enter a search string first.');
      return;
    }

    this._lastQuery = query;
    this._lastLimit = limit;

    try {
      this.setLoading(true);
      const data = await this.onSearch({ query, limit });
      this.setData(data);
    } catch (error) {
      this.setError(error?.message || 'String search failed.');
    } finally {
      this.setLoading(false);
    }
  }

  _renderPlaceholder(icon, text) {
    this._asciiMeta.textContent = '0 matches';
    this._unicodeMeta.textContent = '0 matches';
    const markup = [
      '<div class="str-empty">',
      `  <div class="str-empty-icon">${this._esc(icon)}</div>`,
      `  <div class="str-empty-text">${this._esc(text)}</div>`,
      '</div>'
    ].join('');
    this._asciiList.innerHTML = markup;
    this._unicodeList.innerHTML = markup;
    this._notesEl.innerHTML = '<div class="str-note-item">No notes yet.</div>';
  }

  _render() {
    const ascii = Array.isArray(this._data?.ascii) ? this._data.ascii : [];
    const unicode = Array.isArray(this._data?.unicode) ? this._data.unicode : [];
    const notes = Array.isArray(this._data?.notes) ? this._data.notes : [];
    const query = String(this._data?.query?.text ?? '').trim();

    this._asciiMeta.textContent = `${ascii.length} match${ascii.length === 1 ? '' : 'es'}`;
    this._unicodeMeta.textContent = `${unicode.length} match${unicode.length === 1 ? '' : 'es'}`;
    this._asciiList.innerHTML = this._renderResultList(ascii, 'ASCII', query);
    this._unicodeList.innerHTML = this._renderResultList(unicode, 'UNICODE', query);
    this._notesEl.innerHTML = notes.length > 0
      ? notes.map((note) => `<div class="str-note-item">${this._esc(note)}</div>`).join('')
      : '<div class="str-note-item">Search completed without additional notes.</div>';
  }

  _renderResultList(results, mode, query) {
    if (!results.length) {
      return '<div class="str-empty small"><div class="str-empty-text">No matches.</div></div>';
    }
    return results.map((entry, index) => [
      '<article class="str-hit-card">',
      '  <div class="str-hit-head">',
      `    <span class="str-hit-badge">${this._esc(mode)}</span>`,
      `    <span class="str-hit-index">#${index + 1}</span>`,
      '  </div>',
      `  <div class="str-hit-query">${this._esc(query)}</div>`,
      '  <div class="str-hit-actions">',
      `    <button type="button" class="str-btn secondary str-view-svg-btn" data-address="${this._esc(entry.address || entry.page || '')}">View SVG</button>`,
      '  </div>',
      '  <div class="str-hit-grid">',
      `    <div class="str-hit-row"><span>Address</span><strong>${this._esc(entry.address || '—')}</strong></div>`,
      `    <div class="str-hit-row"><span>Page</span><strong>${this._esc(entry.page || '—')}</strong></div>`,
      `    <div class="str-hit-row"><span>Page Offset</span><strong>${this._esc(entry.offsetInPage || '—')}</strong></div>`,
      `    <div class="str-hit-row"><span>Length</span><strong>${this._esc(String(entry.length ?? '—'))}</strong></div>`,
      '  </div>',
      '</article>'
    ].join('')).join('');
  }

  _esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
