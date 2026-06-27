import MemoryPageView from './MemoryPageView.js';

const STRUCTURE_ORDER = ['PEB', 'LDR', 'ProcessParameters', 'TEB'];
const PAGE_SIZE = 0x1000n;

export default class EnvironmentView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this._pebPageAddress = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._pageRequestToken = 0;
    this._pebPageTitleEl = null;
    this._pebPageStatusEl = null;
    this._pebPageBodyEl = null;
    this._pebPageView = null;
    this._buildShell();
  }

  onRefresh = null;
  onRequestPageContent = null;

  setActive(active) {
    this._active = active;
  }

  setLoading(loading) {
    if (this._loadingEl) {
      this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    }
  }

  setError(message) {
    this._renderPlaceholder('✕', message || 'Unable to load environment data.');
  }

  setDisconnected() {
    this._data = null;
    this._pebPageAddress = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
  }

  setData(data) {
    this._data = data;
    if (!data?.available) {
      this._renderPlaceholder('◌', 'Environment data is unavailable.');
      return;
    }

    const pebAddr = this._parseAddr(data?.process?.pebAddress);
    const nextPage = pebAddr !== null ? this._alignPageAddress(pebAddr) : null;
    if (nextPage !== this._pebPageAddress) {
      this._pebPageAddress = nextPage;
      this._pageContent = null;
      this._pageError = '';
    }

    this._render();
    this._loadPebPageContent();
  }

  _buildShell() {
    this._container.classList.add('env-root');

    const toolbar = document.createElement('div');
    toolbar.className = 'env-toolbar';
    toolbar.innerHTML = [
      '<div class="env-toolbar-title">Environment</div>',
      '<div class="env-toolbar-subtitle">PEB, TEB, loader data, and the three PEB_LDR_DATA doubly linked module lists</div>',
      '<div class="env-toolbar-right">',
      '<span class="env-loading" id="env-loading" style="display:none"><span class="spinner"></span> Loading...</span>',
      '<button class="env-btn" id="env-refresh">↻ Refresh</button>',
      '</div>'
    ].join('');

    this._container.appendChild(toolbar);
    this._loadingEl = toolbar.querySelector('#env-loading');
    toolbar.querySelector('#env-refresh')?.addEventListener('click', () => {
      if (this.onRefresh) this.onRefresh();
    });

    this._body = document.createElement('div');
    this._body.className = 'env-body';
    this._container.appendChild(this._body);
  }

  _render() {
    this._body.replaceChildren();

    const data = this._data ?? {};
    const layout = document.createElement('div');
    layout.className = 'env-layout';

    const summary = document.createElement('section');
    summary.className = 'env-panel env-summary-panel';
    summary.appendChild(this._renderSummary(data));

    const threads = document.createElement('section');
    threads.className = 'env-panel env-threads-panel';
    threads.appendChild(this._renderThreads(data.threads || []));

    const ldr = document.createElement('section');
    ldr.className = 'env-panel env-ldr-panel';
    ldr.appendChild(this._renderLdrLists(data));

    layout.append(summary, threads, ldr);
    this._body.appendChild(layout);
  }

  _renderSummary(data) {
    const wrap = document.createElement('div');
    wrap.className = 'env-summary-wrap';

    const header = document.createElement('div');
    header.className = 'env-section-header';
    header.innerHTML = [
      '<div class="env-section-title">Process Environment</div>',
      `<div class="env-section-meta">Source: Process.Environment.EnvironmentBlock${data.isTTD ? ' · TTD session' : ''}</div>`
    ].join('');
    wrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'env-summary-grid';

    const structures = Array.isArray(data.structures) ? [...data.structures] : [];
    structures.sort((lhs, rhs) => {
      const left = STRUCTURE_ORDER.indexOf(lhs.type);
      const right = STRUCTURE_ORDER.indexOf(rhs.type);
      return (left === -1 ? 999 : left) - (right === -1 ? 999 : right);
    });

    const process = data.process || {};
    if (!structures.some((entry) => entry.type === 'PEB') && process.pebAddress) {
      structures.unshift({ type: 'PEB', address: process.pebAddress, source: 'process.environment.environmentblock' });
    }

    for (const structure of structures) {
      const card = document.createElement('div');
      card.className = 'env-card';

      const title = document.createElement('div');
      title.className = 'env-card-title';
      title.textContent = structure.type || 'Structure';

      const addr = document.createElement('div');
      addr.className = 'env-card-address';
      addr.textContent = structure.address || '—';

      const meta = document.createElement('div');
      meta.className = 'env-card-meta';
      meta.textContent = structure.threadId != null
        ? `TID ${structure.threadId} · ${structure.source || 'model'}`
        : (structure.source || 'model');

      card.append(title, addr, meta);
      grid.appendChild(card);
    }

    const details = document.createElement('div');
    details.className = 'env-process-kv';
    const kvRows = [
      ['Image Base', process.imageBaseAddress],
      ['Process Parameters', process.processParametersAddress],
      ['Loader Data', process.ldrAddress],
      ['Environment Block', process.environmentBlockAddress],
    ];
    for (const [label, value] of kvRows) {
      const row = document.createElement('div');
      row.className = 'env-kv-row';
      row.innerHTML = `<span class="env-kv-key">${this._esc(label)}</span><span class="env-kv-value">${this._esc(value || '—')}</span>`;
      details.appendChild(row);
    }

    const pebFields = this._renderFieldBlock('PEB Fields', data.pebFields || []);
    const ldrFields = this._renderFieldBlock('LDR Fields', data.ldrFields || []);
    const paramsFields = this._renderFieldBlock('ProcessParameters Fields', data.processParametersFields || []);

    const pebPage = this._renderPebPageSection();
    wrap.append(grid, details, pebFields, ldrFields, paramsFields, pebPage);
    return wrap;
  }

  _renderPebPageSection() {
    const block = document.createElement('div');
    block.className = 'env-peb-page-panel';

    const title = document.createElement('div');
    title.className = 'env-peb-page-title';
    this._pebPageTitleEl = title;

    const status = document.createElement('span');
    status.className = 'env-peb-page-status';
    this._pebPageStatusEl = status;
    title.appendChild(status);

    block.appendChild(title);

    const body = document.createElement('div');
    body.className = 'env-peb-page-body';
    this._pebPageBodyEl = body;
    this._pebPageView = new MemoryPageView(body, { autoScrollToRsp: false });
    block.appendChild(body);

    this._refreshPebPagePanel();
    return block;
  }

  _renderThreads(threads) {
    const wrap = document.createElement('div');
    wrap.className = 'env-threads-wrap';

    const header = document.createElement('div');
    header.className = 'env-section-header';
    header.innerHTML = [
      '<div class="env-section-title">Thread Environment Blocks</div>',
      `<div class="env-section-meta">${threads.length} thread(s)</div>`
    ].join('');
    wrap.appendChild(header);

    const table = document.createElement('div');
    table.className = 'env-thread-table';

    const head = document.createElement('div');
    head.className = 'env-thread-row env-thread-head';
    head.innerHTML = [
      '<span>TID</span>',
      '<span>TEB</span>',
      '<span>Stack Base</span>',
      '<span>Stack Limit</span>'
    ].join('');
    table.appendChild(head);

    if (!threads.length) {
      const empty = document.createElement('div');
      empty.className = 'env-empty';
      empty.textContent = 'No thread environment blocks available.';
      wrap.appendChild(empty);
      return wrap;
    }

    for (const thread of threads) {
      const row = document.createElement('div');
      row.className = 'env-thread-row';
      row.innerHTML = [
        `<span>${this._esc(thread.threadId ?? '—')}</span>`,
        `<span>${this._esc(thread.tebAddress || thread.environmentBlockAddress || '—')}</span>`,
        `<span>${this._esc(thread.stackBase || '—')}</span>`,
        `<span>${this._esc(thread.stackLimit || '—')}</span>`
      ].join('');
      table.appendChild(row);
    }

    const detailWrap = document.createElement('div');
    detailWrap.className = 'env-thread-details';
    for (const thread of threads) {
      const section = document.createElement('div');
      section.className = 'env-thread-detail';
      const title = document.createElement('div');
      title.className = 'env-thread-detail-title';
      title.textContent = `TID ${thread.threadId ?? '—'} details`;
      section.appendChild(title);
      section.appendChild(this._renderFieldBlock('Environment Fields', thread.environmentFields || [], true));
      section.appendChild(this._renderFieldBlock('TEB Fields', thread.tebFields || [], true));
      detailWrap.appendChild(section);
    }

    wrap.append(table, detailWrap);
    return wrap;
  }

  _renderLdrLists(data) {
    const wrap = document.createElement('div');
    wrap.className = 'env-ldr-wrap';

    const header = document.createElement('div');
    header.className = 'env-section-header';
    header.innerHTML = [
      '<div class="env-section-title">PEB_LDR_DATA Module Lists</div>',
      '<div class="env-section-meta">Visualized as ordered doubly linked lists</div>'
    ].join('');
    wrap.appendChild(header);

    const lists = document.createElement('div');
    lists.className = 'env-ldr-grid';

    const listSpecs = [
      ['inLoadOrder', 'InLoadOrderModuleList'],
      ['inMemoryOrder', 'InMemoryOrderModuleList'],
      ['inInitializationOrder', 'InInitializationOrderModuleList'],
    ];

    for (const [key, label] of listSpecs) {
      const column = document.createElement('div');
      column.className = 'env-ldr-column';

      const items = data?.ldrLists?.[key] || [];
      const columnHead = document.createElement('div');
      columnHead.className = 'env-ldr-column-head';
      const source = items[0]?.source ? ` · ${items[0].source}` : '';
      columnHead.innerHTML = `<div class="env-ldr-column-title">${this._esc(label)}</div><div class="env-ldr-column-meta">${items.length} module(s)${this._esc(source)}</div>`;
      column.appendChild(columnHead);

      const chain = document.createElement('div');
      chain.className = 'env-ldr-chain';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'env-empty';
        empty.textContent = 'List unavailable.';
        chain.appendChild(empty);
      } else {
        items.forEach((item, index) => {
          const node = document.createElement('div');
          node.className = 'env-ldr-node';
          node.innerHTML = [
            `<div class="env-ldr-node-title">${this._esc(item.name || '(module)')}</div>`,
            `<div class="env-ldr-node-address">${this._esc(item.base || '—')}</div>`,
            `<div class="env-ldr-node-meta">prev: ${this._esc(item.prevName || 'HEAD')} · next: ${this._esc(item.nextName || 'TAIL')}</div>`
          ].join('');
          chain.appendChild(node);

          if (index + 1 < items.length) {
            const link = document.createElement('div');
            link.className = 'env-ldr-link';
            link.textContent = '⇅';
            chain.appendChild(link);
          }
        });
      }

      column.appendChild(chain);
      lists.appendChild(column);
    }

    wrap.appendChild(lists);

    if (Array.isArray(data.notes) && data.notes.length) {
      const notes = document.createElement('div');
      notes.className = 'env-notes';
      for (const note of data.notes) {
        const line = document.createElement('div');
        line.className = 'env-note';
        line.textContent = note;
        notes.appendChild(line);
      }
      wrap.appendChild(notes);
    }

    return wrap;
  }

  _renderFieldBlock(title, fields, compact = false) {
    const wrap = document.createElement('div');
    wrap.className = compact ? 'env-field-block env-field-block-compact' : 'env-field-block';

    const head = document.createElement('div');
    head.className = 'env-field-block-title';
    head.textContent = `${title} (${fields.length})`;
    wrap.appendChild(head);

    if (!Array.isArray(fields) || fields.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'env-empty';
      empty.textContent = 'No fields available.';
      wrap.appendChild(empty);
      return wrap;
    }

    const table = document.createElement('div');
    table.className = 'env-field-table';

    const rowHead = document.createElement('div');
    rowHead.className = 'env-field-row env-field-head';
    rowHead.innerHTML = '<span>Name</span><span>Value</span><span>Type</span>';
    table.appendChild(rowHead);

    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'env-field-row';
      row.innerHTML = [
        `<span class="env-field-name">${this._esc(field.name || '')}</span>`,
        `<span class="env-field-value">${this._esc(field.value || '')}</span>`,
        `<span class="env-field-type">${this._esc(field.valueType || field.kind || '')}</span>`
      ].join('');
      table.appendChild(row);
    }

    wrap.appendChild(table);
    return wrap;
  }

  _refreshPebPagePanel() {
    if (!this._pebPageTitleEl || !this._pebPageBodyEl) return;

    const addr = this._pebPageAddress;
    this._pebPageTitleEl.firstChild
      ? (this._pebPageTitleEl.firstChild.textContent = '')
      : null;
    this._pebPageTitleEl.textContent = `PEB PAGE ${addr !== null ? this._addrStr(addr) : '—'}`;

    if (this._pebPageStatusEl) {
      if (this._pageLoading) {
        this._pebPageStatusEl.innerHTML = '<span class="env-mini-spinner" aria-hidden="true"></span>Loading';
      } else {
        this._pebPageStatusEl.textContent = '';
      }
      this._pebPageTitleEl.appendChild(this._pebPageStatusEl);
    }

    if (this._pageLoading && this._pageContent?.available) {
      return;
    }

    if (this._pageError) {
      this._pebPageBodyEl.innerHTML = `<div class="page-empty">${this._esc(this._pageError)}</div>`;
      return;
    }

    if (this._pageContent) {
      this._pebPageView?.setData(this._pageContent);
      return;
    }

    this._pebPageBodyEl.innerHTML = '<div class="page-empty">No PEB page content loaded.</div>';
  }

  async _loadPebPageContent() {
    if (this._pebPageAddress === null) {
      this._pageContent = null;
      this._pageError = 'PEB address is unavailable.';
      this._pageLoading = false;
      this._refreshPebPagePanel();
      return;
    }

    if (!this.onRequestPageContent) {
      this._pageContent = null;
      this._pageError = 'Page content callback is not configured.';
      this._pageLoading = false;
      this._refreshPebPagePanel();
      return;
    }

    const address = this._alignPageAddress(this._pebPageAddress);
    const token = ++this._pageRequestToken;
    this._pageLoading = true;
    this._pageError = '';
    this._refreshPebPagePanel();

    try {
      const data = await this.onRequestPageContent(this._addrStr(address));
      if (token !== this._pageRequestToken) return;

      const returnedPage = this._parseAddr(data?.pageAddr);
      if (returnedPage === null || this._alignPageAddress(returnedPage) !== address) {
        this._pageContent = null;
        this._pageError = `Mismatched page content (requested ${this._addrStr(address)}, got ${this._addrStr(returnedPage ?? 0n)}).`;
        return;
      }

      this._pageContent = data;
      if (!data?.available) {
        this._pageError = 'PEB page content unavailable.';
      }
    } catch (err) {
      if (token !== this._pageRequestToken) return;
      this._pageContent = null;
      this._pageError = `Failed to load PEB page content: ${err.message}`;
    } finally {
      if (token === this._pageRequestToken) {
        this._pageLoading = false;
        this._refreshPebPagePanel();
      }
    }
  }

  _alignPageAddress(address) {
    if (typeof address !== 'bigint') return 0n;
    return address & (~(PAGE_SIZE - 1n));
  }

  _addrStr(value) {
    if (typeof value !== 'bigint') return '—';
    return `0x${value.toString(16).padStart(16, '0')}`;
  }

  _parseAddr(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  _renderPlaceholder(icon, text) {
    this._body.replaceChildren();
    const el = document.createElement('div');
    el.className = 'env-placeholder';
    el.innerHTML = `<div class="env-placeholder-icon">${this._esc(icon)}</div><div>${this._esc(text)}</div>`;
    this._body.appendChild(el);
  }

  _esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}