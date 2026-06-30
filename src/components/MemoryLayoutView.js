import MemoryPageView from './MemoryPageView.js';
import { getPeSectionPermission, getPeSectionSpan } from '../utils/PeSectionUtils.js';

const USER_LOW = 0x0000000000010000n;
const USER_HIGH = 0x00007FFFFFFFFFFFn;
const PAGE_SIZE = 0x1000n;

const TYPE_COLORS = {
  module: '#3db8b0',
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

const PERM_COLORS = {
  r: '#5b8db8',
  rw: '#6aab73',
  rwx: '#d4a03c',
  rx: '#e9a853',
  x: '#c060a0',
  rwxc: '#c04545',
};

const PERM_LABELS = {
  r: 'R',
  rw: 'RW',
  rwx: 'RWX',
  rx: 'RX',
  x: 'X',
  rwxc: 'RWXC',
};

export default class MemoryLayoutView {
  constructor(container) {
    this._container = container;
    this._data = null;
    this._active = false;
    this._regions = [];
    this._col2Items = [];
    this._col2SelectedIndex = -1;
    this._col3Items = [];
    this._col3SelectedIndex = -1;
    this._pagesPerCell = 1;
    this._selectedPageAddress = null;
    this._targetModuleBase = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._pageRequestToken = 0;
    this._col5GridEl = null;
    this._col5PageTitleEl = null;
    this._col5PageTitleLabelEl = null;
    this._col5PageStatusEl = null;
    this._col5PageBodyEl = null;
    this._col5PageView = null;
    this._moduleSectionCache = null;
    this._sectionLoadToken = 0;
    this._scrollCapture = null;
    this._scrollRestoreRaf = null;
    this._scrollToCol3Id = null;

    this._buildShell();
  }

  onRefresh = null;
  onRequestPageContent = null;
  onViewPageSvg = null;
  onViewInPe = null;
  onViewInMemAccess = null;
  onFetchModuleSections = null;

  setActive(active) {
    this._active = active;
  }

  focusModule(baseAddress) {
    this._targetModuleBase = baseAddress;
    if (this._col2Items.length > 0) {
      const addr = typeof baseAddress === 'bigint' ? baseAddress : BigInt(baseAddress);
      const idx = this._col2Items.findIndex(r => r.base === addr && r.type === 'module');
      if (idx >= 0) {
        this._col2Select(idx, { triggerSectionLoad: true });
        requestAnimationFrame(() => {
          const list = this._container.querySelector('.mly-modstack-list');
          const sel = list?.querySelector('.selected');
          if (sel) sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
    }
  }

  setLoading(loading) {
    if (this._loadingEl) {
      this._loadingEl.style.display = loading ? 'inline-flex' : 'none';
    }
  }

  setError(message) {
    this._renderPlaceholder('\u2715', message || 'Unable to load memory layout.');
  }

  setDisconnected() {
    this._data = null;
    this._regions = [];
    this._col2Items = [];
    this._col2SelectedIndex = -1;
    this._col3Items = [];
    this._col3SelectedIndex = -1;
    this._selectedPageAddress = null;
    this._pageContent = null;
    this._pageLoading = false;
    this._pageError = '';
    this._moduleSectionCache = null;
    this._sectionLoadToken = 0;
    this._scrollCapture = null;
    this._renderPlaceholder('\u25CE', 'Not connected to a debug session.');
  }

  setData(data) {
    this._data = data;
    this._regions = this._buildUnifiedRegions(data);

    if (!data?.available || this._regions.length === 0) {
      this._col2SelectedIndex = -1;
      this._col3Items = [];
      this._col3SelectedIndex = -1;
      this._renderPlaceholder('\u25CC', 'No memory regions available.');
      return;
    }

    this._col2Items = this._regions;

    const previousId = this._regions[this._col2SelectedIndex]?.id;
    this._col2SelectedIndex = this._col2Items.findIndex((r) => r.id === previousId);
    if (this._col2SelectedIndex < 0) {
      this._col2SelectedIndex = 0;
    }

    this._col2Select(this._col2SelectedIndex, { triggerSectionLoad: true });

    if (this._targetModuleBase != null) {
      const addr = typeof this._targetModuleBase === 'bigint' ? this._targetModuleBase : BigInt(this._targetModuleBase);
      const idx = this._col2Items.findIndex(r => r.base === addr && r.type === 'module');
      if (idx >= 0) {
        this._col2SelectedIndex = idx;
        this._col2Select(idx, { triggerSectionLoad: true });
        requestAnimationFrame(() => {
          const list = this._container.querySelector('.mly-modstack-list');
          const sel = list?.querySelector('.selected');
          if (sel) sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      }
      this._targetModuleBase = null;
    }
  }

  _buildShell() {
    this._container.classList.add('mly-root');

    const toolbar = document.createElement('div');
    toolbar.className = 'mly-toolbar';
    toolbar.innerHTML = [
      '<div class="mly-toolbar-title">Memory Layout</div>',
      '<div class="mly-toolbar-subtitle">Proportional → Enlarged → Modules &amp; Stacks → Sections → Page Maps &amp; Content</div>',
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
    const col2Item = this._col2SelectedItem();
    if (!col2Item) {
      this._renderPlaceholder('\u25CC', 'No item selected.');
      return;
    }

    const savedScroll = this._captureScrollPositions();

    this._body.replaceChildren();

    const layout = document.createElement('div');
    layout.className = 'mly-layout';

    const col1 = document.createElement('section');
    col1.className = 'mly-col mly-col-prop';

    const col2 = document.createElement('section');
    col2.className = 'mly-col mly-col-enlarged';

    const col3 = document.createElement('section');
    col3.className = 'mly-col mly-col-midlist';

    const merged = document.createElement('section');
    merged.className = 'mly-col mly-col-merged';

    this._renderCol1Proportional(col1, col2Item);
    this._renderCol2Enlarged(col2, col2Item);
    this._renderCol3ModuleStackList(col3, col2Item);
    this._renderMergedRight(merged, col2Item);

    layout.appendChild(col1);
    layout.appendChild(col2);
    layout.appendChild(col3);
    layout.appendChild(merged);

    this._body.appendChild(layout);

    this._restoreScrollPositions(savedScroll);
  }

  _renderCol1Proportional(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      '<div class="mly-col-title">Proportional</div>',
      `<div class="mly-col-meta">${this._regions.length} regions</div>`
    ].join('');
    target.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'mly-overview-wrap mly-prop-wrap';

    const axis = document.createElement('div');
    axis.className = 'mly-overview-axis mly-prop-axis';
    axis.innerHTML = [
      `<div class="mly-axis-label top">${this._addrStr(USER_LOW)}</div>`,
      '<div class="mly-axis-track"></div>',
      `<div class="mly-axis-label bottom">${this._addrStr(USER_HIGH)}</div>`
    ].join('');

    const ribbon = document.createElement('div');
    ribbon.className = 'mly-overview-ribbon';

    const total = USER_HIGH - USER_LOW + 1n;
    for (let i = 0; i < this._regions.length; i += 1) {
      const region = this._regions[i];
      const start = this._clamp(region.base, USER_LOW, USER_HIGH);
      const end = this._clamp(region.end, USER_LOW, USER_HIGH);
      if (end < start) continue;

      const topPct = Number(((start - USER_LOW) * 1000000n) / total) / 10000;
      const heightPctRaw = Number(((end - start + 1n) * 1000000n) / total) / 10000;
      const heightPct = Math.max(0.04, heightPctRaw);

      const strip = document.createElement('button');
      strip.className = 'mly-global-strip mly-prop-strip';
      if (selected.id === region.id) strip.classList.add('selected');
      strip.style.top = `${Math.min(99.96, topPct)}%`;
      strip.style.height = `${Math.min(100 - topPct, heightPct)}%`;
      strip.style.background = this._regionColor(region.type);
      strip.title = `${this._regionLabel(region.type)}: ${region.label}`;
      strip.addEventListener('click', () => {
        const idx = this._col2Items.findIndex((r) => r.id === region.id);
        if (idx >= 0) {
          this._col2Select(idx, { triggerSectionLoad: true, centerCol3: true });
        }
      });
      ribbon.appendChild(strip);
    }

    wrap.appendChild(axis);
    wrap.appendChild(ribbon);
    target.appendChild(wrap);
  }

  _renderCol2Enlarged(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      '<div class="mly-col-title">Enlarged</div>',
      `<div class="mly-col-meta">${this._regions.length} regions</div>`
    ].join('');
    target.appendChild(header);

    const shell = document.createElement('div');
    shell.className = 'mly-enlarged-shell';

    const modules = this._regions.filter((r) => r.type === 'module');
    const others = this._regions.filter((r) => r.type !== 'module');

    const othersRibbon = this._buildEnlargedRibbon(others, selected, 'Stacks & Others');
    othersRibbon.style.flex = `${others.length} ${others.length} 0`;
    shell.appendChild(othersRibbon);

    const modsRibbon = this._buildEnlargedRibbon(modules, selected, 'Modules');
    modsRibbon.style.flex = `${modules.length} ${modules.length} 0`;
    shell.appendChild(modsRibbon);

    target.appendChild(shell);

    const legend = document.createElement('div');
    legend.className = 'mly-type-legend';

    const counts = this._countByType();
    for (const type of ['module', 'stack', 'heap', 'teb', 'peb']) {
      if (!counts[type]) continue;
      const item = document.createElement('div');
      item.className = 'mly-legend-item';
      item.innerHTML = [
        `<span class="mly-legend-swatch" style="background:${this._regionColor(type)}"></span>`,
        `<span class="mly-legend-text">${this._regionLabel(type)} (${counts[type]})</span>`
      ].join('');
      legend.appendChild(item);
    }

    target.appendChild(legend);
  }

  _buildEnlargedRibbon(regions, selected, label) {
    const GAP_THRESHOLD = 0x40000000n;
    const BREAK_UNIT = 0.35;
    const GAP_UNIT = 0.15;
    const REGION_MIN = 0.25;

    const group = document.createElement('div');
    group.className = 'mly-enlarged-group';

    const groupLabel = document.createElement('div');
    groupLabel.className = 'mly-enlarged-group-label';
    groupLabel.textContent = `${label} (${regions.length})`;
    group.appendChild(groupLabel);

    const wrap = document.createElement('div');
    wrap.className = 'mly-enlarged-group-body';

    if (regions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mly-enlarged-empty';
      empty.textContent = '—';
      wrap.appendChild(empty);
      group.appendChild(wrap);
      return group;
    }

    const axis = document.createElement('div');
    axis.className = 'mly-overview-axis mly-enlarged-axis';
    const firstAddr = regions[0].base;
    const lastAddr = regions[regions.length - 1].end;
    axis.innerHTML = [
      `<div class="mly-axis-label top">${this._addrStr(firstAddr)}</div>`,
      '<div class="mly-axis-track"></div>',
      `<div class="mly-axis-label bottom">${this._addrStr(lastAddr)}</div>`
    ].join('');

    const ribbon = document.createElement('div');
    ribbon.className = 'mly-overview-ribbon';

    const slots = [];
    for (let i = 0; i < regions.length; i += 1) {
      const region = regions[i];
      const start = this._clamp(region.base, USER_LOW, USER_HIGH);
      const end = this._clamp(region.end, USER_LOW, USER_HIGH);
      if (end < start) continue;

      const prevEnd = i > 0 ? this._clamp(regions[i - 1].end, USER_LOW, USER_HIGH) : start;
      const gap = start > prevEnd ? start - prevEnd : 0n;
      const isBigGap = gap > GAP_THRESHOLD;

      if (isBigGap && slots.length > 0) {
        slots.push({ kind: 'break', addr: prevEnd, gapEnd: start });
      } else if (gap > 0n && !isBigGap && slots.length > 0) {
        slots.push({ kind: 'gap' });
      }

      const heightPctRaw = Number(((end - start + 1n) * 1000000n) / (USER_HIGH - USER_LOW + 1n)) / 10000;
      const height = Math.max(REGION_MIN, heightPctRaw);
      slots.push({ kind: 'region', region, height });
    }

    let totalUnits = 0;
    for (const s of slots) {
      if (s.kind === 'region') totalUnits += s.height;
      else if (s.kind === 'break') totalUnits += BREAK_UNIT;
      else if (s.kind === 'gap') totalUnits += GAP_UNIT;
    }

    let y = 0;
    for (const slot of slots) {
      const unitH = slot.kind === 'region' ? slot.height
        : slot.kind === 'break' ? BREAK_UNIT
        : GAP_UNIT;

      const topPct = totalUnits > 0 ? (y / totalUnits) * 100 : 0;
      const hPct = totalUnits > 0 ? (unitH / totalUnits) * 100 : 0;

      if (slot.kind === 'region') {
        const region = slot.region;
        const strip = document.createElement('button');
        strip.className = 'mly-global-strip';
        if (selected.id === region.id) strip.classList.add('selected');
        strip.style.top = `${topPct}%`;
        strip.style.height = `${hPct}%`;
        strip.style.background = this._regionColor(region.type);
        strip.title = `${this._regionLabel(region.type)}: ${region.label}\n${this._addrStr(region.base)} – ${this._addrStr(region.end)}`;
        strip.addEventListener('click', () => {
          const idx = this._col2Items.findIndex((r) => r.id === region.id);
          if (idx >= 0) {
            this._col2Select(idx, { triggerSectionLoad: true, centerCol3: true });
          }
        });
        ribbon.appendChild(strip);
      } else if (slot.kind === 'break') {
        const br = document.createElement('div');
        br.className = 'mly-global-break';
        br.style.top = `${topPct}%`;
        br.style.height = `${hPct}%`;
        br.title = `${this._addrStr(slot.addr)} … ${this._addrStr(slot.gapEnd)}`;
        ribbon.appendChild(br);
      }

      y += unitH;
    }

    wrap.appendChild(axis);
    wrap.appendChild(ribbon);
    group.appendChild(wrap);
    return group;
  }

  _renderCol3ModuleStackList(target, selected) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      '<div class="mly-col-title">Modules &amp; Stacks</div>',
      `<div class="mly-col-meta">${this._col2Items.length} regions</div>`
    ].join('');
    target.appendChild(header);

    const list = document.createElement('div');
    list.className = 'mly-modstack-list';

    if (this._col2Items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mly-type-empty';
      empty.textContent = 'No regions.';
      list.appendChild(empty);
    } else {
      for (let i = 0; i < this._col2Items.length; i += 1) {
        const region = this._col2Items[i];

        const item = document.createElement('button');
        item.className = 'mly-modstack-item';
        if (selected.id === region.id) item.classList.add('selected');
        item.style.borderLeftColor = this._regionColor(region.type);

        const badge = document.createElement('span');
        badge.className = 'mly-modstack-badge';
        badge.style.background = this._regionColor(region.type);
        badge.textContent = this._regionLabel(region.type);

        const info = document.createElement('span');
        info.className = 'mly-modstack-info';

        const name = document.createElement('span');
        name.className = 'mly-modstack-name';
        name.textContent = region.label;

        const addr = document.createElement('span');
        addr.className = 'mly-modstack-addr';
        addr.textContent = `${this._addrStr(region.base)} – ${this._addrStr(region.end)}`;

        info.appendChild(name);
        info.appendChild(addr);

        item.appendChild(badge);
        item.appendChild(info);

        if (region.type === 'module' && this.onViewInPe) {
          this._appendViewInPePill(item, region);
        }
        this._appendMemAccessPill(item, region);

        item.addEventListener('click', () => {
          this._col2Select(i, { triggerSectionLoad: true });
        });

        list.appendChild(item);
      }
    }

    target.appendChild(list);
  }

  _renderMergedRight(merged, col2Item) {
    const grid = document.createElement('div');
    grid.className = 'mly-merged-grid';

    const sectionsCell = document.createElement('div');
    sectionsCell.className = 'mly-col mly-merged-sect';

    const pagesCell = document.createElement('div');
    pagesCell.className = 'mly-col mly-merged-pages';

    const contentCell = document.createElement('div');
    contentCell.className = 'mly-col mly-merged-content';

    this._renderCol4Sections(sectionsCell, col2Item);
    this._renderCol5Pages(pagesCell);
    this._renderCol6PageContent(contentCell);

    grid.appendChild(sectionsCell);
    grid.appendChild(pagesCell);
    grid.appendChild(contentCell);
    merged.appendChild(grid);
  }

  _renderCol4Sections(target, col2Item) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';
    header.innerHTML = [
      `<div class="mly-col-title">Sections · ${this._esc(col2Item.label)}</div>`,
      `<div class="mly-col-meta">${this._addrStr(col2Item.base)} – ${this._addrStr(col2Item.end)}</div>`
    ].join('');
    target.appendChild(header);

    const body = document.createElement('div');
    body.className = 'mly-sect-body';

    if (this._sectionLoading) {
      this._renderSectionLoading(body);
      target.appendChild(body);
      return;
    }

    if (this._col3Items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mly-sect-empty';
      empty.textContent = col2Item.type === 'module'
        ? 'Loading section data…'
        : `Single region · ${this._fmtKB(col2Item)}`;
      body.appendChild(empty);

      if (col2Item.type !== 'module') {
        const selectBtn = document.createElement('button');
        selectBtn.className = 'mly-sect-item';
        selectBtn.style.borderLeftColor = this._regionColor(col2Item.type);
        selectBtn.innerHTML = [
          `<span class="mly-sect-perm" style="background:${this._regionColor(col2Item.type)}">${this._regionLabel(col2Item.type)}</span>`,
          `<span class="mly-sect-name">${this._esc(col2Item.label)}</span>`,
          `<span class="mly-sect-range">${this._addrStr(col2Item.base)} – ${this._addrStr(col2Item.end)}</span>`
        ].join('');
        selectBtn.addEventListener('click', () => {
          this._col3Select(0);
        });
        body.appendChild(selectBtn);
      }

      target.appendChild(body);
      return;
    }

    for (let i = 0; i < this._col3Items.length; i += 1) {
      const section = this._col3Items[i];
      const perm = section.perm || 'rw';
      const color = PERM_COLORS[perm] || TYPE_COLORS.other;

      const item = document.createElement('button');
      item.className = 'mly-sect-item';
      if (i === this._col3SelectedIndex) item.classList.add('selected');
      item.style.borderLeftColor = color;

      const permBadge = document.createElement('span');
      permBadge.className = 'mly-sect-perm';
      permBadge.style.background = color;
      permBadge.textContent = PERM_LABELS[perm] || perm.toUpperCase();

      const nameEl = document.createElement('span');
      nameEl.className = 'mly-sect-name';
      nameEl.textContent = section.label;

      const rangeEl = document.createElement('span');
      rangeEl.className = 'mly-sect-range';
      rangeEl.textContent = `${this._addrStr(section.base)} – ${this._addrStr(section.end)}`;

      item.appendChild(permBadge);
      item.appendChild(nameEl);
      item.appendChild(rangeEl);

      item.addEventListener('click', () => {
        this._col3Select(i);
      });

      body.appendChild(item);
    }

    target.appendChild(body);
  }

  _renderCol5Pages(target) {
    const header = document.createElement('div');
    header.className = 'mly-col-header';

    const section = this._col3SelectedItem();
    const region = section || this._col2SelectedItem();
    if (!region) {
      header.innerHTML = '<div class="mly-col-title">Page Maps &amp; Content</div>';
      target.appendChild(header);
      return;
    }

    const totalPages = this._regionPageCount(region);
    const cellCount = Math.ceil(totalPages / this._pagesPerCell);

    header.innerHTML = [
      `<div class="mly-col-title">Page Maps · ${this._esc(region.label)}</div>`,
      `<div class="mly-col-meta">${this._fmtNum(totalPages)} pages · ${this._fmtNum(this._pagesPerCell)} ppc · ${this._fmtNum(cellCount)} cells</div>`
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
    mode.textContent = this._pagesPerCell === 1 ? 'Page granularity' : `Grouped (${this._pagesPerCell} ppc)`;

    controls.appendChild(zoomOut);
    controls.appendChild(zoomIn);
    controls.appendChild(mode);
    target.appendChild(controls);

    const grid = document.createElement('div');
    grid.className = 'mly-page-grid';
    this._col5GridEl = grid;

    const maxCells = 3500;
    const renderCells = Math.min(cellCount, maxCells);
    for (let i = 0; i < renderCells; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'mly-page-cell';
      const section = this._col3SelectedItem() || this._col2SelectedItem();
      cell.style.background = section
        ? this._sectionColor(section)
        : this._regionColor(region.type);

      const startPage = i * this._pagesPerCell;
      const endPage = Math.min(totalPages - 1, startPage + this._pagesPerCell - 1);
      const startAddr = region.base + BigInt(startPage) * PAGE_SIZE;
      const endAddr = this._minBig(region.end, startAddr + BigInt(this._pagesPerCell) * PAGE_SIZE - 1n);
      const selectedPageAddr = this._alignPageAddress(this._selectedPageAddress ?? region.base);
      if (selectedPageAddr >= startAddr && selectedPageAddr <= endAddr) {
        cell.classList.add('selected');
      }
      cell.dataset.pageStart = startAddr.toString();
      cell.dataset.pageEnd = endAddr.toString();

      cell.title = [
        `${this._regionLabel(region.type)}: ${region.label}`,
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
        this._updateCol5GridSelection();
        this._loadSelectedPageContent();
      });

      grid.appendChild(cell);
    }

    if (cellCount > maxCells) {
      const note = document.createElement('div');
      note.className = 'mly-grid-note';
      note.textContent = `Showing first ${this._fmtNum(maxCells)} cells. Increase compression to view whole region.`;
      target.appendChild(note);
    }

    target.appendChild(grid);
  }

  _renderCol6PageContent(target) {
    const section = this._col3SelectedItem();
    const region = section || this._col2SelectedItem();

    const panel = document.createElement('div');
    panel.className = 'mly-page-content-panel';

    const title = document.createElement('div');
    title.className = 'mly-page-content-title';
    this._col5PageTitleEl = title;
    const label = document.createElement('span');
    label.className = 'mly-page-content-label';
    this._col5PageTitleLabelEl = label;
    title.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'mly-page-content-actions';

    const viewSvgBtn = document.createElement('button');
    viewSvgBtn.className = 'mly-btn mly-btn-compact';
    viewSvgBtn.textContent = 'View SVG';
    viewSvgBtn.disabled = !this.onViewPageSvg;
    viewSvgBtn.addEventListener('click', () => {
      if (!this.onViewPageSvg) return;
      const addr = this._alignPageAddress(this._selectedPageAddress ?? region?.base ?? 0n);
      this.onViewPageSvg(this._addrStr(addr));
    });
    actions.appendChild(viewSvgBtn);
    title.appendChild(actions);

    const status = document.createElement('span');
    status.className = 'mly-page-content-status';
    this._col5PageStatusEl = status;
    title.appendChild(status);
    panel.appendChild(title);

    const body = document.createElement('div');
    body.className = 'mly-page-content-body';
    this._col5PageBodyEl = body;
    this._col5PageView = new MemoryPageView(body, { autoScrollToRsp: false });

    panel.appendChild(body);
    target.appendChild(panel);

    this._refreshCol5PageContentPanel(region);
  }

  _renderSectionLoading(target) {
    target.innerHTML = [
      '<div class="mly-sect-loading">',
      '<span class="mly-spinner"></span>',
      '<span>Loading sections…</span>',
      '</div>'
    ].join('');
  }

  _renderPlaceholder(icon, text) {
    this._body.replaceChildren();
    const el = document.createElement('div');
    el.className = 'mly-placeholder';
    el.innerHTML = `<div class="mly-placeholder-icon">${this._esc(icon)}</div><div>${this._esc(text)}</div>`;
    this._body.appendChild(el);
  }

  _captureScrollPositions() {
    if (this._scrollCapture) return this._scrollCapture;

    const modstack = this._body.querySelector('.mly-modstack-list');
    const sections = this._body.querySelector('.mly-sect-body');
    this._scrollCapture = {
      modstack: modstack ? modstack.scrollTop : 0,
      sections: sections ? sections.scrollTop : 0,
    };
    return this._scrollCapture;
  }

  _restoreScrollPositions(saved) {
    if (this._scrollRestoreRaf != null) {
      cancelAnimationFrame(this._scrollRestoreRaf);
    }
    const col3Target = this._scrollToCol3Id;

    this._scrollRestoreRaf = requestAnimationFrame(() => {
      this._scrollRestoreRaf = null;
      const modstack = this._body.querySelector('.mly-modstack-list');
      const sections = this._body.querySelector('.mly-sect-body');

      if (col3Target && modstack) {
        const sel = modstack.querySelector('.mly-modstack-item.selected');
        if (sel) {
          sel.scrollIntoView({ block: 'center' });
          this._scrollToCol3Id = null;
          this._scrollCapture = null;
        }
      } else if (modstack) {
        modstack.scrollTop = saved.modstack;
      }

      if (sections) sections.scrollTop = saved.sections;
    });
  }

  _col2Select(index, { triggerSectionLoad = true, centerCol3 = false } = {}) {
    if (index < 0 || index >= this._col2Items.length) return;

    this._col2SelectedIndex = index;
    const item = this._col2Items[index];
    this._selectedPageAddress = this._alignPageAddress(item.base);
    this._pagesPerCell = this._suggestPagesPerCell(item);
    this._pageContent = null;
    this._pageError = '';

    this._scrollCapture = null;
    if (centerCol3) {
      this._scrollToCol3Id = item.id;
    }

    this._render();

    if (triggerSectionLoad) {
      this._loadSectionsForItem(item);
    }
  }

  _col3Select(index) {
    if (index < 0 || index >= this._col3Items.length) return;

    this._scrollCapture = null;
    this._scrollToCol3Id = null;

    this._col3SelectedIndex = index;
    const section = this._col3Items[index];
    this._pagesPerCell = this._suggestPagesPerCell(section);
    this._selectedPageAddress = this._alignPageAddress(section.base);
    this._pageContent = null;
    this._pageError = '';

    this._render();
    this._loadSelectedPageContent();
  }

  async _loadSectionsForItem(item) {
    if (item.type !== 'module') {
      this._col3Items = [{
        id: `sect:${item.id}`,
        label: item.label,
        base: item.base,
        end: item.end,
        perm: item.type,
        parentId: item.id,
      }];
      this._col3SelectedIndex = 0;
      if (this._selectedPageAddress === null) {
        this._selectedPageAddress = this._alignPageAddress(item.base);
      }
      this._render();
      this._loadSelectedPageContent();
      return;
    }

    this._sectionLoading = true;
    this._render();

    const imageBaseStr = '0x' + item.base.toString(16);
    let peData = this._moduleSectionCache?.get(imageBaseStr) ?? null;

    if (!peData && this.onFetchModuleSections) {
      try {
        peData = await this.onFetchModuleSections(imageBaseStr);
      } catch {
        peData = null;
      }
      if (peData?.sections?.length) {
        if (!this._moduleSectionCache) this._moduleSectionCache = new Map();
        this._moduleSectionCache.set(imageBaseStr, peData);
      }
    }

    if (this._col2Items[this._col2SelectedIndex]?.id !== item.id) return;

    this._sectionLoading = false;

    if (peData?.sections?.length) {
      const sections = [];
      for (const s of peData.sections) {
        const span = getPeSectionSpan(s, item.base);
        if (!span) continue;
        const perm = getPeSectionPermission(s.characteristics);

        sections.push({
          id: `sect:${imageBaseStr}:${s.name}`,
          label: `${s.name}`,
          base: span.start,
          end: span.endExclusive - 1n,
          perm,
          parentId: item.id,
        });
      }

      this._col3Items = sections.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    } else {
      this._col3Items = [];
    }

    this._col3SelectedIndex = this._col3Items.length > 0 ? 0 : -1;
    if (this._col3SelectedIndex >= 0) {
      const sel = this._col3Items[0];
      this._selectedPageAddress = this._alignPageAddress(sel.base);
    } else {
      this._selectedPageAddress = this._alignPageAddress(item.base);
    }

    this._render();
    if (this._col3SelectedIndex >= 0) {
      this._loadSelectedPageContent();
    }
  }

  async _loadSelectedPageContent() {
    const section = this._col3SelectedItem();
    const region = section || this._col2SelectedItem();
    if (!region) return;

    const address = this._alignPageAddress(this._selectedPageAddress ?? region.base);
    this._selectedPageAddress = address;

    if (!this.onRequestPageContent) {
      this._pageError = 'Page content callback is not configured.';
      this._pageLoading = false;
      this._refreshCol5PageContentPanel();
      return;
    }

    const token = ++this._pageRequestToken;
    this._pageLoading = true;
    this._pageError = '';
    this._refreshCol5PageContentPanel();

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
        this._refreshCol5PageContentPanel();
      }
    }
  }

  _updateCol5GridSelection() {
    if (!this._col5GridEl) return;
    const selectedPageAddr = this._alignPageAddress(this._selectedPageAddress ?? 0n);
    const cells = this._col5GridEl.querySelectorAll('.mly-page-cell');
    cells.forEach((cell) => {
      const start = this._parseAddr(cell.dataset.pageStart);
      const end = this._parseAddr(cell.dataset.pageEnd);
      const isSelected = start !== null && end !== null && selectedPageAddr >= start && selectedPageAddr <= end;
      cell.classList.toggle('selected', isSelected);
    });
  }

  _refreshCol5PageContentPanel(overrideRegion = null) {
    if (!this._col5PageTitleEl || !this._col5PageBodyEl) return;
    const region = overrideRegion ?? (this._col3SelectedItem() || this._col2SelectedItem());
    if (!region) return;

    const addr = this._alignPageAddress(this._selectedPageAddress ?? region.base);
    if (this._col5PageTitleLabelEl) {
      this._col5PageTitleLabelEl.textContent = `PAGE ${this._addrStr(addr)}`;
    } else {
      this._col5PageTitleEl.textContent = `PAGE ${this._addrStr(addr)}`;
    }

    if (this._col5PageStatusEl) {
      if (this._pageLoading) {
        this._col5PageStatusEl.innerHTML = '<span class="mly-spinner" aria-hidden="true"></span>Loading';
      } else {
        this._col5PageStatusEl.textContent = '';
      }
    }

    if (this._pageLoading && this._pageContent?.available) {
      return;
    }

    if (this._pageError) {
      this._col5PageBodyEl.innerHTML = `<div class="page-empty">${this._esc(this._pageError)}</div>`;
      return;
    }

    if (this._pageContent) {
      this._col5PageView?.setData(this._pageContent);
      return;
    }

    this._col5PageBodyEl.innerHTML = '<div class="page-empty">No page content loaded.</div>';
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

  _sectionColor(section) {
    if (section?.perm && PERM_COLORS[section.perm]) return PERM_COLORS[section.perm];
    if (section?.type && TYPE_COLORS[section.type]) return TYPE_COLORS[section.type];
    return TYPE_COLORS.other;
  }

  _regionColor(type) {
    if (TYPE_COLORS[type]) return TYPE_COLORS[type];
    return TYPE_COLORS.other;
  }

  _regionLabel(type) {
    return TYPE_LABELS[type] || type;
  }

  _col2SelectedItem() {
    if (this._col2SelectedIndex < 0 || this._col2SelectedIndex >= this._col2Items.length) return null;
    return this._col2Items[this._col2SelectedIndex];
  }

  _col3SelectedItem() {
    if (this._col3SelectedIndex < 0 || this._col3SelectedIndex >= this._col3Items.length) return null;
    return this._col3Items[this._col3SelectedIndex];
  }

  _alignPageAddress(address) {
    if (typeof address !== 'bigint') return 0n;
    return address & (~(PAGE_SIZE - 1n));
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

  _regionPageCount(region) {
    const bytes = region.end - region.base + 1n;
    const pages = (bytes + PAGE_SIZE - 1n) / PAGE_SIZE;
    return Math.max(1, Number(pages));
  }

  _fmtKB(region) {
    const bytes = region.end - region.base + 1n;
    const kb = Number(bytes) / 1024;
    if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
    return `${kb.toFixed(1)} KB`;
  }

  _appendViewInPePill(container, region) {
    if (!container || region?.type !== 'module' || !this.onViewInPe) return;

    const pill = document.createElement('span');
    pill.className = 'mly-pe-shortcut';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.textContent = 'PE';
    pill.title = `View ${region.label} in PE tab`;

    const invoke = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onViewInPe({
        name: region.label,
        base: this._addrStr(region.base),
      });
    };

    pill.addEventListener('click', invoke);
    pill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        invoke(event);
      }
    });

    container.appendChild(pill);
  }

  _appendMemAccessPill(container, region) {
    if (!container || !region?.base || !this.onViewInMemAccess) return;

    const onePageEnd = region.base + 0x1000n;
    const startStr = this._addrStr(region.base);
    const endStr = this._addrStr(onePageEnd);

    const pill = document.createElement('span');
    pill.className = 'mly-ma-shortcut';
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.textContent = 'MA';
    pill.title = `Query memory access for ${region.label} (1 page: ${startStr}–${endStr}, mode=W)`;

    const invoke = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onViewInMemAccess({
        base: startStr,
        end: endStr,
        label: region.label,
      });
    };

    pill.addEventListener('click', invoke);
    pill.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        invoke(event);
      }
    });

    container.appendChild(pill);
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
