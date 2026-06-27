/**
 * PositionView — Inspect a specific TTD position.
 * Shows callstack, registers, and stack memory at a pinned position.
 * Opened by clicking a row in Mem Access.
 */

import MemoryPageSvgView from './MemoryPageSvgView.js';

export default class PositionView {
  constructor(container) {
    this._container = container;
    this._position = null;      // { major, minor, threadId }

    // Callbacks set by App
    this.onFetchCallstack = null;    // async ({ major, minor, threadId }) => frames[]
    this.onFetchRegisters = null;    // async ({ major, minor, threadId }) => registers{}
    this.onFetchPageRender  = null;  // async ({ major, minor, threadId, address }) => pageRenderData

    this._buildShell();
  }

  setActive(active) {
    this._embeddedPageView?.setActive(active);
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
      const pageData = await this._fetchPageRender(registers.rsp);
      this._embeddedPageView.setData(pageData);
      this._stackMetaEl.textContent = pageData?.available ? 'RSP page' : 'unavailable';
    }
  }

  // -------------------------------------------------------------------

  _buildShell() {
    this._container.classList.add('pv-root');
    this._container.innerHTML = [
      '<div class="pv-toolbar">',
      '  <div class="pv-toolbar-title">Position Inspector</div>',
      '  <div class="pv-toolbar-subtitle" id="pv-pos-info">No position loaded</div>',
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
      '        <div class="pv-section-title">Stack Memory (RSP)</div>',
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
    this._stackSvgEl = this._container.querySelector('#pv-stack-svg');

    this._embeddedPageView = new MemoryPageSvgView(this._stackSvgEl);
    this._embeddedPageView.onNavigate = (address) => this._navigateEmbeddedPage(address);
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
        <span class="pv-frame-addr">${addr}</span>
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
      const hex = v != null ? BigInt(v).toString(16).toUpperCase() : '—';
      return `<div class="pv-reg-row">
        <span class="pv-reg-name">${n}</span>
        <span class="pv-reg-val">${hex}</span>
      </div>`;
    }).join('');
  }

  // --- Stack memory ---

  async _navigateEmbeddedPage(address) {
    if (!this._position) return;
    const pageData = await this._fetchPageRender(address);
    this._embeddedPageView.setData(pageData);
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
      return await this.onFetchPageRender?.({ major, minor, threadId, address });
    } catch (e) {
      console.error('[PV] page render fetch failed:', e);
      return { available: false };
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
