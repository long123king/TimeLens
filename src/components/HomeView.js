/**
 * HomeView – Visual session dashboard.
 * Module bars, Timeline-style thread lanes, compact status strip.
 */

const THREAD_COLORS = [
  '#ff6b6b', '#ffa94d', '#a8e6cf', '#ffd3b6', '#ffaaa5',
  '#ff8b94', '#f8b500', '#00d9ff', '#c1b2f0', '#a4de6c',
];

export default class HomeView {
  constructor(container) {
    this._container = container;
    this._active = false;
    this._connected = false;
    this._uptimeMs = null;
    this._trace = null;
    this._modules = [];
    this._threads = [];
    this._activeThreadId = null;
    this.onNavigate = null;
    this._buildShell();
  }

  // --- public API ---

  setActive(active) { this._active = active; }

  setDisconnected() {
    this._connected = false;
    this._uptimeMs = null;
    this._renderPlaceholder();
    this._renderToolbarPill();
    this._renderHero();
    this._renderStatusStrip();
    this._renderThreadStrip();
  }

  setTraceInfo(trace) {
    this._trace = trace;
    this._renderStatusStrip();
    this._renderToolbarPill();
    this._renderHero();
    if (trace?.available) this._showContent();
  }

  setThreads(threads, activeThreadId) {
    this._threads = threads ?? [];
    this._activeThreadId = activeThreadId;
    this._renderThreadStrip();
    this._renderHeroMetrics();
  }

  setConnectionStatus(connected, uptimeMs) {
    this._connected = connected;
    this._uptimeMs = uptimeMs;
    this._renderStatusStrip();
    this._renderToolbarPill();
    this._renderHero();
  }

  // --- shell ---

  _buildShell() {
    this._container.classList.add('hm-root');
    this._container.innerHTML = [
      '<div class="hm-toolbar">',
      '  <div>',
      '    <div class="hm-toolbar-title">Home</div>',
      '    <div class="hm-toolbar-subtitle" id="hm-subtitle"></div>',
      '  </div>',
      '  <div id="hm-toolbar-pill" class="hm-toolbar-pill is-offline">Offline</div>',
      '</div>',
      '<div class="hm-body">',
      '  <div id="hm-placeholder" class="hm-placeholder">',
      '    <div class="hm-placeholder-icon">◎</div>',
      '    <div class="hm-placeholder-text">Not connected</div>',
      '  </div>',
      '  <div id="hm-content" class="hm-content" style="display:none">',

      '    <section class="hm-hero">',
      '      <div class="hm-hero-main">',
      '        <div id="hm-hero-title" class="hm-hero-title"></div>',
      '        <div id="hm-hero-chips" class="hm-hero-chips"></div>',
      '      </div>',
      '      <div class="hm-hero-aside">',
      '        <div class="hm-hero-metric hm-hero-metric-full">',
      '          <div class="hm-hero-metric-label">Threads</div>',
      '          <div id="hm-metric-threads" class="hm-hero-metric-value">0</div>',
      '        </div>',
      '      </div>',
      '    </section>',

      '    <div id="hm-status-strip" class="hm-status-strip"></div>',

      '    <div id="hm-card-threads" class="hm-card hm-card-visual">',
      '      <div class="hm-card-head">',
      '        <div class="hm-card-title">Threads</div>',
      '        <div class="hm-card-meta" id="hm-threads-meta"></div>',
      '      </div>',
      '      <div id="hm-thread-lanes" class="hm-thread-lanes"></div>',
      '    </div>',

      '  </div>',
      '</div>',
    ].join('');

    this._placeholderEl   = this._container.querySelector('#hm-placeholder');
    this._contentEl       = this._container.querySelector('#hm-content');
    this._subtitleEl      = this._container.querySelector('#hm-subtitle');
    this._pillEl          = this._container.querySelector('#hm-toolbar-pill');
    this._heroTitleEl     = this._container.querySelector('#hm-hero-title');
    this._heroChipsEl     = this._container.querySelector('#hm-hero-chips');
    this._metricThreadsEl = this._container.querySelector('#hm-metric-threads');
    this._statusStripEl   = this._container.querySelector('#hm-status-strip');
    this._threadLanesEl   = this._container.querySelector('#hm-thread-lanes');
    this._threadsMetaEl   = this._container.querySelector('#hm-threads-meta');

    this._renderToolbarPill();
    this._renderHero();
    this._renderStatusStrip();
    this._renderThreadStrip();
  }

  // --- toolbar pill ---

  _renderToolbarPill() {
    if (!this._pillEl) return;
    const connected = !!this._connected;
    const traceMode = this._trace?.isTTD ? 'TTD' : (this._trace?.available ? 'Live' : null);
    const label = connected ? (traceMode || 'Online') : 'Offline';
    this._pillEl.textContent = label;
    this._pillEl.classList.toggle('is-online', connected);
    this._pillEl.classList.toggle('is-offline', !connected);
  }

  // --- hero ---

  _renderHero() {
    const connected = !!this._connected;
    const traceAvail = !!this._trace?.available;
    const tc = this._threads?.length ?? 0;
    const mode = this._trace?.isTTD ? 'TTD' : (traceAvail ? 'Live' : 'No trace');
    const dump = this._trace?.dumpFile ? this._trace.dumpFile.split(/[\\/]/).pop() : null;

    if (this._subtitleEl) {
      this._subtitleEl.textContent = connected ? 'Session dashboard' : 'Awaiting connection';
    }

    if (this._heroTitleEl) {
      this._heroTitleEl.textContent = traceAvail && dump ? dump : (connected ? 'Connected' : 'Offline');
    }

    if (this._heroChipsEl) {
      this._heroChipsEl.innerHTML = [
        this._chip(connected ? 'Online' : 'Offline', connected ? 'ok' : 'off'),
        this._chip(mode, traceAvail ? 'accent' : 'muted'),
        this._chip(`${tc} threads`, 'muted'),
      ].join('');
    }

    this._renderHeroMetrics();
  }

  _renderHeroMetrics() {
    if (this._metricThreadsEl) this._metricThreadsEl.textContent = String(this._threads?.length ?? 0);
  }

  _chip(label, tone) {
    return `<span class="hm-chip hm-chip-${tone}">${this._esc(label)}</span>`;
  }

  // --- status strip ---

  _renderStatusStrip() {
    const connected = !!this._connected;
    const t = this._trace;
    const traceAvail = !!t?.available;
    const range = traceAvail && t?.firstPos && t?.lastPos
      ? `${this._fmtPos(t.firstPos)} → ${this._fmtPos(t.lastPos)}`
      : '—';
    const mode = t?.isTTD ? 'TTD' : (traceAvail ? 'Live' : '—');
    const tid = this._activeThreadId != null ? `TID ${this._activeThreadId}` : '—';
    const hot = this._threads?.find(th => th.threadId === this._activeThreadId) ?? this._threads?.[0];
    const sym = hot?.procSymbol?.name ? this._esc(hot.procSymbol.name).split('!').pop() : '—';

    this._statusStripEl.innerHTML = [
      `<div class="hm-strip-item">
        <span class="hm-strip-dot" style="background:${connected ? '#4fcf7a' : '#cf4f4f'}"></span>
        <span class="hm-strip-label">${connected ? 'Connected' : 'Offline'}</span>
        ${this._uptimeMs != null ? `<span class="hm-strip-val">${this._fmtUptime(this._uptimeMs)}</span>` : ''}
      </div>`,
      `<div class="hm-strip-item hm-strip-accent">
        <span class="hm-strip-label">${mode}</span>
        <span class="hm-strip-val">${range}</span>
      </div>`,
      `<div class="hm-strip-item">
        <span class="hm-strip-label">Active</span>
        <span class="hm-strip-val">${tid}</span>
        <span class="hm-strip-sub">${sym}</span>
      </div>`,
    ].join('');
  }

  // --- thread strip (Timeline-style lanes) ---

  _renderThreadStrip() {
    const threads = this._threads ?? [];
    if (!threads.length) {
      this._threadLanesEl.innerHTML = '<div class="hm-viz-empty">No threads</div>';
      if (this._threadsMetaEl) this._threadsMetaEl.textContent = '';
      return;
    }

    if (this._threadsMetaEl) {
      const active = threads.find(t => t.threadId === this._activeThreadId);
      const sym = active?.procSymbol?.name ? this._esc(active.procSymbol.name).split('!').pop() : '';
      this._threadsMetaEl.textContent = `${threads.length} thread${threads.length === 1 ? '' : 's'}` + (sym ? ` · active: ${sym}` : '');
    }

    const colorById = {};
    this._threadLanesEl.innerHTML = threads.map((t) => {
      const id = t.threadId;
      if (!colorById[id]) colorById[id] = THREAD_COLORS[Object.keys(colorById).length % THREAD_COLORS.length];
      const color = colorById[id];
      const active = id === this._activeThreadId;
      const sym = t.procSymbol?.name ? this._esc(t.procSymbol.name).split('!').pop() : '—';
      return `<button class="hm-thread-lane${active ? ' hm-thread-lane-active' : ''}"
        style="--lane-color:${color}"
        data-nav="timeline">
        <span class="hm-thread-lane-ribbon" style="background:${color}"></span>
        <span class="hm-thread-lane-label">
          <span class="hm-thread-lane-tid">TID ${id}</span>
          <span class="hm-thread-lane-sym">${sym}</span>
        </span>
      </button>`;
    }).join('');

    this._threadLanesEl.querySelectorAll('[data-nav]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.onNavigate) this.onNavigate('timeline');
      });
    });
  }

  // --- placeholder ---

  _renderPlaceholder() {
    this._placeholderEl.style.display = 'flex';
    this._contentEl.style.display = 'none';
  }

  _showContent() {
    this._placeholderEl.style.display = 'none';
    this._contentEl.style.display = 'block';
  }

  // --- helpers ---

  _fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }

  _fmtPos(pos) {
    if (!pos) return '—';
    const major = BigInt(pos.major ?? '0').toString(16).toUpperCase();
    const minor = Number(pos.minor ?? 0);
    return `${major}:${minor.toString(16).toUpperCase()}`;
  }

  _esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
