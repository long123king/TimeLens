/**
 * FlameGraphView — Thread-aware row-by-row flame graph.
 *
 * Each thread gets its own compact flame graph row, sampled within
 * that thread's lifetime range. Rows are sorted by first activity.
 * Caller at bottom, callee at top.
 */

const DEFAULT_SAMPLE_COUNT = 10;
const CONCURRENCY = 1;    // dk server is single-threaded — parallel requests can hang
const ROW_HEIGHT = 14;    // SVG row height per frame
const FONT_SIZE = 9;
const MIN_BOX_WIDTH = 1.5;
const BREADCRUMB_HEIGHT = 12;
const SIGNIFICANT_LEVEL_TOTAL_WIDTH = 240;
const SIGNIFICANT_LEVEL_MAX_WIDTH = 180;

export default class FlameGraphView {
  constructor(container) {
    this._container = container;
    this._active = false;

    // Callbacks set by App
    this.onGetTraceBounds = null;    // () => { first, last }
    this.onGetThreads = null;        // () => [{ threadId }]
    this.onGetThreadLifetimes = null; // () => Map<threadId, { start: {major,minor}, end: {major,minor} }>
    this.onFetchCallstacks = null;   // async ({ positions, threadId }) => [{ frames }]
    this.onFetchAllThreadFrames = null; // async (threadId) => [{ frames: [...] }, ...]
                                          // Used in replay mode to read recorded
                                          // callstack fixtures directly without
                                          // per-position sampling. When set,
                                          // Phase 2 bypasses _fetchInBatches.
    this.onClickFrame = null;        // (startAddr, endAddr, mode) => void

    // State
    this._traceBounds = null;    // { first, last } — cached for lifetime-to-pixel mapping
    this._threadTrees = new Map();   // threadId → { tree, validSamples }
    this._fetching = false;
    this._fetchProgress = { done: 0, total: 0 };

    this._buildShell();
  }

  setActive(active) {
    this._active = active;
    if (!active) {
      // Stop any in-progress sampling so new callstack requests
      // don't race with a subsequent mem-access query
      if (this._fetching) this._fetching = false;
    } else if (!this._fetching) {
      // Detect interrupted sampling: threadTrees has placeholder entries
      // (tree === null) from an earlier Phase 1 that never got Phase 2.
      const hasIncomplete = this._threadTrees.size > 0 &&
        [...this._threadTrees.values()].some(e => e.tree === null);
      if (hasIncomplete) {
        this._resumeSampling();
      } else if (this._threadTrees.size === 0) {
        this._renderPlaceholder('◌', 'Sampling...');
        setTimeout(() => this._startSampling(), 0);
      }
    }
  }

  setDisconnected() {
    this._threadTrees = new Map();
    this._renderPlaceholder('◎', 'Not connected to a debug session.');
  }

  // ---- Position computation -----------------------------------------------

  _computePositionsInRange(count, start, end) {
    if (!start?.major || !end?.major) return [];
    try {
      const firstMajor = BigInt(start.major);
      const lastMajor = BigInt(end.major);
      const firstMinor = Number(start.minor ?? 0);
      const lastMinor = Number(end.minor ?? 0);
      if (lastMajor < firstMajor) return [];

      const span = lastMajor - firstMajor;
      if (span === 0n && lastMinor <= firstMinor) {
        // Single point range
        return [{ major: firstMajor.toString(), minor: firstMinor }];
      }

      const positions = [];
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        if (span === 0n) {
          positions.push({ major: firstMajor.toString(), minor: firstMinor });
        } else {
          const scaled = BigInt(Math.round(Number(span) * t * 1000000));
          const major = firstMajor + (scaled / 1000000n);
          const minor = firstMinor + Math.round(Number(scaled % 1000000n) / 1000000 * (lastMinor - firstMinor));
          positions.push({ major: major.toString(), minor: Math.max(0, minor) });
        }
      }
      return positions;
    } catch {
      return [];
    }
  }

  /**
   * Convert a {major, minor} position to a 0..1 fraction between first and last
   * trace bounds. Used for positioning thread lifetime bars on the SVG timeline.
   */
  _positionToFraction(pos, first, last) {
    if (!pos || !first?.major || !last?.major) return 0;
    try {
      const posVal = BigInt(pos.major) * 1000000n + BigInt(pos.minor ?? 0);
      const firstVal = BigInt(first.major) * 1000000n + BigInt(first.minor ?? 0);
      const lastVal = BigInt(last.major) * 1000000n + BigInt(last.minor ?? 0);
      const span = lastVal - firstVal;
      if (span <= 0n) return 0;
      const frac = Number((posVal - firstVal) * 10000n / span) / 10000;
      return Math.max(0, Math.min(1, frac));
    } catch {
      return 0;
    }
  }

  // ---- Sampling (all threads) ---------------------------------------------

  async _startSampling(sampleCount = DEFAULT_SAMPLE_COUNT) {
    const threads = this.onGetThreads?.() ?? [];
    const lifetimes = this.onGetThreadLifetimes?.() ?? new Map();
    const traceBounds = this.onGetTraceBounds?.();

    if (!traceBounds?.first?.major || threads.length === 0) {
      this._renderPlaceholder('⚠', 'No trace bounds or threads available.');
      return;
    }

    this._traceBounds = traceBounds;   // cache for lifetime-to-pixel mapping
    this._fetching = true;
    this._threadTrees = new Map();
    this._fetchProgress = { done: 0, total: threads.length };
    this._placeholderEl.style.display = 'none';
    this._rowsEl.innerHTML = '';
    this._renderProgress();
    const sorted = [...threads];

    // Phase 1: render all rows immediately as placeholders
    for (const t of sorted) {
      const tid = t.threadId;
      const lt = lifetimes.get(tid);
      const range = lt
        ? { start: lt.start, end: lt.end }
        : { start: traceBounds.first, end: traceBounds.last };
      const placeholderEntry = { tree: null, validSamples: 0, range, positions: sampleCount };
      this._threadTrees.set(tid, placeholderEntry);
      this._appendThreadRow(tid, placeholderEntry);
    }

    // Yield so the browser paints placeholder rows before Phase 2 API calls
    await new Promise(r => setTimeout(r, 0));
    try {
      for (const t of sorted) {
        // Stop early if tab was switched away
        if (!this._fetching) break;
        const tid = t.threadId;
        const lt = lifetimes.get(tid);
        const range = lt
          ? { start: lt.start, end: lt.end }
          : { start: traceBounds.first, end: traceBounds.last };

        this._fetchProgress.currentTid = tid;
        this._renderProgress();

        const positions = this._computePositionsInRange(sampleCount, range.start, range.end);

        let tree = null;
        let validSamples = 0;
        let positionsCount = positions.length;
        if (this.onFetchAllThreadFrames) {
          // Replay-mode fast path: read every recorded callstack for this
          // thread at once instead of computing per-position samples.
          try {
            const containers = await this.onFetchAllThreadFrames(tid) ?? [];
            const valid = containers
              .map(c => c?.frames)
              .filter(f => Array.isArray(f) && f.length > 0);
            validSamples = valid.length;
            positionsCount = valid.length;
            if (valid.length > 0) {
              tree = this._buildTree(valid);
            }
          } catch (err) {
            console.error('[FG] TID ' + tid + ' replay fetch error:', err);
          }
        } else if (positions.length > 0) {
          try {
            const stacks = await this._fetchInBatches(positions, tid, CONCURRENCY);
            const valid = stacks.filter(s => Array.isArray(s) && s.length > 0);
            validSamples = valid.length;
            if (valid.length > 0) {
              tree = this._buildTree(valid);
            }
          } catch (err) {
            console.error('[FG] TID ' + tid + ' sampling error:', err);
          }
        }

        const entry = { tree, validSamples, range, positions: positionsCount };
        this._threadTrees.set(tid, entry);
        this._fetchProgress.done++;
        this._renderProgress();

        // Update this row's SVG in-place
        this._updateThreadRowSvg(tid, entry);
      }
    } finally {
      this._fetching = false;
      this._interrupted = false;
    }
  }

  /**
   * Resume sampling for threads that were interrupted mid-way.
   * Preserves already-completed threads (tree !== null) and
   * re-samples only incomplete placeholder entries.
   */
  async _resumeSampling(sampleCount = DEFAULT_SAMPLE_COUNT) {
    const threads = this.onGetThreads?.() ?? [];
    const lifetimes = this.onGetThreadLifetimes?.() ?? new Map();
    const traceBounds = this.onGetTraceBounds?.();

    if (!traceBounds?.first?.major || threads.length === 0) {
      this._renderPlaceholder('⚠', 'No trace bounds or threads available.');
      this._interrupted = false;
      return;
    }

    this._interrupted = false;
    this._fetching = true;
    this._placeholderEl.style.display = 'none';

    // Count incomplete threads
    const incomplete = [];
    for (const t of threads) {
      const entry = this._threadTrees.get(t.threadId);
      if (!entry || entry.tree === null) {
        incomplete.push(t);
      }
    }

    if (incomplete.length === 0) {
      // Everything was already done — just update progress display
      this._fetchProgress = { done: this._threadTrees.size, total: this._threadTrees.size };
      this._renderProgress();
      this._loadingEl.style.display = 'none';
      this._fetching = false;
      return;
    }

    this._fetchProgress = { done: 0, total: incomplete.length };
    this._renderProgress();

    for (const t of incomplete) {
      if (!this._fetching) break;
      const tid = t.threadId;
      const lt = lifetimes.get(tid);
      const range = lt
        ? { start: lt.start, end: lt.end }
        : { start: traceBounds.first, end: traceBounds.last };

      this._fetchProgress.currentTid = tid;
      this._renderProgress();

      const positions = this._computePositionsInRange(sampleCount, range.start, range.end);

      let tree = null;
      let validSamples = 0;
      let positionsCount = positions.length;
      if (this.onFetchAllThreadFrames) {
        try {
          const containers = await this.onFetchAllThreadFrames(tid) ?? [];
          const valid = containers
            .map(c => c?.frames)
            .filter(f => Array.isArray(f) && f.length > 0);
          validSamples = valid.length;
          positionsCount = valid.length;
          if (valid.length > 0) {
            tree = this._buildTree(valid);
          }
        } catch (err) {
          console.error('[FG] TID ' + tid + ' resume replay error:', err);
        }
      } else if (positions.length > 0) {
        try {
          const stacks = await this._fetchInBatches(positions, tid, CONCURRENCY);
          const valid = stacks.filter(s => Array.isArray(s) && s.length > 0);
          validSamples = valid.length;
          if (valid.length > 0) {
            tree = this._buildTree(valid);
          }
        } catch (err) {
          console.error('[FG] TID ' + tid + ' resume error:', err);
        }
      }

      const entry = { tree, validSamples, range, positions: positionsCount };
      this._threadTrees.set(tid, entry);
      this._fetchProgress.done++;
      this._renderProgress();

      // Update this row's SVG in-place (placeholder row already exists)
      this._updateThreadRowSvg(tid, entry);
    }

    this._fetching = false;
  }

  async _fetchInBatches(positions, threadId, concurrency) {
    const allStacks = new Array(positions.length);
    let cursor = 0;

    while (cursor < positions.length) {
      if (!this._fetching) break;   // stopped mid-sampling
      const batch = positions.slice(cursor, cursor + concurrency);
      const results = await Promise.all(
        batch.map(async (pos, idx) => {
          try {
            // Small stagger to avoid hammering the single-threaded dk server
            await new Promise(r => setTimeout(r, idx * 30));
            const frames = await this._fetchOneCallstack(pos, threadId);
            allStacks[cursor + idx] = frames;
          } catch {
            allStacks[cursor + idx] = null;
          }
        })
      );
      cursor += batch.length;
    }

    return allStacks.filter(s => Array.isArray(s) && s.length > 0);
  }

  async _fetchOneCallstack(position, threadId) {
    if (!this.onFetchCallstacks) return [];
    try {
      const result = await this.onFetchCallstacks({ positions: [position], threadId });
      if (Array.isArray(result) && result.length > 0) {
        const frames = result[0]?.frames ?? [];
        return frames;
      }
      return [];
    } catch (err) {
      console.error('[FG] fetchOneCallstack TID='+threadId+' error:', err);
      return [];
    }
  }

  _buildTree(allFrames) {
    const root = { name: 'root', count: 0, children: new Map(), selfCount: 0, minAddr: null, maxAddr: null };
    root.count = allFrames.length;

    for (const frames of allFrames) {
      if (!frames || frames.length === 0) continue;
      const reversed = [...frames].reverse(); // root at bottom
      let node = root;
      for (const frame of reversed) {
        // Strip instruction offset from function name so frames at
        // different offsets within the same function merge into one node
        let name = frame.function || frame.instructionOffset || '?';
        if (typeof name === 'string') {
          const plusIdx = name.indexOf('+0x');
          if (plusIdx >= 0) name = name.substring(0, plusIdx);
        }
        if (!node.children.has(name)) {
          node.children.set(name, { name, count: 0, children: new Map(), selfCount: 0, minAddr: null, maxAddr: null });
        }
        const child = node.children.get(name);
        child.count++;
        if (frame.instructionOffset != null) {
          const addr = BigInt(frame.instructionOffset);
          if (child.minAddr == null || addr < BigInt(child.minAddr)) child.minAddr = '0x' + addr.toString(16);
          if (child.maxAddr == null || addr > BigInt(child.maxAddr)) child.maxAddr = '0x' + addr.toString(16);
        }
        node = child;
      }
      node.selfCount++;
    }

    return this._convertTree(root);
  }

  _convertTree(node) {
    const children = [...node.children.values()]
      .map(c => this._convertTree(c))
      .sort((a, b) => b.count - a.count);
    const selfCount = node.selfCount ?? node.count - children.reduce((s, c) => s + c.count, 0);
    return { name: node.name, count: node.count, selfCount, children, minAddr: node.minAddr, maxAddr: node.maxAddr };
  }

  // ---- Shell --------------------------------------------------------------

  _buildShell() {
    this._container.classList.add('fg-root');
    this._container.innerHTML = [
      '<div class="fg-toolbar">',
      '  <div class="fg-toolbar-title">Flame Graph</div>',
      '  <div class="fg-toolbar-subtitle">Per-thread · lifetime-aware · 10 samples</div>',
      '  <div class="fg-toolbar-right">',
      '    <span id="fg-loading" class="fg-loading" style="display:none"><span class="spinner"></span><span id="fg-progress-text"></span></span>',
      '  </div>',
      '</div>',
      '<div class="fg-body">',
      '  <div class="fg-controls">',
      '    <button id="fg-refresh" class="fg-btn secondary" type="button">↻ Refresh</button>',
      '  </div>',
      '  <div class="fg-canvas-wrap" id="fg-canvas-wrap">',
      '    <div id="fg-rows" class="fg-rows"></div>',
      '    <div id="fg-tooltip" class="fg-tooltip" style="display:none"></div>',
      '    <div id="fg-placeholder" class="fg-placeholder"></div>',
      '  </div>',
      '  <div id="fg-legend" class="fg-legend">',
      '    <span class="fg-legend-item"><span class="fg-legend-swatch" style="background:hsl(200,60%,50%)"></span>Wide = hot</span>',
      '    <span class="fg-legend-item"><span class="fg-legend-swatch" style="background:hsl(200,20%,35%)"></span>Narrow = cold</span>',
      '  </div>',
      '</div>'
    ].join('');

    this._loadingEl = this._container.querySelector('#fg-loading');
    this._progressText = this._container.querySelector('#fg-progress-text');
    this._rowsEl = this._container.querySelector('#fg-rows');
    this._tooltipEl = this._container.querySelector('#fg-tooltip');
    this._placeholderEl = this._container.querySelector('#fg-placeholder');
    this._refreshBtn = this._container.querySelector('#fg-refresh');
    this._canvasWrapEl = this._container.querySelector('#fg-canvas-wrap');
    this._bodyEl = this._container.querySelector('.fg-body');

    // Refresh
    this._refreshBtn?.addEventListener('click', () => this._startSampling());

    this._renderPlaceholder('◌', 'Click Refresh to begin sampling.');
  }

  _renderTimelineAxis() {
    const tb = this._traceBounds;
    if (!tb?.first?.major || !tb?.last?.major) return null;

    try {
      const firstMajor = BigInt(tb.first.major);
      const lastMajor = BigInt(tb.last.major);
      const span = lastMajor - firstMajor;
      if (span <= 0n) return null;

      // Determine tick step
      const numMajors = Number(span) + 1;
      let tickStep = 1n;
      if (numMajors > 50) tickStep = 10n;
      else if (numMajors > 30) tickStep = 5n;
      else if (numMajors > 20) tickStep = 2n;

      const svg = this._svgNS('svg');
      svg.setAttribute('class', 'fg-axis-svg');
      svg.setAttribute('viewBox', '0 0 1200 16');
      svg.setAttribute('width', '1200');
      svg.setAttribute('height', '16');
      svg.setAttribute('preserveAspectRatio', 'none');

      // Base line
      const line = this._svgNS('line');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', '1200');
      line.setAttribute('y1', '12');
      line.setAttribute('y2', '12');
      line.setAttribute('stroke', '#4a6a5a');
      line.setAttribute('stroke-width', '0.5');
      svg.appendChild(line);

      // Tick marks at major boundaries
      for (let m = firstMajor; m <= lastMajor; m += tickStep) {
        const frac = Number((m - firstMajor) * 10000n / span) / 10000;
        const x = Math.round(frac * 1200);

        const tick = this._svgNS('line');
        tick.setAttribute('x1', String(x));
        tick.setAttribute('x2', String(x));
        tick.setAttribute('y1', '8');
        tick.setAttribute('y2', '14');
        tick.setAttribute('stroke', '#5a9a6a');
        tick.setAttribute('stroke-width', '0.5');
        svg.appendChild(tick);

        const label = this._svgNS('text');
        label.setAttribute('x', String(Math.min(1190, x + 2)));
        label.setAttribute('y', '7');
        label.setAttribute('fill', '#7ab890');
        label.setAttribute('font-size', '7');
        label.setAttribute('font-family', 'Consolas, monospace');
        label.textContent = '0x' + m.toString(16).toUpperCase();
        svg.appendChild(label);
      }

      return svg;
    } catch {
      return null;
    }
  }

  _renderProgress() {
    const { done, total, currentTid } = this._fetchProgress;
    if (total === 0) return;
    this._loadingEl.style.display = 'inline-flex';
    const tidStr = currentTid != null ? `TID ${currentTid} · ` : '';
    this._progressText.textContent = `${tidStr}${done}/${total} threads`;
    if (done >= total) {
      this._loadingEl.style.display = 'none';
    }
  }

  _renderPlaceholder(icon, text) {
    this._placeholderEl.innerHTML = [
      '<div class="fg-empty">',
      `  <div class="fg-empty-icon">${this._esc(icon)}</div>`,
      `  <div class="fg-empty-text">${this._esc(text)}</div>`,
      '</div>'
    ].join('');
    this._placeholderEl.style.display = 'flex';
    this._rowsEl.innerHTML = '';
  }

  // ---- Row rendering ------------------------------------------------------

  /**
   * Append a single thread row — used for incremental rendering during sampling.
   */
  _appendThreadRow(tid, entry) {
    const row = this._renderThreadRow(tid, entry);
    row.dataset.tid = String(tid);
    this._rowsEl.appendChild(row);
    if (entry.tree) this._wireRowEvents(row);
  }

  _updateThreadRowSvg(tid, entry) {
    // Find existing row and replace its SVG + label in-place
    const row = this._rowsEl.querySelector(`.fg-thread-row[data-tid="${tid}"]`);
    if (!row) return;

    const tb = this._traceBounds;

    // Compute lifetime proportions for proportional SVG width + positioning
    let startFrac = 0, endFrac = 1;
    if (tb?.first?.major && tb?.last?.major && entry.range) {
      startFrac = this._positionToFraction(entry.range.start, tb.first, tb.last);
      endFrac = this._positionToFraction(entry.range.end, tb.first, tb.last);
    }
    const threadPct = Math.max(0, (endFrac - startFrac) * 100);
    const threadWidth = Math.max(MIN_BOX_WIDTH, Math.round((endFrac - startFrac) * 1200));

    // Update label metadata
    const meta = row.querySelector('.fg-thread-meta');
    if (meta && entry.range) {
      const lifetime = `${entry.range.start?.major ?? '?'}:${entry.range.start?.minor ?? 0}–${entry.range.end?.major ?? '?'}:${entry.range.end?.minor ?? 0}`;
      meta.textContent = `${lifetime} · ${entry.validSamples}/${entry.positions} stacks`;
    }

    // Replace placeholder/spinner with real SVG
    const oldSvg = row.querySelector('.fg-thread-svg');
    const oldEmpty = row.querySelector('.fg-thread-empty');
    if (oldSvg) oldSvg.remove();
    if (oldEmpty) oldEmpty.remove();

    if (entry.tree) {
      const { tree, renderedLevels, svgH } =
        this._computeRowLayout(entry);

      // SVG wrapper — fills remaining space after label, SVG positioned within
      const wrapper = document.createElement('div');
      wrapper.style.flex = '1';
      wrapper.style.minWidth = '0';
      wrapper.style.position = 'relative';
      wrapper.style.height = `${svgH}px`;

      const svg = this._svgNS('svg');
      svg.setAttribute('class', 'fg-thread-svg');
      svg.dataset.tid = String(tid);
      svg.setAttribute('viewBox', `0 0 ${threadWidth} ${svgH}`);
      svg.setAttribute('width', String(threadWidth));
      svg.setAttribute('height', String(svgH));
      svg.setAttribute('preserveAspectRatio', 'none');

      // Position proportionally within wrapper (like timeline thread bars)
      svg.style.position = 'absolute';
      svg.style.left = `${startFrac * 100}%`;
      svg.style.width = `${threadPct}%`;
      svg.style.top = '0';
      svg.style.height = '100%';

      // Subtle background bar for thread lifetime region
      const lifeBg = this._svgNS('rect');
      lifeBg.setAttribute('x', '0');
      lifeBg.setAttribute('y', '0');
      lifeBg.setAttribute('width', String(threadWidth));
      lifeBg.setAttribute('height', String(svgH));
      lifeBg.setAttribute('fill', 'rgba(50, 90, 65, 0.25)');
      lifeBg.setAttribute('stroke', 'rgba(90, 145, 110, 0.5)');
      lifeBg.setAttribute('stroke-width', '1');
      svg.appendChild(lifeBg);

      this._renderRowFrames(svg, tree, 0, 0, threadWidth, renderedLevels, tree.count, svgH, 0);
      wrapper.appendChild(svg);
      row.appendChild(wrapper);
      this._wireRowEvents(row);
    } else {
      const empty = document.createElement('div');
      empty.className = 'fg-thread-empty';
      empty.textContent = 'no callstack data';
      row.appendChild(empty);
    }
  }

  _renderAllThreads() {
    if (this._threadTrees.size === 0) {
      this._renderPlaceholder('◌', 'No data. Select sample count.');
      return;
    }

    this._updateControls();
    this._placeholderEl.style.display = 'none';
    this._rowsEl.innerHTML = '';

    // Collect rows in sorted order
    const rows = [];
    for (const [tid, entry] of this._threadTrees) {
      rows.push({ tid, entry });
    }
    rows.sort((a, b) => a.tid - b.tid);

    for (const { tid, entry } of rows) {
      const row = this._renderThreadRow(tid, entry);
      this._rowsEl.appendChild(row);
      this._wireRowEvents(row);
    }
  }

  _wireRowEvents(row) {
    // Wire up SVG click/hover event delegation on a single row
    const svg = row.querySelector('.fg-thread-svg');
    if (!svg) return;

    svg.addEventListener('mousemove', (e) => {
      const frameEl = e.target.closest('.fg-frame');
      if (frameEl) {
        const name = frameEl.dataset.name || '';
        const count = frameEl.dataset.count || '';
        const pct = frameEl.dataset.pct || '';
        this._tooltipEl.innerHTML = `<strong>${this._esc(name)}</strong><br>${count} samples (${pct}%)`;
        this._tooltipEl.style.display = 'block';

        // Position near cursor horizontally, centralized vertically
        const bodyRect = this._bodyEl.getBoundingClientRect();
        const tw = this._tooltipEl.offsetWidth;
        const th = this._tooltipEl.offsetHeight;
        const PAD = 16;

        // Horizontal: prefer right of cursor, flip left if near right boundary
        let tx = e.clientX + PAD;
        if (tx + tw > bodyRect.right - PAD) {
          tx = e.clientX - tw - PAD;
        }
        if (tx < bodyRect.left + PAD) tx = bodyRect.left + PAD;

        // Vertical: centered in visible area, loosely near cursor row
        let ty = bodyRect.top + bodyRect.height * 0.35 - th / 2;
        if (ty < bodyRect.top + PAD) ty = bodyRect.top + PAD;
        if (ty + th > bodyRect.bottom - PAD) ty = bodyRect.bottom - th - PAD;

        // Convert to canvas-wrap-relative coordinates
        const wrapRect = this._canvasWrapEl.getBoundingClientRect();
        this._tooltipEl.style.left = (tx - wrapRect.left) + 'px';
        this._tooltipEl.style.top = (ty - wrapRect.top) + 'px';
      } else {
        this._tooltipEl.style.display = 'none';
      }
    });

    svg.addEventListener('mouseleave', () => {
      this._tooltipEl.style.display = 'none';
    });

    svg.addEventListener('click', (e) => {
      const frameEl = e.target.closest('.fg-frame');
      if (frameEl && frameEl.dataset.minAddr && this.onClickFrame) {
        const start = frameEl.dataset.minAddr;
        const end = frameEl.dataset.maxAddr || frameEl.dataset.minAddr;
        // Use actual range from callstack samples, pad slightly for alignment
        const range = BigInt(end) - BigInt(start);
        const pad = range > 0n ? 0x10n : 0x100n; // 16-byte pad, or 256 if single address
        const paddedEnd = '0x' + (BigInt(end) + pad).toString(16);
        this.onClickFrame(start, paddedEnd, 'E');
      }
    });
  }

  _renderThreadRow(tid, entry, expanded) {
    const tb = this._traceBounds;
    const row = document.createElement('div');
    row.className = 'fg-thread-row';

    // Compute lifetime proportions for proportional SVG width + positioning
    let startFrac = 0, endFrac = 1;
    if (tb?.first?.major && tb?.last?.major && entry.range) {
      startFrac = this._positionToFraction(entry.range.start, tb.first, tb.last);
      endFrac = this._positionToFraction(entry.range.end, tb.first, tb.last);
    }
    const threadPct = Math.max(0, (endFrac - startFrac) * 100);
    const threadWidth = Math.max(MIN_BOX_WIDTH, Math.round((endFrac - startFrac) * 1200));

    // Label
    const label = document.createElement('div');
    label.className = 'fg-thread-label';

    const lifetime = entry.range
      ? `${entry.range.start?.major ?? '?'}:${entry.range.start?.minor ?? 0}–${entry.range.end?.major ?? '?'}:${entry.range.end?.minor ?? 0}`
      : 'full trace';

    label.innerHTML = [
      `<span class="fg-thread-tid">TID ${tid}</span>`,
      `<span class="fg-thread-meta">${lifetime} · ${entry.validSamples}/${entry.positions} stacks</span>`
    ].join('');

    row.appendChild(label);

    // SVG
    if (entry.tree) {
      const { tree, breadcrumb, renderedLevels, svgH } =
        this._computeRowLayout(entry);

      // SVG wrapper — fills remaining space after label, SVG positioned within
      const wrapper = document.createElement('div');
      wrapper.style.flex = '1';
      wrapper.style.minWidth = '0';
      wrapper.style.position = 'relative';
      wrapper.style.height = `${svgH}px`;

      const svg = this._svgNS('svg');
      svg.setAttribute('class', 'fg-thread-svg');
      svg.dataset.tid = String(tid);
      svg.setAttribute('viewBox', `0 0 ${threadWidth} ${svgH}`);
      svg.setAttribute('width', String(threadWidth));
      svg.setAttribute('height', String(svgH));
      svg.setAttribute('preserveAspectRatio', 'none');

      // Position proportionally within wrapper (like timeline thread bars)
      svg.style.position = 'absolute';
      svg.style.left = `${startFrac * 100}%`;
      svg.style.width = `${threadPct}%`;
      svg.style.top = '0';
      svg.style.height = '100%';

      // Subtle background bar for thread lifetime region
      const lifeBg = this._svgNS('rect');
      lifeBg.setAttribute('x', '0');
      lifeBg.setAttribute('y', '0');
      lifeBg.setAttribute('width', String(threadWidth));
      lifeBg.setAttribute('height', String(svgH));
      lifeBg.setAttribute('fill', 'rgba(50, 90, 65, 0.25)');
      lifeBg.setAttribute('stroke', 'rgba(90, 145, 110, 0.5)');
      lifeBg.setAttribute('stroke-width', '1');
      svg.appendChild(lifeBg);

      // Render frames — root bar fills the full threadWidth
      this._renderRowFrames(svg, tree, 0, 0, threadWidth, renderedLevels, tree.count, svgH, 0);

      wrapper.appendChild(svg);
      row.appendChild(wrapper);
    } else {
      const empty = document.createElement('div');
      empty.className = 'fg-thread-empty';
      empty.textContent = 'no callstack data';
      row.appendChild(empty);
    }

    return row;
  }

  _renderRowFrames(svg, node, depth, xOffset, width, maxDepth, totalCount, svgHeight, levelOffset = 0) {
    const adjustedDepth = depth - levelOffset;
    const y = (maxDepth - adjustedDepth) * ROW_HEIGHT;
    const pct = totalCount > 0 ? ((node.count / totalCount) * 100).toFixed(1) : '0';

    if (node.name !== 'root' && width >= MIN_BOX_WIDTH && adjustedDepth >= 1 && adjustedDepth <= maxDepth) {
      const g = this._svgNS('g');
      g.setAttribute('class', 'fg-frame');
      g.dataset.name = node.name;
      g.dataset.count = String(node.count);
      g.dataset.pct = pct;
      if (node.minAddr) g.dataset.minAddr = node.minAddr;
      if (node.maxAddr) g.dataset.maxAddr = node.maxAddr;

      const rect = this._svgNS('rect');
      rect.setAttribute('x', String(xOffset));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(Math.max(0, width - 0.5)));
      rect.setAttribute('height', String(ROW_HEIGHT - 1));
      rect.setAttribute('fill', this._colorForName(node.name));
      rect.setAttribute('stroke', '#1a1a2e');
      rect.setAttribute('stroke-width', '0.3');
      svg.appendChild(g);
      g.appendChild(rect);

      if (width > 30) {
        const displayName = width > 60 ? node.name : (node.name.split('!').pop() || node.name);
        const textPadding = 4;
        const charWidth = 5.5;
        const maxChars = Math.max(1, Math.floor((width - textPadding) / charWidth));
        const truncated = displayName.length > maxChars
          ? displayName.substring(0, maxChars - 1) + '\u2026'
          : displayName;

        const text = this._svgNS('text');
        text.setAttribute('x', String(xOffset + 2));
        text.setAttribute('y', String(y + ROW_HEIGHT / 2 + 3));
        text.setAttribute('fill', '#fff');
        text.setAttribute('font-size', String(FONT_SIZE));
        text.setAttribute('font-family', 'Consolas, monospace');
        text.textContent = truncated;
        g.appendChild(text);
      }
    }

    // Stop recursing past maxDepth so frames stay within viewBox.
    // Without this guard, frames at depth > maxDepth get negative Y
    // coordinates and render outside the visible SVG area.
    if (node.children && node.children.length > 0 && depth < maxDepth + levelOffset) {
      let cx = xOffset;
      for (const child of node.children) {
        const childWidth = node.count > 0 ? (child.count / node.count) * width : 0;
        this._renderRowFrames(svg, child, depth + 1, cx, Math.max(0, childWidth), maxDepth, totalCount, svgHeight, levelOffset);
        cx += childWidth;
      }
    }
  }

  _collectVisibleLevels(node, totalWidth, totalCount, depth = 0, levels = []) {
    if (!node.children || node.children.length === 0) return levels;
    for (const child of node.children) {
      const childWidth = (child.count / totalCount) * totalWidth;
      if (childWidth < MIN_BOX_WIDTH) continue;
      const levelIndex = depth;
      if (!levels[levelIndex]) {
        levels[levelIndex] = { totalWidth: 0, maxWidth: 0, rectCount: 0 };
      }
      levels[levelIndex].totalWidth += childWidth;
      levels[levelIndex].maxWidth = Math.max(levels[levelIndex].maxWidth, childWidth);
      levels[levelIndex].rectCount += 1;
      this._collectVisibleLevels(child, childWidth, child.count, depth + 1, levels);
    }
    return levels;
  }

  _findSignificantLevelStart(levels, widthScale = 1) {
    const index = levels.findIndex(level => level && (
      level.totalWidth >= SIGNIFICANT_LEVEL_TOTAL_WIDTH * widthScale ||
      level.maxWidth >= SIGNIFICANT_LEVEL_MAX_WIDTH * widthScale ||
      level.rectCount >= 3
    ));
    return index >= 0 ? index : 0;
  }

  _computeRowLayout(entry) {
    const tree = entry.tree;
    const rawDepth = Math.max(0, this._treeDepth(tree) - 1);
    const renderedLevels = Math.max(8, rawDepth > 0 ? rawDepth : 1);
    const frameHeight = Math.max(ROW_HEIGHT, renderedLevels * ROW_HEIGHT + 2);
    const svgH = frameHeight;

    return { tree, renderedLevels, svgH, breadcrumb: [] };
  }

  _treeDepth(node) {
    if (!node.children || node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(c => this._treeDepth(c)));
  }

  /** Count levels that have at least one frame wide enough to render. */
  _compactDepth(node, totalWidth, totalCount) {
    if (!node.children || node.children.length === 0) return 0;
    let maxChildDepth = 0;
    for (const child of node.children) {
      const childWidth = (child.count / totalCount) * totalWidth;
      if (childWidth < MIN_BOX_WIDTH) continue;
      maxChildDepth = Math.max(maxChildDepth, 1 + this._compactDepth(child, childWidth, child.count));
    }
    return maxChildDepth;
  }

  _colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
      hash = hash & hash;
    }
    const h = Math.abs(hash) % 360;
    const s = 50 + (Math.abs(hash) % 30);
    const l = 30 + (Math.abs(hash >> 8) % 25);
    return `hsl(${h},${s}%,${l}%)`;
  }

  _svgNS(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  _esc(value) {
    return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}
