import MemoryPageView from './MemoryPageView.js';

const USER_LOW = 0x0000000000010000n;
const USER_HIGH = 0x00007FFFFFFFFFFFn;
const PAGE_SIZE = 0x1000n;

const TYPE_COLORS = {
  module: '#2a9d8f',
  stack: '#e76f51',
  heap: '#8ab17d',
  teb: '#577590',
  peb: '#bc6c25',
  other: '#6c757d',
};

const TYPE_LABELS = {
  module: 'Module',
  stack: 'Stack',
  heap: 'Heap',
  teb: 'TEB',
  peb: 'PEB',
  other: 'Other',
};

export default class MemoryLayoutView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this._regions = [];
    this._selectedIndex = -1;
    this._pagesPerCell = 1;
    this._focusType = 'module';
    this._selectedPageAddress = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._pageRequestToken = 0;
    this._l3GridEl = null;
    this._l3PageTitleEl = null;
    this._l3PageTitleLabelEl = null;
    this._l3PageStatusEl = null;
    this._l3PageBodyEl = null;
    this._l3PageView = null;

    this._buildShell();
  }

  onRefresh = null;
  onRequestPageContent = null;
  onViewPageSvg = null;
  onViewInPe = null;

  setActive(active) {
    this._active = active;
  }

  setLoading(loading) {
    if (this._loadingEl) {
      this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    }
  }

  setError(message) {
    this._renderPlaceholder('✕', message || 'Unable to load memory layout.');
  }

  setDisconnected() {
    this._data = null;
    this._regions = [];
    this._selectedIndex = -1;
    this._focusType = 'module';
    this._selectedPageAddress = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
  }

  setData(data) {
    this._data = data;
    this._regions = this._buildUnifiedRegions(data);

    if (!data?.available || this._regions.length === 0) {
      this._selectedIndex = -1;
      this._renderPlaceholder('◌', 'No memory regions available.');
      return;
    }

    const previousId = this._regions[this._selectedIndex]?.id;
    this._selectedIndex = this._regions.findIndex((r) => r.id === previousId);
    if (this._selectedIndex < 0) {
      this._selectedIndex = 0;
    }

    this._selectRegion(this._selectedIndex, { reloadPage: true });
  }

  _buildShell() {
    this._container.classList.add('mly-root');

    const toolbar = document.createElement('div');
    toolbar.className = 'mly-toolbar';
    toolbar.innerHTML = [
      '<div class="mly-toolbar-title">Memory Layout</div>',
      '<div class="mly-toolbar-subtitle">Left: whole user VA · Middle: selected region ribbon · Right: page grids</div>',
      '<div class="mly-toolbar-right">',
      '<span class="mly-loading" id="mly-loading" style="display:none"><span class="spinner"></span> Loading...</span>',
      '<button class="mly-btn" id="mly-refresh">↻ Refresh</button>',
      '</div>'
    ].join('');

    this._container.appendChild(toolbar);

    this._loadingEl = toolbar.querySelector('#mly-loading');
    const refreshBtn = toolbar.querySelector('#mly-refresh');
    refreshBtn.addEventListener('click', () => {
      if (this.onRefresh) this.onRefresh();
    });

    this._body = document.createElement('div');
    this._body.className = 'mly-body';
    this._container.appendChild(this._body);
  }

  _render() {
    const selected = this._selectedRegion();
    if (!selected) {
      this._renderPlaceholder('◌', 'No region selected.');
      return;
    }

    this._body.replaceChildren();

    const layout = document.createElement('div');
    layout.className = 'mly-layout';

    const leftCol = document.createElement('section');
    leftCol.className = 'mly-col mly-col-left';

    const middleCol = document.createElement('section');
    middleCol.className = 'mly-col mly-col-middle';

    const middle2Col = document.createElement('section');
    middle2Col.className = 'mly-col mly-col-middle2';

    const rightCol = document.createElement('section');
    rightCol.className = 'mly-col mly-col-right';

    this._renderLeftOverview(leftCol, selected);
    this._renderTypeRibbon(middleCol, selected);
    this._renderMiddleZoom(middle2Col, selected);
    this._renderRightPages(rightCol, selected);

    layout.appendChild(leftCol);
    layout.appendChild(middleCol);
    layout.appendChild(middle2Col);
    layout.appendChild(rightCol);

    this._body.appendChild(layout);
  }

  _renderLeftOverview(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      '<div class="mly-col-title">L0 · Whole User VA (Uniform Scale)</div>',
      `<div class="mly-col-meta">${this._regions.length} typed regions · real gaps preserved · low address at top</div>`
    ].join('');
    target.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'mly-overview-wrap';

    const axis = document.createElement('div');
    axis.className = 'mly-overview-axis';
    axis.innerHTML = [
      `<div class="mly-axis-label top">${this._addrStr(USER_LOW)}</div>`,
      '<div class="mly-axis-track"></div>',
      `<div class="mly-axis-label bottom">${this._addrStr(USER_HIGH)}</div>`
    ].join('');

    const ribbon = document.createElement('div');
    ribbon.className = 'mly-overview-ribbon';

    // True VA-uniform scale (empty gaps keep original size).
    const total = USER_HIGH - USER_LOW + 1n;
    for (let i = 0; i < this._regions.length; i += 1) {
      const region = this._regions[i];
      const start = this._clamp(region.base, USER_LOW, USER_HIGH);
      const end = this._clamp(region.end, USER_LOW, USER_HIGH);
      if (end < start) continue;

      const topPct = Number(((start - USER_LOW) * 1000000n) / total) / 10000;
      const heightPctRaw = Number(((end - start + 1n) * 1000000n) / total) / 10000;
      const heightPct = Math.max(0.12, heightPctRaw);

      const strip = document.createElement('button');
      strip.className = 'mly-global-strip';
      if (selected.id === region.id) strip.classList.add('selected');
      strip.style.top = `${Math.min(99.7, topPct)}%`;
      strip.style.height = `${Math.min(100 - topPct, heightPct)}%`;
      strip.style.background = TYPE_COLORS[region.type] || TYPE_COLORS.other;
      strip.title = `${TYPE_LABELS[region.type] || region.type}: ${region.label}\n${this._addrStr(region.base)} - ${this._addrStr(region.end)}`;
      strip.addEventListener('click', () => {
        this._selectRegion(i, { reloadPage: true });
      });
      ribbon.appendChild(strip);
    }

    const legend = document.createElement('div');
    legend.className = 'mly-type-legend';

    const counts = this._countByType();
    for (const type of ['module', 'stack', 'heap', 'teb', 'peb']) {
      if (!counts[type]) continue;
      const item = document.createElement('div');
      item.className = 'mly-legend-item';
      item.innerHTML = [
        `<span class="mly-legend-swatch" style="background:${TYPE_COLORS[type]}"></span>`,
        `<span class="mly-legend-text">${TYPE_LABELS[type]} (${counts[type]})</span>`
      ].join('');
      legend.appendChild(item);
    }

    wrap.appendChild(axis);
    wrap.appendChild(ribbon);
    target.appendChild(wrap);
    target.appendChild(legend);
  }

  _renderTypeRibbon(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      '<div class="mly-col-title">L1 · Type Ribbon (Uniform Zoom, No Gaps)</div>',
      `<div class="mly-col-meta">Focus type: ${this._esc(TYPE_LABELS[this._focusType] || this._focusType)}</div>`
    ].join('');
    target.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'mly-type-wrap';

    const typeBar = document.createElement('div');
    typeBar.className = 'mly-type-tabs';
    const availableTypes = this._orderedTypes();
    for (const type of availableTypes) {
      const btn = document.createElement('button');
      btn.className = 'mly-type-tab';
      if (type === this._focusType) btn.classList.add('active');
      btn.textContent = `${TYPE_LABELS[type] || type}`;
      btn.style.borderLeftColor = TYPE_COLORS[type] || TYPE_COLORS.other;
      btn.addEventListener('click', () => {
        this._focusType = type;
        const firstIdx = this._regions.findIndex((r) => r.type === type);
        if (firstIdx >= 0) {
          this._selectRegion(firstIdx, { reloadPage: false, renderNow: false });
        }
        this._render();
        if (firstIdx >= 0) {
          this._loadSelectedPageContent();
        }
      });
      typeBar.appendChild(btn);
    }

    const ribbon = document.createElement('div');
    ribbon.className = 'mly-type-ribbon';

    const typeRegions = this._regions.filter((r) => r.type === this._focusType);
    if (typeRegions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mly-type-empty';
      empty.textContent = 'No regions for this type.';
      ribbon.appendChild(empty);
    } else {
      const uniformHeight = Math.max(10, 100 / typeRegions.length);
      for (const region of typeRegions) {
        const idx = this._regions.findIndex((r) => r.id === region.id);
        if (idx < 0) continue;

        const strip = document.createElement('button');
        strip.className = 'mly-type-strip';
        if (selected.id === region.id) strip.classList.add('selected');
        strip.style.height = `${uniformHeight}%`;
        strip.style.background = TYPE_COLORS[region.type] || TYPE_COLORS.other;
        strip.title = `${region.label}\n${this._addrStr(region.base)} - ${this._addrStr(region.end)}`;
        strip.innerHTML = [
          `<span class="mly-type-strip-name">${this._esc(region.label)}</span>`,
          `<span class="mly-type-strip-addr">${this._addrStr(region.base)}</span>`
        ].join('');
        this._appendViewInPeShortcut(strip, region);
        strip.addEventListener('click', () => {
          this._selectRegion(idx, { reloadPage: true });
        });
        ribbon.appendChild(strip);
      }
    }

    wrap.appendChild(typeBar);
    wrap.appendChild(ribbon);
    target.appendChild(wrap);
  }

  _renderMiddleZoom(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      `<div class="mly-col-title">L2 · Region Zoom Ribbon · ${this._esc(TYPE_LABELS[selected.type] || selected.type)}</div>`,
      `<div class="mly-col-meta">${this._esc(selected.label)} · ${this._addrStr(selected.base)} - ${this._addrStr(selected.end)}</div>`
    ].join('');
    target.appendChild(header);

    const zoom = document.createElement('div');
    zoom.className = 'mly-zoom-wrap';

    const ribbon = document.createElement('div');
    ribbon.className = 'mly-zoom-ribbon';

    const topCap = document.createElement('div');
    topCap.className = 'mly-zoom-cap';
    topCap.textContent = this._addrStr(selected.base);

    const body = document.createElement('div');
    body.className = 'mly-zoom-body';

    const totalPages = this._regionPageCount(selected);
    const renderBands = this._makeBands(totalPages, 120);

    for (const band of renderBands) {
      const el = document.createElement('div');
      el.className = 'mly-zoom-band';
      el.style.height = `${Math.max(3, band.heightPct)}%`;
      el.style.background = TYPE_COLORS[selected.type] || TYPE_COLORS.other;
      el.style.opacity = band.emphasis;
      el.title = `Pages ${band.startPage}..${band.endPage}`;
      body.appendChild(el);
    }

    const bottomCap = document.createElement('div');
    bottomCap.className = 'mly-zoom-cap';
    bottomCap.textContent = this._addrStr(selected.end);

    ribbon.appendChild(topCap);
    ribbon.appendChild(body);
    ribbon.appendChild(bottomCap);

    const quick = document.createElement('div');
    quick.className = 'mly-quick-pick';
    quick.innerHTML = '<div class="mly-quick-title">Visible Regions</div>';

    const near = this._nearbyRegions(selected, 14);
    for (const region of near) {
      const btn = document.createElement('button');
      btn.className = 'mly-quick-item';
      btn.style.borderLeftColor = TYPE_COLORS[region.type] || TYPE_COLORS.other;
      if (region.id === selected.id) btn.classList.add('active');
      btn.innerHTML = [
        `<span class="mly-quick-name">${this._esc(region.label)}</span>`,
        `<span class="mly-quick-addr">${this._addrStr(region.base)}</span>`
      ].join('');
      this._appendViewInPeShortcut(btn, region);
      btn.addEventListener('click', () => {
        const idx = this._regions.findIndex((r) => r.id === region.id);
        if (idx >= 0) {
          this._selectRegion(idx, { reloadPage: true });
        }
      });
      quick.appendChild(btn);
    }

    zoom.appendChild(ribbon);
    target.appendChild(zoom);
    target.appendChild(quick);
  }

  _renderRightPages(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';

    const totalPages = this._regionPageCount(selected);
    const cellCount = Math.ceil(totalPages / this._pagesPerCell);

    header.innerHTML = [
      `<div class="mly-col-title">L3 · Page Grids · ${this._fmtNum(totalPages)} pages</div>`,
      `<div class="mly-col-meta">${this._fmtNum(this._pagesPerCell)} page(s) per cell · ${this._fmtNum(cellCount)} cells</div>`
    ].join('');
    target.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'mly-grid-controls';

    const zoomOut = document.createElement('button');
    zoomOut.className = 'mly-btn';
    zoomOut.textContent = 'More Detail';
    zoomOut.disabled = this._pagesPerCell <= 1;
    zoomOut.addEventListener('click', () => {
      this._pagesPerCell = Math.max(1, Math.floor(this._pagesPerCell / 4));
      this._render();
    });

    const zoomIn = document.createElement('button');
    zoomIn.className = 'mly-btn';
    zoomIn.textContent = 'More Compression';
    zoomIn.disabled = cellCount <= 512;
    zoomIn.addEventListener('click', () => {
      this._pagesPerCell = this._pagesPerCell * 4;
      this._render();
    });

    const mode = document.createElement('span');
    mode.className = 'mly-grid-mode';
    mode.textContent = this._pagesPerCell === 1 ? 'Page granularity' : `Grouped granularity (${this._pagesPerCell} pages/cell)`;

    controls.appendChild(zoomOut);
    controls.appendChild(zoomIn);
    controls.appendChild(mode);
    target.appendChild(controls);

    const l3Wrap = document.createElement('div');
    l3Wrap.className = 'mly-l3-content-wrap';

    const grid = document.createElement('div');
    grid.className = 'mly-page-grid';
    this._l3GridEl = grid;

    const maxCells = 3500;
    const renderCells = Math.min(cellCount, maxCells);
    for (let i = 0; i < renderCells; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'mly-page-cell';
      cell.style.background = TYPE_COLORS[selected.type] || TYPE_COLORS.other;

      const startPage = i * this._pagesPerCell;
      const endPage = Math.min(totalPages - 1, startPage + this._pagesPerCell - 1);
      const startAddr = selected.base + BigInt(startPage) * PAGE_SIZE;
      const endAddr = this._minBig(selected.end, startAddr + BigInt(this._pagesPerCell) * PAGE_SIZE - 1n);
      const selectedPageAddr = this._alignPageAddress(this._selectedPageAddress ?? selected.base);
      if (selectedPageAddr >= startAddr && selectedPageAddr <= endAddr) {
        cell.classList.add('selected');
      }
      cell.dataset.pageStart = startAddr.toString();
      cell.dataset.pageEnd = endAddr.toString();

      cell.title = [
        `${TYPE_LABELS[selected.type] || selected.type}: ${selected.label}`,
        `Pages: ${this._fmtNum(startPage)} - ${this._fmtNum(endPage)}`,
        `Addr: ${this._addrStr(startAddr)} - ${this._addrStr(endAddr)}`
      ].join('\n');

      const text = document.createElement('span');
      text.className = 'mly-page-cell-label';
      if (this._pagesPerCell === 1) {
        text.textContent = this._fmtNum(startPage);
      } else {
        text.textContent = `${this._fmtNum(startPage)}-${this._fmtNum(endPage)}`;
      }
      cell.appendChild(text);
      cell.addEventListener('click', () => {
        this._selectedPageAddress = this._alignPageAddress(startAddr);
        this._updateL3GridSelection();
        this._loadSelectedPageContent();
      });

      grid.appendChild(cell);
    }

    if (cellCount > maxCells) {
      const note = document.createElement('div');
      note.className = 'mly-grid-note';
      note.textContent = `Showing first ${this._fmtNum(maxCells)} cells. Increase compression to view whole region in one screen.`;
      target.appendChild(note);
    }

    l3Wrap.appendChild(grid);
    l3Wrap.appendChild(this._renderPageContentPanel(selected));
    target.appendChild(l3Wrap);
  }

  _renderPageContentPanel(selected) {
    const panel = document.createElement('div');
    panel.className = 'mly-page-content-panel';

    const title = document.createElement('div');
    title.className = 'mly-page-content-title';
    this._l3PageTitleEl = title;
    const label = document.createElement('span');
    label.className = 'mly-page-content-label';
    this._l3PageTitleLabelEl = label;
    title.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'mly-page-content-actions';

    const viewSvgBtn = document.createElement('button');
    viewSvgBtn.className = 'mly-btn mly-btn-compact';
    viewSvgBtn.textContent = 'View SVG';
    viewSvgBtn.disabled = !this.onViewPageSvg;
    viewSvgBtn.addEventListener('click', () => {
      if (!this.onViewPageSvg) return;
      const selectedAddr = this._alignPageAddress(this._selectedPageAddress ?? selected.base);
      this.onViewPageSvg(this._addrStr(selectedAddr));
    });
    actions.appendChild(viewSvgBtn);
    title.appendChild(actions);

    const status = document.createElement('span');
    status.className = 'mly-page-content-status';
    this._l3PageStatusEl = status;
    title.appendChild(status);
    panel.appendChild(title);

    const body = document.createElement('div');
    body.className = 'mly-page-content-body';
    this._l3PageBodyEl = body;
    this._l3PageView = new MemoryPageView(body, { autoScrollToRsp: false });

    panel.appendChild(body);
    this._refreshL3PageContentPanel(selected);
    return panel;
  }

  _updateL3GridSelection() {
    if (!this._l3GridEl) return;
    const selectedPageAddr = this._alignPageAddress(this._selectedPageAddress ?? 0n);
    const cells = this._l3GridEl.querySelectorAll('.mly-page-cell');
    cells.forEach((cell) => {
      const start = this._parseAddr(cell.dataset.pageStart);
      const end = this._parseAddr(cell.dataset.pageEnd);
      const isSelected = start !== null && end !== null && selectedPageAddr >= start && selectedPageAddr <= end;
      cell.classList.toggle('selected', isSelected);
    });
  }

  _refreshL3PageContentPanel(selectedOverride = null) {
    if (!this._l3PageTitleEl || !this._l3PageBodyEl) return;
    const selected = selectedOverride ?? this._selectedRegion();
    if (!selected) return;

    const addr = this._selectedPageAddress ?? this._alignPageAddress(selected.base);
    if (this._l3PageTitleLabelEl) {
      this._l3PageTitleLabelEl.textContent = `PAGE ${this._addrStr(this._alignPageAddress(addr))}`;
    } else {
      this._l3PageTitleEl.textContent = `PAGE ${this._addrStr(this._alignPageAddress(addr))}`;
    }

    if (this._l3PageStatusEl) {
      if (this._pageLoading) {
        this._l3PageStatusEl.innerHTML = '<span class="mly-spinner" aria-hidden="true"></span>Loading';
      } else {
        this._l3PageStatusEl.textContent = '';
      }
    }

    // Keep previously rendered rows visible while loading new page data to avoid
    // a placeholder-to-table DOM swap that looks like a layout stretch.
    if (this._pageLoading && this._pageContent?.available) {
      return;
    }

    if (this._pageError) {
      this._l3PageBodyEl.innerHTML = `<div class="page-empty">${this._esc(this._pageError)}</div>`;
      return;
    }

    if (this._pageContent) {
      this._l3PageView?.setData(this._pageContent);
      return;
    }

    this._l3PageBodyEl.innerHTML = '<div class="page-empty">No page content loaded.</div>';
  }

  _buildUnifiedRegions(data) {
    const list = [];

    for (const m of data?.modules || []) {
      const base = this._parseAddr(m.base);
      const end = this._parseAddr(m.end);
      if (!this._validRange(base, end)) continue;
      list.push({
        id: `module:${m.base}:${m.name || ''}`,
        type: 'module',
        label: m.name || '(module)',
        base,
        end,
      });
    }

    for (const t of data?.threads || []) {
      const stackBase = this._parseAddr(t.stackBase || t.base);
      const stackLimit = this._parseAddr(t.stackLimit || t.end);
      if (stackBase !== null && stackLimit !== null) {
        const base = this._minBig(stackBase, stackLimit);
        const end = this._maxBig(stackBase, stackLimit);
        if (this._validRange(base, end)) {
          list.push({
            id: `stack:${t.threadId}:${t.stackBase || ''}:${t.stackLimit || ''}`,
            type: 'stack',
            label: `TID ${t.threadId} Stack`,
            base,
            end,
          });
        }
      }

      const teb = this._parseAddr(t.tebAddress);
      if (teb !== null) {
        list.push({
          id: `teb:${t.threadId}:${t.tebAddress}`,
          type: 'teb',
          label: `TID ${t.threadId} TEB`,
          base: teb,
          end: teb + PAGE_SIZE - 1n,
        });
      }
    }

    for (const h of data?.heaps || []) {
      const base = this._parseAddr(h.base);
      const end = this._parseAddr(h.end);
      if (!this._validRange(base, end)) continue;
      list.push({
        id: `heap:${h.base}`,
        type: 'heap',
        label: `Heap ${h.base}`,
        base,
        end,
      });
    }

    const peb = this._parseAddr(data?.pebAddress);
    if (peb !== null) {
      list.push({
        id: `peb:${data.pebAddress}`,
        type: 'peb',
        label: 'PEB',
        base: peb,
        end: peb + PAGE_SIZE - 1n,
      });
    }

    return list
      .filter((r) => r.end >= USER_LOW && r.base <= USER_HIGH)
      .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  }

  _orderedTypes() {
    const present = new Set(this._regions.map((r) => r.type));
    const preferred = ['module', 'stack', 'heap', 'teb', 'peb', 'other'];
    return preferred.filter((t) => present.has(t));
  }

  _suggestPagesPerCell(region) {
    if (!region) return 1;
    const pages = this._regionPageCount(region);
    let ppc = 1;
    while (Math.ceil(pages / ppc) > 1800) {
      ppc *= 4;
    }
    return ppc;
  }

  _selectRegion(index, { reloadPage = true, renderNow = true } = {}) {
    if (index < 0 || index >= this._regions.length) return;

    this._selectedIndex = index;
    const region = this._regions[index];
    this._focusType = region.type;
    this._pagesPerCell = this._suggestPagesPerCell(region);
    this._selectedPageAddress = this._alignPageAddress(region.base);
    this._pageContent = null;
    this._pageError = '';

    if (renderNow) {
      this._render();
    }

    if (reloadPage) {
      this._loadSelectedPageContent();
    }
  }

  async _loadSelectedPageContent() {
    const selected = this._selectedRegion();
    if (!selected) return;

    const address = this._alignPageAddress(this._selectedPageAddress ?? selected.base);
    this._selectedPageAddress = address;

    if (!this.onRequestPageContent) {
      this._pageError = 'Page content callback is not configured.';
      this._pageLoading = false;
      this._refreshL3PageContentPanel();
      return;
    }

    const token = ++this._pageRequestToken;
    this._pageLoading = true;
    this._pageError = '';
    this._refreshL3PageContentPanel();

    try {
      const data = await this.onRequestPageContent(this._addrStr(address));
      if (token !== this._pageRequestToken) return;

      const returnedPage = this._parseAddr(data?.pageAddr);
      const requestedPage = this._alignPageAddress(address);
      if (returnedPage === null || this._alignPageAddress(returnedPage) !== requestedPage) {
        this._pageContent = null;
        this._pageError = `Mismatched page content (requested ${this._addrStr(requestedPage)}, got ${this._addrStr(returnedPage ?? 0n)}).`;
        return;
      }

      this._pageContent = data;
      if (!data?.available) {
        this._pageError = 'Page content unavailable for selected page.';
      }
    } catch (err) {
      if (token !== this._pageRequestToken) return;
      this._pageContent = null;
      this._pageError = `Failed to load page content: ${err.message}`;
    } finally {
      if (token === this._pageRequestToken) {
        this._pageLoading = false;
        this._refreshL3PageContentPanel();
      }
    }
  }

  _alignPageAddress(address) {
    if (typeof address !== 'bigint') return 0n;
    return address & (~(PAGE_SIZE - 1n));
  }

  _makeBands(totalPages, maxBands) {
    const bands = [];
    if (totalPages <= 0) return [{ startPage: 0, endPage: 0, heightPct: 100, emphasis: 0.75 }];

    const pagesPerBand = Math.max(1, Math.ceil(totalPages / maxBands));
    const totalBands = Math.ceil(totalPages / pagesPerBand);

    for (let i = 0; i < totalBands; i += 1) {
      const startPage = i * pagesPerBand;
      const endPage = Math.min(totalPages - 1, startPage + pagesPerBand - 1);
      const coveredPages = endPage - startPage + 1;
      const heightPct = (coveredPages / totalPages) * 100;
      bands.push({
        startPage,
        endPage,
        heightPct,
        emphasis: 0.45 + ((i % 3) * 0.15),
      });
    }

    return bands;
  }

  _nearbyRegions(selected, maxCount) {
    if (!selected) return [];
    const idx = this._regions.findIndex((r) => r.id === selected.id);
    if (idx < 0) return this._regions.slice(0, maxCount);

    const half = Math.floor(maxCount / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(this._regions.length, start + maxCount);
    return this._regions.slice(start, end);
  }

  _countByType() {
    const counts = { module: 0, stack: 0, heap: 0, teb: 0, peb: 0, other: 0 };
    for (const r of this._regions) {
      if (counts[r.type] === undefined) {
        counts.other += 1;
      } else {
        counts[r.type] += 1;
      }
    }
    return counts;
  }

  _renderPlaceholder(icon, text) {
    this._body.replaceChildren();
    const el = document.createElement('div');
    el.className = 'mly-placeholder';
    el.innerHTML = `<div class="mly-placeholder-icon">${this._esc(icon)}</div><div>${this._esc(text)}</div>`;
    this._body.appendChild(el);
  }

  _selectedRegion() {
    if (this._selectedIndex < 0 || this._selectedIndex >= this._regions.length) return null;
    return this._regions[this._selectedIndex];
  }

  _regionPageCount(region) {
    const bytes = region.end - region.base + 1n;
    const pages = (bytes + PAGE_SIZE - 1n) / PAGE_SIZE;
    return Math.max(1, Number(pages));
  }

  _appendViewInPeShortcut(container, region) {
    if (!container || region?.type !== 'module' || !this.onViewInPe) return;

    const shortcut = document.createElement('span');
    shortcut.className = 'mly-pe-shortcut';
    shortcut.setAttribute('role', 'button');
    shortcut.setAttribute('tabindex', '0');
    shortcut.textContent = 'View in PE';
    shortcut.title = `View ${region.label} in PE tab`;

    const invoke = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onViewInPe({
        name: region.label,
        base: this._addrStr(region.base),
      });
    };

    shortcut.addEventListener('click', invoke);
    shortcut.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        invoke(event);
      }
    });

    container.appendChild(shortcut);
  }

  _parseAddr(value) {
    if (value === null || value === undefined || value === '') return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  _validRange(base, end) {
    return base !== null && end !== null && end >= base;
  }

  _fmtNum(value) {
    return new Intl.NumberFormat('en-US').format(value);
  }

  _addrStr(value) {
    if (typeof value !== 'bigint') return '—';
    return `0x${value.toString(16).padStart(16, '0')}`;
  }

  _esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _clamp(v, lo, hi) {
    return this._maxBig(lo, this._minBig(v, hi));
  }

  _minBig(a, b) {
    return a < b ? a : b;
  }

  _maxBig(a, b) {
    return a > b ? a : b;
  }
}
