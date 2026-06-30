/**
 * PositionView — Inspect a specific TTD position.
 * Shows callstack, registers, and stack memory at a pinned position.
 * Opened by clicking a row in Mem Access.
 */

import MemoryPageSvgView from './MemoryPageSvgView.js';

const THREAD_COLORS = [
  '#ff6b6b', '#ffa94d', '#a8e6cf', '#ffd3b6', '#ffaaa5',
  '#ff8b94', '#f8b500', '#00d9ff', '#c1b2f0', '#a4de6c',
];

export default class PositionView {
  constructor(container) {
    this._container = container;
    this._position = null;      // { major, minor, threadId }
    this._traceBounds = null;   // { first: {major,minor}, last: {major,minor} }
    this._threadLifetimes = new Map(); // threadId → { start, end }
    this._threads = [];

    // Callbacks set by App
    this.onFetchCallstack = null;    // async ({ major, minor, threadId }) => frames[]
    this.onFetchRegisters = null;    // async ({ major, minor, threadId }) => registers{}
    this.onFetchPageRender  = null;  // async ({ major, minor, threadId, address }) => pageRenderData

    // Forwarded to embedded MemoryPageSvgView
    Object.defineProperty(this, 'onCheckExecutable', {
      get() { return this._embeddedPageView?.onCheckExecutable; },
      set(v) { if (this._embeddedPageView) this._embeddedPageView.onCheckExecutable = v; }
    });

    this._buildShell();
  }

  setActive(active) {
    this._embeddedPageView?.setActive(active);
    if (active && this._tidSelectEl?.value) {
      if (!this._position) {
        // No position loaded yet — auto-load from current slider position
        this._autoLoadAtSliderPosition();
      } else if (!this._embeddedPageView?._data?.available) {
        // Position exists but the stack page never loaded (RSP missing,
        // previous fetch failed, or embedded view was reset). Re-fetch so
        // the page memory section appears automatically on first tab entry.
        this.load(this._position.major, this._position.minor, this._position.threadId);
      }
      // Ensure content is visible (may have been hidden by placeholder)
      if (this._contentEl && this._contentEl.style.display === 'none' && this._position) {
        this._contentEl.style.display = 'block';
      }
    }
  }
  setDisconnected() {
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
    this._embeddedPageView?.setDisconnected();
  }

  /**
   * Load position data. Called by App when user clicks a mem-access row.
   */
  async load(major, minor, threadId) {
    this._position = { major, minor, threadId };

    // Sync manual controls
    this._syncControls();

    // Show loading state
    this._showLoading();

    // Fetch in parallel
    const [frames, registers] = await Promise.all([
      this._fetchCallstack(),
      this._fetchRegisters(),
    ]);

    this._render({ frames, registers });

    // Defer stack memory fetch (needs RSP from registers)
    if (registers?.rsp) {
      if (this._stackTitleEl) this._stackTitleEl.textContent = 'Stack Memory (RSP)';
      const result = await this._fetchPageRender(registers.rsp);
      const pageData = result?.data;
      const isCode = result?.isCode ?? false;
      this._embeddedPageView.setData(pageData, isCode);
      if (pageData?.available) {
        const kind = isCode ? 'Code' : 'Data';
        const perm = result?.sectionPermission || pageData?.sectionPermission || 'none';
        this._stackMetaEl.textContent = `RSP page · ${kind} · PE perm ${perm}`;
      } else {
        this._stackMetaEl.textContent = 'unavailable';
      }
    }
  }

  _syncControls() {
    if (!this._position) return;
    const { major, minor, threadId } = this._position;
    if (this._majorInputEl) this._majorInputEl.value = BigInt(major).toString(16).toUpperCase();
    if (this._minorInputEl) this._minorInputEl.value = BigInt(minor).toString(16).toUpperCase();
    if (this._tidSelectEl && threadId != null) {
      const has = [...this._tidSelectEl.options].some(o => o.value === String(threadId));
      if (has) this._tidSelectEl.value = String(threadId);
    }
    this._updateLifespan();
  }

  _onThreadChange() {
    this._updateLifespan();
    this._autoLoadAtSliderPosition();
  }

  _autoLoadAtSliderPosition() {
    if (!this._sliderEl || this._sliderEl.disabled) return;
    const tidStr = this._tidSelectEl?.value;
    if (!tidStr) return;
    const major = Number(this._sliderEl.value);
    const threadId = Number(tidStr);
    // Always start at minor 0 — first possible position for the selected thread
    const minor = (this._position?.threadId === threadId) ? Number(this._position.minor ?? 0) : 0;
    this._position = { major, minor, threadId };
    this.load(major, minor, threadId);
  }

  _onSliderInput() {
    if (!this._position) return;
    const tidStr = this._tidSelectEl?.value;
    if (!tidStr) return;
    const major = Number(this._sliderEl.value);
    const minor = Number(this._position.minor ?? 0);
    const threadId = Number(tidStr);
    this._position = { major, minor, threadId };
    if (this._majorInputEl) this._majorInputEl.value = BigInt(major).toString(16).toUpperCase();
    if (this._minorInputEl) this._minorInputEl.value = BigInt(minor).toString(16).toUpperCase();
    this._posInfoEl.textContent = this._formatPosition();
    this.load(major, minor, threadId);
  }

  // -------------------------------------------------------------------
  // Lifespan bar — styled like Home tab thread timeline

  _updateLifespan() {
    if (!this._sliderEl) return;
    const trace = this._traceBounds;
    const fmt = (n) => n.toString(16).toUpperCase();

    if (!trace?.first?.major || !trace?.last?.major) {
      this._sliderEl.setAttribute('min', '0');
      this._sliderEl.setAttribute('max', '0');
      this._sliderEl.value = '0';
      this._sliderEl.disabled = true;
      this._sliderEl.style.left = '0%';
      this._sliderEl.style.width = '100%';
      this._renderLifespanBar(null);
      this._setLifespanLabels('—', '—');
      if (this._lsStartEl) this._lsStartEl.textContent = '—';
      if (this._lsEndEl) this._lsEndEl.textContent = '—';
      return;
    }

    const traceStart = Number(BigInt(trace.first.major));
    const traceEnd = Number(BigInt(trace.last.major));
    const tid = this._tidSelectEl?.value ? Number(this._tidSelectEl.value) : null;
    const lifetime = tid ? this._threadLifetimes?.get(tid) : null;
    const lifeStart = lifetime?.start?.major != null ? Number(BigInt(lifetime.start.major)) : traceStart;
    const lifeEnd = lifetime?.end?.major != null ? Number(BigInt(lifetime.end.major)) : traceEnd;

    const thread = tid ? this._threads.find(t => t.threadId === tid) : null;
    const color = this._getThreadColor(tid);
    const sym = thread?.procSymbol?.name ? thread.procSymbol.name.split('!').pop() : '';

    if (lifeStart >= lifeEnd) {
      this._sliderEl.disabled = true;
      this._sliderEl.style.left = '0%';
      this._sliderEl.style.width = '100%';
      this._renderLifespanBar(null);
      this._setLifespanLabels(`TID ${tid ?? '—'}`, '—');
      return;
    }

    this._sliderEl.disabled = false;
    this._sliderEl.setAttribute('min', String(lifeStart));
    this._sliderEl.setAttribute('max', String(lifeEnd));
    const current = this._position ? Number(BigInt(this._position.major ?? lifeStart)) : lifeStart;
    const clamped = Math.max(lifeStart, Math.min(lifeEnd, current));
    this._sliderEl.value = String(clamped);

    const span = traceEnd - traceStart;
    const barLeftPct = Math.max(0, Math.min(100, ((lifeStart - traceStart) / span) * 100));
    const barWidthPct = Math.max(0.5, Math.min(100 - barLeftPct, ((lifeEnd - lifeStart) / span) * 100));

    this._sliderEl.style.left = `${barLeftPct}%`;
    this._sliderEl.style.width = `${barWidthPct}%`;

    this._renderLifespanBar({ barLeftPct, barWidthPct, color });

    const tidLabel = sym ? `TID ${tid} — ${sym}` : `TID ${tid ?? '—'}`;
    this._setLifespanLabels(tidLabel,
      `0x${fmt(lifeStart)} → 0x${fmt(lifeEnd)}`);
    if (this._lsTidEl) this._lsTidEl.style.color = color;
    if (this._lsStartEl) this._lsStartEl.textContent = `0x${fmt(traceStart)}`;
    if (this._lsEndEl) this._lsEndEl.textContent = `0x${fmt(traceEnd)}`;
  }

  _setLifespanLabels(tidText, rangeText) {
    if (this._lsTidEl) this._lsTidEl.textContent = tidText;
    if (this._lsRangeEl) this._lsRangeEl.textContent = rangeText;
  }

  _getThreadColor(tid) {
    if (tid == null) return THREAD_COLORS[0];
    const idx = this._threads.findIndex(t => t.threadId === tid);
    return THREAD_COLORS[idx >= 0 ? idx % THREAD_COLORS.length : 0];
  }

  _renderLifespanBar(opts) {
    if (!this._lsBarEl) return;
    if (!opts) {
      this._lsBarEl.style.display = 'none';
      return;
    }
    this._lsBarEl.style.display = '';
    this._lsBarEl.style.left = `${opts.barLeftPct}%`;
    this._lsBarEl.style.width = `${opts.barWidthPct}%`;
    this._lsBarEl.style.background = opts.color;
  }

  // -------------------------------------------------------------------
  // Shell

  _buildShell() {
    this._container.classList.add('pv-root');
    this._container.innerHTML = [
      '<div class="pv-toolbar">',
      '  <div class="pv-toolbar-title">Position Inspector</div>',
      '  <div class="pv-toolbar-subtitle" id="pv-pos-info">No position loaded</div>',
      '  <div class="pv-toolbar-controls">',
      '    <label class="pv-control-label">Major</label>',
      '    <input id="pv-major-input" class="pv-control-input" type="text" placeholder="0" spellcheck="false" autocomplete="off">',
      '    <label class="pv-control-label">Minor</label>',
      '    <input id="pv-minor-input" class="pv-control-input" type="text" placeholder="0" spellcheck="false" autocomplete="off">',
      '    <label class="pv-control-label">Thread</label>',
      '    <select id="pv-tid-select" class="pv-control-input"></select>',
      '  </div>',
      '</div>',
      '<div class="pv-lifespan">',
      '  <span id="pv-ls-tid" class="pv-lifespan-tid">—</span>',
      '  <div class="pv-lifespan-track">',
      '    <span id="pv-ls-start" class="pv-lifespan-bound pv-lifespan-bound--l">—</span>',
      '    <div id="pv-ls-bar" class="pv-lifespan-bar"></div>',
      '    <input id="pv-slider" class="pv-lifespan-slider" type="range" min="0" max="0" value="0" step="1">',
      '    <span id="pv-ls-end" class="pv-lifespan-bound pv-lifespan-bound--r">—</span>',
      '  </div>',
      '  <span id="pv-ls-range" class="pv-lifespan-range">—</span>',
      '</div>',
      '<div class="pv-body">',
      '  <div id="pv-loading" class="pv-loading" style="display:none">',
      '    <div class="pv-loading-spin"></div>',
      '    <span>Loading position data…</span>',
      '  </div>',
      '  <div id="pv-content" style="display:none">',
      '    <div class="pv-grid">',
      '      <section class="pv-section">',
      '        <div class="pv-section-head">',
      '          <div class="pv-section-title">Callstack</div>',
      '          <div id="pv-cs-meta" class="pv-section-meta"></div>',
      '        </div>',
      '        <div id="pv-callstack" class="pv-callstack"></div>',
      '      </section>',
      '      <section class="pv-section">',
      '        <div class="pv-section-head">',
      '          <div class="pv-section-title">Registers</div>',
      '          <div id="pv-regs-meta" class="pv-section-meta"></div>',
      '        </div>',
      '        <div id="pv-registers" class="pv-registers"></div>',
      '      </section>',
      '    </div>',
      '    <section class="pv-section">',
      '      <div class="pv-section-head">',
      '        <div class="pv-section-title" id="pv-stack-title">Stack Memory (RSP)</div>',
      '        <div id="pv-stack-meta" class="pv-section-meta"></div>',
      '      </div>',
      '      <div id="pv-stack-svg" class="pv-stack-svg"></div>',
      '    </section>',
      '  </div>',
      '<div>',
      '</div>',
    ].join('');

    this._posInfoEl = this._container.querySelector('#pv-pos-info');
    this._loadingEl = this._container.querySelector('#pv-loading');
    this._contentEl = this._container.querySelector('#pv-content');
    this._csMetaEl = this._container.querySelector('#pv-cs-meta');
    this._callstackEl = this._container.querySelector('#pv-callstack');
    this._regsMetaEl = this._container.querySelector('#pv-regs-meta');
    this._registersEl = this._container.querySelector('#pv-registers');
    this._stackMetaEl = this._container.querySelector('#pv-stack-meta');
    this._stackTitleEl = this._container.querySelector('#pv-stack-title');
    this._stackSvgEl = this._container.querySelector('#pv-stack-svg');
    this._majorInputEl = this._container.querySelector('#pv-major-input');
    this._minorInputEl = this._container.querySelector('#pv-minor-input');
    this._tidSelectEl = this._container.querySelector('#pv-tid-select');
    this._sliderEl = this._container.querySelector('#pv-slider');
    this._lsBarEl = this._container.querySelector('#pv-ls-bar');
    this._lsTidEl = this._container.querySelector('#pv-ls-tid');
    this._lsRangeEl = this._container.querySelector('#pv-ls-range');
    this._lsStartEl = this._container.querySelector('#pv-ls-start');
    this._lsEndEl = this._container.querySelector('#pv-ls-end');

    this._embeddedPageView = new MemoryPageSvgView(this._stackSvgEl);
    this._embeddedPageView.onNavigate = (address) => this._navigateEmbeddedPage(address);

    this._majorInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitManual(); });
    this._minorInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitManual(); });
    this._tidSelectEl.addEventListener('change', () => this._onThreadChange());
    this._sliderEl.addEventListener('change', () => this._onSliderInput());
    this._registersEl.addEventListener('click', (e) => this._onRegisterClick(e));
    this._callstackEl.addEventListener('click', (e) => this._onCallstackClick(e));
  }

  setThreads(threads) {
    if (!this._tidSelectEl) return;
    this._threads = threads ?? [];
    const prev = this._tidSelectEl.value;
    this._tidSelectEl.innerHTML = '<option value="">— select thread —</option>' +
      (this._threads).map(t => {
        const id = t.threadId;
        const sym = t.procSymbol?.name ? t.procSymbol.name.split('!').pop() : '';
        const label = sym ? `TID ${id} — ${sym}` : `TID ${id}`;
        return `<option value="${id}">${label}</option>`;
      }).join('');
    let threadChanged = false;
    if (prev && [...this._tidSelectEl.options].some(o => o.value === prev)) {
      this._tidSelectEl.value = prev;
    } else if (this._tidSelectEl.options.length > 1) {
      this._tidSelectEl.selectedIndex = 1;
      threadChanged = true;
    }
    this._updateLifespan();
    if (threadChanged) this._autoLoadAtSliderPosition();
  }

  setTraceBounds(bounds) {
    this._traceBounds = bounds ?? null;
    this._updateLifespan();
    if (!this._position && bounds?.first) {
      if (this._majorInputEl) this._majorInputEl.value = BigInt(bounds.first.major).toString(16).toUpperCase();
      if (this._minorInputEl) this._minorInputEl.value = BigInt(bounds.first.minor ?? 0).toString(16).toUpperCase();
    }
    if (!this._position && this._tidSelectEl?.value) this._autoLoadAtSliderPosition();
  }

  setThreadLifetimes(map) {
    this._threadLifetimes = map ?? new Map();
    this._updateLifespan();
    if (this._tidSelectEl?.value) this._autoLoadAtSliderPosition();
  }

  _submitManual() {
    const majRaw = (this._majorInputEl?.value || '').trim().replace(/^0x/i, '');
    const minRaw = (this._minorInputEl?.value || '').trim().replace(/^0x/i, '');
    const tidStr = this._tidSelectEl?.value;
    if (!majRaw || !tidStr) return;
    if (!/^[0-9a-fA-F]+$/.test(majRaw)) return;
    if (minRaw && !/^[0-9a-fA-F]+$/.test(minRaw)) return;
    const threadId = Number(tidStr);
    this.load(majRaw, minRaw ? parseInt(minRaw, 16) : 0, threadId);
  }

  _showLoading() {
    this._posInfoEl.textContent = this._formatPosition();
    this._loadingEl.style.display = 'flex';
    this._contentEl.style.display = 'none';
  }

  _render({ frames, registers }) {
    this._loadingEl.style.display = 'none';
    this._contentEl.style.display = 'block';
    this._posInfoEl.textContent = this._formatPosition();

    this._renderCallstack(frames);
    this._renderRegisters(registers);
  }

  _formatPosition() {
    const p = this._position;
    if (!p) return 'No position';
    const maj = BigInt(p.major).toString(16).toUpperCase();
    const min = BigInt(p.minor).toString(16).toUpperCase();
    return `${maj}:${min} · TID ${p.threadId}`;
  }

  // --- Callstack ---

  _renderCallstack(frames) {
    if (!frames || frames.length === 0) {
      this._csMetaEl.textContent = '0 frames';
      this._callstackEl.innerHTML = '<div class="pv-empty">No callstack data</div>';
      return;
    }
    this._csMetaEl.textContent = `${frames.length} frame${frames.length !== 1 ? 's' : ''}`;
    this._callstackEl.innerHTML = frames.map(f => {
      const num  = String(f.frameNumber ?? '').padStart(2, '0');
      const addr = f.instructionOffset
        ? BigInt(f.instructionOffset).toString(16).toUpperCase()
        : '?';
      const sym  = this._esc(f.function || '');
      const disp = (f.displacement && f.displacement !== 0)
        ? `+${BigInt(f.displacement || 0).toString(16)}`
        : '';
      return `<div class="pv-frame">
        <span class="pv-frame-num">#${num}</span>
        <span class="pv-frame-addr pv-clickable" data-addr="${addr}">${addr}</span>
        <span class="pv-frame-sym">${sym}</span>
        ${disp ? `<span class="pv-frame-disp">${disp}</span>` : ''}
      </div>`;
    }).join('');
  }

  // --- Registers ---

  _renderRegisters(registers) {
    const regs = registers || {};
    const names = ['rax','rbx','rcx','rdx','rsi','rdi','rbp','rsp','rip','r8','r9','r10','r11','r12','r13','r14','r15'];
    const values = names.map(n => regs[n]);
    const filled = values.filter(v => v != null).length;
    this._regsMetaEl.textContent = `${filled}/${names.length}`;

    this._registersEl.innerHTML = names.map(n => {
      const v = regs[n];
      const hasVal = v != null;
      const hex = hasVal ? BigInt(v).toString(16).toUpperCase() : '—';
      const cls = hasVal ? 'pv-reg-val pv-reg-val-clickable' : 'pv-reg-val';
      const addr = hasVal ? ` data-addr="0x${hex}"` : '';
      return `<div class="pv-reg-row">
        <span class="pv-reg-name">${n}</span>
        <span class="${cls}" data-reg="${n}"${addr}>${hex}</span>
      </div>`;
    }).join('');
  }

  _onRegisterClick(e) {
    const valEl = e.target.closest('.pv-reg-val-clickable');
    if (!valEl) return;
    const addr = valEl.dataset.addr;
    const reg = valEl.dataset.reg;
    if (!addr || !reg) return;
    if (!/^0x[0-9A-F]+$/.test(addr)) return;

    const regUpper = reg.toUpperCase();
    this._stackTitleEl.textContent = `Stack Memory (${regUpper})`;
    this._stackMetaEl.textContent = 'loading...';
    this._navigateEmbeddedPage(addr).then((result) => {
      const pageData = result?.data;
      const kind = result?.isCode ? 'Code' : 'Data';
      const perm = result?.sectionPermission || pageData?.sectionPermission || 'none';
      this._stackMetaEl.textContent = pageData?.available
        ? `${regUpper} page · ${kind} · PE perm ${perm}`
        : 'unavailable';
      if (pageData?.available) {
        const mpInfoEl = this._container.querySelector('#mp-page-info');
        if (mpInfoEl) mpInfoEl.textContent = `${regUpper}: ${addr}`;
      }
    });
  }

  _onCallstackClick(e) {
    const addrEl = e.target.closest('.pv-frame-addr');
    if (!addrEl) return;
    const raw = addrEl.textContent.trim();
    if (!raw || raw === '?') return;
    const addr = '0x' + raw;
    if (!/^0x[0-9A-F]+$/.test(addr)) return;

    const funcName = addrEl.parentElement?.querySelector('.pv-frame-sym')?.textContent || 'function';
    this._stackTitleEl.textContent = `Stack Memory (${funcName})`;
    this._stackMetaEl.textContent = 'loading...';
    this._navigateEmbeddedPage(addr).then((result) => {
      const pageData = result?.data;
      if (pageData?.available) {
        const kind = result?.isCode ? 'Code' : 'Data';
        const perm = result?.sectionPermission || pageData?.sectionPermission || 'none';
        this._stackMetaEl.textContent = `page · ${kind} · PE perm ${perm}`;
      } else {
        this._stackMetaEl.textContent = pageData?.error || 'unavailable';
      }
    });
  }

  // --- Stack memory ---

  async _navigateEmbeddedPage(address) {
    if (!this._position) return { data: { available: false }, isCode: false, sectionPermission: 'none' };
    const result = await this._fetchPageRender(address);
    this._embeddedPageView.setData(result.data, result.isCode);
    return result;
  }

  // --- Fetch helpers ---

  async _fetchCallstack() {
    try {
      const frames = await this.onFetchCallstack?.(this._position);
      return frames ?? [];
    } catch (e) {
      console.error('[PV] callstack fetch failed:', e);
      return [];
    }
  }

  async _fetchRegisters() {
    try {
      const regs = await this.onFetchRegisters?.(this._position);
      return regs ?? {};
    } catch (e) {
      console.error('[PV] registers fetch failed:', e);
      return {};
    }
  }

  async _fetchPageRender(address) {
    try {
      const { major, minor, threadId } = this._position;
      const result = await this.onFetchPageRender?.({ major, minor, threadId, address });
      return result ?? { data: { available: false }, isCode: false, sectionPermission: 'none' };
    } catch (e) {
      console.error('[PV] page render fetch failed:', e);
      return { data: { available: false, error: e.message }, isCode: false, sectionPermission: 'none' };
    }
  }

  _renderPlaceholder(icon, text) {
    if (this._posInfoEl) this._posInfoEl.textContent = 'No position';
    if (this._loadingEl) this._loadingEl.style.display = 'none';
    if (this._contentEl) this._contentEl.style.display = 'none';
  }

  _esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
