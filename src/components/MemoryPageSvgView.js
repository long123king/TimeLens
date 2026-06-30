/**
 * MemoryPageSvgView — pixel-exact replication of dk.dll page_2_svg.
 *
 * Mirrors visual_page() / page_to_svg_string() SVG generation:
 *   CSvgGrids for addr, hex, ascii + per-row bitmap strips + annotation arrows.
 */
export default class MemoryPageSvgView {
  _HISTORY_KEY = 'mp-address-history';
  _MAX_HISTORY = 8;

  constructor(container) {
    this._container = container;
    this._data = null;
    this._bytes = null;
    this._theme = 'dark';
    this._selectedOffset = -1;
    this._hoveredOffset = -1;
    this._categories = null;
    this._isCodePage = false;
    this._history = this._loadHistory();

    this.onNavigate = null;
    this.onClickAnnotationAddr = null;

    // dk.dll CoordinatesManager constants
    this._GW = 40; this._GH = 30; this._AW = 220; this._OX = 100; this._OY = 100;
    this._zoomScale = 1.0;
    this._buildShell();
  }

  setActive(a) { this._active = a; }
  setDisconnected() { this._renderPlaceholder('\u25C8', 'Not connected to a debug session.'); }
  setTheme(t) { this._theme = t === 'light' ? 'light' : 'dark'; if (this._data) this._render(); }

  setData(data, isCodePage = false) {
    this._data = data; this._bytes = null; this._categories = null;
    this._disasmItems = null;
    this._isCodePage = isCodePage;
    this._selectedOffset = this._hoveredOffset = -1;
    if (data?.available) {
      const h = data.bytes ?? '';
      this._bytes = new Uint8Array(0x1000);
      for (let i = 0; i < 0x1000 && i * 2 + 2 <= h.length; i++) this._bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
      this._classify();

      this._disasmItems = data.disasm ?? [];

      this._pageModule = this._resolvePageModule();
    }
    this._render();
  }

  _resolvePageModule() {
    for (const s of (this._data.annotations?.ptr2sym ?? [])) {
      const bang = (s.symbol || '').indexOf('!');
      if (bang >= 0) return s.symbol.slice(0, bang).toLowerCase();
    }
    return '';
  }

  // ---- classification (Byte2FontStyle) ----
  _classify() {
    this._categories = new Uint8Array(0x1000);
    for (let i = 0; i < 0x1000; i++) this._categories[i] = this._cat(this._bytes[i]);
  }
  _cat(b) {
    if (b === 0) return 0; if (b >= 0x61 && b <= 0x7A || b >= 0x41 && b <= 0x5A) return 1;
    if (b >= 0x30 && b <= 0x39) return 2; if (b <= 0x80) return 3; if (b <= 0xF0) return 4; return 5;
  }
  _colorNames = ['zero', 'alpha', 'numeric', 'lowAscii', 'highAscii', 'other'];

  // ---- shell ----
  _buildShell() {
    this._container.classList.add('mp-root');
    this._container.innerHTML = [
      '<div class="mp-toolbar">',
      '  <div class="mp-toolbar-row">',
      '    <form id="mp-addr-form" class="mp-addr-form">',
      '      <button id="mp-btn-prev" class="mp-btn small" type="button" title="Prev (PgUp)">\u25C0</button>',
      '      <input id="mp-addr-input" class="mp-addr-input" type="text" placeholder="0x...">',
      '      <button id="mp-btn-next" class="mp-btn small" type="button" title="Next (PgDn)">\u25B6</button>',
      '      <button id="mp-btn-go" class="mp-btn small primary" type="submit">Go</button>',
      '    </form>',
      '    <span id="mp-page-info" class="mp-page-info"></span>',
      '    <div class="mp-toolbar-spacer"></div>',
      '    <span id="mp-zoom-label" class="mp-zoom-label" title="Click to reset zoom">1.0\u00D7</span>',
      '    <input id="mp-zoom-slider" class="mp-zoom-slider" type="range" min="1" max="2" step="0.01" value="1">',
      '    <button id="mp-btn-theme" class="mp-btn small" type="button">\u263E</button>',
      '  </div>',
      '  <div id="mp-history-row" class="mp-history-row"></div>',
      '</div>',
      '<div class="mp-body">',
      '  <div id="mp-placeholder" class="mp-placeholder"><div class="mp-placeholder-icon">\u25C8</div><div>Load a page to begin.</div></div>',
      '  <svg id="mp-svg" class="mp-svg" xmlns="http://www.w3.org/2000/svg" style="display:none"></svg>',
      '  <div id="mp-detail" class="mp-detail" style="display:none"><div class="mp-detail-head">Byte Detail</div><div id="mp-detail-body" class="mp-detail-body"></div></div>',
      '</div>',
    ].join('');
    this._svgEl = this._container.querySelector('#mp-svg');
    this._placeholderEl = this._container.querySelector('#mp-placeholder');
    this._detailEl = this._container.querySelector('#mp-detail');
    this._detailBodyEl = this._container.querySelector('#mp-detail-body');
    this._addrInputEl = this._container.querySelector('#mp-addr-input');
    this._pageInfoEl = this._container.querySelector('#mp-page-info');
    this._historyRowEl = this._container.querySelector('#mp-history-row');
    this._zoomLabelEl = this._container.querySelector('#mp-zoom-label');
    this._zoomSliderEl = this._container.querySelector('#mp-zoom-slider');

    this._container.querySelector('#mp-btn-prev').addEventListener('click', () => this._step(-1));
    this._container.querySelector('#mp-btn-next').addEventListener('click', () => this._step(1));
    this._container.querySelector('#mp-addr-form').addEventListener('submit', e => { e.preventDefault(); this._goto(this._addrInputEl.value); });
    this._container.querySelector('#mp-btn-theme').addEventListener('click', () => {
      const n = this._theme === 'dark' ? 'light' : 'dark';
      this.setTheme(n);
      this._container.querySelector('#mp-btn-theme').textContent = n === 'dark' ? '\u263E' : '\u2600';
    });
    this._zoomSliderEl.addEventListener('input', () => {
      this._zoomScale = parseFloat(this._zoomSliderEl.value);
      this._applyZoom();
    });
    this._zoomLabelEl.addEventListener('click', () => { this._zoomScale = 1.0; this._applyZoom(); });
    this._container.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); this._zoom(0.25); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); this._zoom(-0.25); return; }
      if (e.key === 'PageUp') { e.preventDefault(); this._step(-1); }
      if (e.key === 'PageDown') { e.preventDefault(); this._step(1); }
    });
    const svgClick = (e) => {
      const c = e.target.closest('[data-offset]');
      if (c) this._select(parseInt(c.getAttribute('data-offset'), 10));
      const a = e.target.closest('[data-nav-addr]');
      if (a) { const addr = a.getAttribute('data-nav-addr'); if (addr) this._goto(addr); return; }
      const b = e.target.closest('[data-target-addr]');
      if (b) { const addr = b.getAttribute('data-target-addr'); if (addr) this._goto(addr); }
    };
    this._svgEl.addEventListener('click', svgClick);
    this._svgEl.addEventListener('mouseover', e => {
      const c = e.target.closest('[data-offset]');
      this._hover(c ? parseInt(c.getAttribute('data-offset'), 10) : -1);
    });
    this._svgEl.addEventListener('mouseleave', () => this._hover(-1));

    this._renderHistorySlots();
  }

  // ---- render (mirrors visual_page) ----
  _render() {
    if (!this._data?.available || !this._bytes) { this._renderPlaceholder('\u25C8', 'No page data available.'); return; }
    this._placeholderEl.style.display = 'none';
    this._svgEl.style.display = 'block';

    const S = this._data.colorScheme?.[this._theme] ?? {};
    const bg = S.bg ?? '#161b22', gridStroke = S.gridStroke ?? '#465161';
    const addrText = S.addrText ?? '#dbe3eb', hexText = S.hexText ?? '#f0f6fc';
    const asciiText = S.asciiText ?? '#b5bfca', bitOn = S.bitOn ?? '#a2adba', bitOff = S.bitOff ?? '#495666';
    const arrowC = S.arrowColor ?? '#ff938a', arrowO = S.arrowOpacity ?? 0.72;
    const localC = S.localColor ?? '#8ff79a', heapC = S.heapColor ?? '#79c0ff';
    const rectS = S.rectStroke ?? '#ff938a', rectF = S.rectFill ?? '#ff938a', rectFO = S.rectFillOpacity ?? 0.3;
    const textC = S.textColor ?? '#f0f6fc', strC = S.stringColor ?? '#ffb4ad';

    const GW = this._GW, GH = this._GH, AW = this._AW, OX = this._OX, OY = this._OY;
    const ROWS = 512, COLS = 8;
    const gridX = OX + AW; // 280
    const gridRight = gridX + COLS * GW; // 600
    const canvasW = 3000, canvasH = OY + ROWS * GH + 200;

    const NS = 'http://www.w3.org/2000/svg';
    this._svgEl.innerHTML = '';
    this._svgEl.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
    this._applyZoom();
    const mk = (t, a = {}, txt = '') => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt) e.textContent = txt; return e; };

    // Background
    this._svgEl.appendChild(mk('rect', { x: 0, y: 0, width: canvasW, height: canvasH, fill: bg, stroke: 'none' }));

    const addrBig = BigInt(this._data.pageAddr);
    const rspOff = this._data.rsp ? Number(BigInt(this._data.rsp) - addrBig) : -1;

    // ---- 1. Address grid (CSvgGrids: 1 col × 512 rows, cell 180×30, at (100, 100)) ----
    const gALines = mk('g'); const gARects = mk('g'); const gATexts = mk('g');
    gALines.setAttribute('stroke', gridStroke); gALines.setAttribute('fill', 'none');
    gATexts.setAttribute('fill', addrText); gATexts.setAttribute('font-family', 'monospace'); gATexts.setAttribute('font-size', '16');
    for (let r = 0; r <= ROWS; r++) gALines.appendChild(mk('line', { x1: OX, y1: OY + r * GH, x2: OX + AW, y2: OY + r * GH }));
    // 1 column = no vertical lines (or just the edges)
    gALines.appendChild(mk('line', { x1: OX, y1: OY, x2: OX, y2: OY + ROWS * GH }));
    gALines.appendChild(mk('line', { x1: OX + AW, y1: OY, x2: OX + AW, y2: OY + ROWS * GH }));
    for (let r = 0; r < ROWS; r++) {
      const a = addrBig + BigInt(r * 8);
      const ah = '0x' + a.toString(16).padStart(16, '0');
      const label = ah.slice(0, 10) + "'" + ah.slice(10);
      gATexts.appendChild(mk('text', { x: OX + 10, y: OY + r * GH + 20, 'font-size': '16' }, label));
    }
    this._svgEl.appendChild(gALines); this._svgEl.appendChild(gARects); this._svgEl.appendChild(gATexts);

    // ---- 2. Hex content grid (CSvgGrids: 8 cols × 512 rows, cell 40×30, at (280, 100)) ----
    const gHLines = mk('g'); const gHRects = mk('g'); const gHTexts = mk('g');
    gHLines.setAttribute('stroke', gridStroke); gHLines.setAttribute('fill', 'none');
    gHTexts.setAttribute('fill', hexText); gHTexts.setAttribute('font-family', 'monospace'); gHTexts.setAttribute('font-size', '16');
    for (let r = 0; r <= ROWS; r++) gHLines.appendChild(mk('line', { x1: gridX, y1: OY + r * GH, x2: gridRight, y2: OY + r * GH }));
    for (let c = 0; c <= COLS; c++) gHLines.appendChild(mk('line', { x1: gridX + c * GW, y1: OY, x2: gridX + c * GW, y2: OY + ROWS * GH }));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const off = r * 8 + c;
        const x = gridX + c * GW, y = OY + r * GH;
        const fill = this._data.colorScheme?.[this._theme]?.[this._colorNames[this._categories[off]]] ?? '#888';
        const isRsp = (off === rspOff);
        const selS = this._selectedOffset === off ? '#fff' : this._hoveredOffset === off ? '#aaa' : gridStroke;
        const selW = this._selectedOffset === off ? 2 : 1;
        gHRects.appendChild(mk('rect', { x, y, width: GW, height: GH, fill, stroke: isRsp ? '#ff0' : selS, 'stroke-width': isRsp ? 2 : selW, 'data-offset': off, class: 'mp-cell' + (isRsp ? ' mp-cell-rsp' : '') }));
        const hex = this._bytes[off].toString(16).toUpperCase().padStart(2, '0');
        gHTexts.appendChild(mk('text', { x: x + 10, y: y + 20, 'font-size': '16', 'pointer-events': 'none' }, hex));
      }
    }
    this._svgEl.appendChild(gHLines); this._svgEl.appendChild(gHRects); this._svgEl.appendChild(gHTexts);

    // ---- 3. ASCII grid (offset by GW*0.6, GH*0.2, i.e. +24, +6) ----
    const gALines2 = mk('g'); const gARects2 = mk('g'); const gATexts2 = mk('g');
    gATexts2.setAttribute('fill', asciiText); gATexts2.setAttribute('font-family', 'monospace'); gATexts2.setAttribute('font-size', '6');
    gATexts2.setAttribute('fill-opacity', '0.6');
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const b = this._bytes[r * 8 + c];
        const ch = (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
        gATexts2.appendChild(mk('text', { x: gridX + 24 + c * GW + 10, y: OY + 6 + r * GH + 20, 'font-size': '6' }, ch));
      }
    }
    this._svgEl.appendChild(gALines2); this._svgEl.appendChild(gARects2); this._svgEl.appendChild(gATexts2);

    // ---- 4. Bitmap overlay (per row: 1 row × 64 cols, cell 5×3.75, at gridX, OY+row*GH) ----
    const gB = mk('g');
    const bW = GW / 8, bH = GH / 8;
    for (let row = 0; row < ROWS; row++) {
      const gBLines = mk('g'); const gBRects = mk('g');
      gBLines.setAttribute('stroke', gridStroke); gBLines.setAttribute('stroke-width', '1');
      for (let i = 0; i <= 64; i++) gBLines.appendChild(mk('line', { x1: gridX + i * bW, y1: OY + row * GH, x2: gridX + i * bW, y2: OY + row * GH + bH }));
      gBLines.appendChild(mk('line', { x1: gridX, y1: OY + row * GH, x2: gridX + 64 * bW, y2: OY + row * GH }));
      gBLines.appendChild(mk('line', { x1: gridX, y1: OY + row * GH + bH, x2: gridX + 64 * bW, y2: OY + row * GH + bH }));
      for (let c = 0; c < 8; c++) {
        const b = this._bytes[row * 8 + c];
        for (let bit = 0; bit < 8; bit++) {
          const on = (b & (1 << (7 - bit))) !== 0;
          gBRects.appendChild(mk('rect', { x: gridX + (c * 8 + bit) * bW, y: OY + row * GH, width: bW, height: bH, fill: on ? bitOn : bitOff, stroke: gridStroke, 'stroke-width': '1' }));
        }
      }
      gB.appendChild(gBLines); gB.appendChild(gBRects);
    }
    this._svgEl.appendChild(gB);

    if (this._isCodePage) {
      this._renderDisasmBadges(NS, mk, addrBig, OY, GH, gridRight, this._disasmItems ?? [], textC);
    } else {
      // ---- 5. Annotations ----
      const defs = mk('defs');
      defs.appendChild(this._arrowhead(NS, 'arrowheadr', arrowC, arrowO));
      defs.appendChild(this._arrowhead(NS, 'arrowheadg', localC, arrowO));
      defs.appendChild(this._arrowhead(NS, 'arrowheadb', heapC, arrowO));
      this._svgEl.appendChild(defs);

      const gArrows = mk('g'); const gAnnot = mk('g'); const gStr = mk('g');
      gArrows.setAttribute('stroke', arrowC); gArrows.setAttribute('stroke-width', '3'); gArrows.setAttribute('stroke-opacity', arrowO);

      const ann = this._data.annotations ?? {};
      // ptr2sym
      for (const s of (ann.ptr2sym ?? [])) {
        const row = s.offset / 8 | 0, col = s.offset % 8;
        const py = OY + row * GH + GH / 2;
        const text = s.targetAddr ?? '', boxX = 1010, boxW = Math.max(180, text.length * 10 + 20);
        gArrows.appendChild(mk('line', { x1: gridRight, y1: py, x2: 1000, y2: py, 'marker-end': 'url(#arrowheadr)' }));
        const g = mk('g', { 'data-target-addr': text, class: 'mp-annot-clickable' });
        g.appendChild(mk('rect', { x: boxX, y: py - GH / 2, width: boxW, height: GH, fill: rectF, 'fill-opacity': rectFO, stroke: rectS, 'stroke-width': '2', 'data-target-addr': text }));
        g.appendChild(mk('text', { x: boxX + 10, y: py + 5, fill: textC, 'font-family': 'monospace', 'font-size': '16', 'data-target-addr': text }, text));
        if (s.symbol) gAnnot.appendChild(mk('text', { x: boxX + boxW + 30, y: py + 5, fill: strC, 'font-family': 'monospace', 'font-size': '12', 'font-style': 'italic' }, this._esc(s.symbol)));
        gAnnot.appendChild(g);
      }
      // ptr2local — two-step: red arrow → address rect, green bezier → target cell
      for (const l of (ann.ptr2local ?? [])) {
        const fr = l.fromOffset / 8 | 0, fc = l.fromOffset % 8;
        const tr = l.toOffset / 8 | 0;
        const sy = OY + fr * GH + GH / 2;
        const ey = OY + tr * GH + GH / 2;

        const targetAddr = addrBig + BigInt(l.toOffset);
        const targetText = '0x' + targetAddr.toString(16).padStart(16, '0');
        const boxX = 1010, boxW = Math.max(180, targetText.length * 10 + 20);

        gArrows.appendChild(mk('line', { x1: gridRight, y1: sy, x2: 1000, y2: sy, stroke: arrowC, 'stroke-width': '3', 'stroke-opacity': arrowO, 'marker-end': 'url(#arrowheadr)' }));

        const samePage = (targetAddr >> 12n) === (addrBig >> 12n);
        const navAttrs = samePage ? {} : { 'data-nav-addr': targetText, class: 'mp-annot-clickable' };
        gAnnot.appendChild(mk('rect', { x: boxX, y: sy - GH / 2, width: boxW, height: GH, fill: rectF, 'fill-opacity': rectFO,
          stroke: samePage ? rectS : '#5aafda', 'stroke-width': '2', ...navAttrs }));
        gAnnot.appendChild(mk('text', { x: boxX + 10, y: sy + 5, fill: textC, 'font-family': 'monospace', 'font-size': '16', ...navAttrs }, targetText));

        const diff = l.toOffset - l.fromOffset;
        const diffStr = diff >= 0 ? `+0x${diff.toString(16)}` : `-0x${(-diff).toString(16)}`;
        gAnnot.appendChild(mk('text', { x: boxX + boxW + 30, y: sy + 5, fill: localC, 'font-family': 'monospace', 'font-size': '12', 'font-style': 'italic' }, diffStr));

        const midY = (sy + ey) / 2;
        const c1x = Math.round((4000 + gridRight) / 5);
        const c2x = Math.round((1000 + gridRight) / 2);
        const tc = l.toOffset % 8;
        const tgtX = gridX + (tc + 1) * GW;
        gArrows.appendChild(mk('path', { d: `M${1000 - GW},${sy} C${c1x},${sy} ${c2x},${midY} ${gridRight},${ey}`, fill: 'none', stroke: localC, 'stroke-width': '3', 'stroke-opacity': arrowO, 'marker-end': 'url(#arrowheadg)' }));
      }
      // ptr2heap
      for (const h of (ann.ptr2heap ?? [])) {
        const row = h.offset / 8 | 0, col = h.offset % 8;
        const py = OY + row * GH + GH / 2;
        const addr = h.targetAddr ?? '';
        const boxX = 1010, boxW = Math.max(160, addr.length * 10 + 20);
        gArrows.appendChild(mk('line', { x1: gridRight, y1: py, x2: 1000, y2: py, stroke: heapC, 'stroke-opacity': '0.8', 'marker-end': 'url(#arrowheadb)' }));
        const g = mk('g', { 'data-target-addr': addr, class: 'mp-annot-clickable' });
        g.appendChild(mk('rect', { x: boxX, y: py - GH / 2, width: boxW, height: GH, fill: heapC, 'fill-opacity': '0.2', stroke: heapC, 'stroke-width': '2', 'data-target-addr': addr }));
        g.appendChild(mk('text', { x: boxX + 10, y: py + 5, fill: heapC, 'font-family': 'monospace', 'font-size': '16', 'data-target-addr': addr }, addr));
        if (h.heapSize) gAnnot.appendChild(mk('text', { x: boxX + boxW + 30, y: py + 5, fill: strC, 'font-family': 'monospace', 'font-size': '12' }, `heap 0x${h.heapSize.toString(16)}`));
        gAnnot.appendChild(g);
      }
      // string annotations
      const strMap = new Map();
      for (const s of (ann.ptr2astr ?? [])) {
        const k = s.offset & ~7; if (!strMap.has(k)) strMap.set(k, []); strMap.get(k).push(`"${s.text}"`);
      }
      for (const s of (ann.ptr2ustr ?? [])) {
        const k = s.offset & ~7; if (!strMap.has(k)) strMap.set(k, []); strMap.get(k).push(`L"${s.text.substring(0, 40)}"`);
      }
      for (const [off, texts] of strMap) {
        const row = off / 8 | 0;
        gStr.appendChild(mk('text', { x: 1400, y: OY + row * GH + GH / 2 + 5, fill: strC, 'font-family': 'monospace', 'font-size': '12', 'font-style': 'italic' }, texts.join(' | ')));
      }

      this._svgEl.appendChild(gArrows); this._svgEl.appendChild(gAnnot); this._svgEl.appendChild(gStr);
    }

    // Toolbar
    this._addrInputEl.value = this._data.pageAddr;
    const perm = this._data.sectionPermission || 'none';
    this._pageInfoEl.textContent = `RSP: ${this._data.rsp || '(none)'} · PE perm: ${perm}`;
  }

  // ---- render disasm badges (code-page right-side) ----
  _renderDisasmBadges(NS, mk, addrBig, OY, GH, gridRight, disasm, textC) {
    const rowMap = new Map();
    for (const insn of disasm) {
      const row = insn.offset / 8 | 0;
      if (!rowMap.has(row)) rowMap.set(row, []);
      rowMap.get(row).push(insn);
    }

    const BADGE_X = gridRight + 40;
    const g = mk('g');

    for (const [row, insns] of rowMap) {
      const py = OY + row * GH + GH / 2;
      let cx = BADGE_X;

      for (let ii = 0; ii < insns.length; ii++) {
        if (ii > 0) {
          g.appendChild(mk('text', { x: cx, y: py + 5, fill: '#555', 'font-family': 'monospace', 'font-size': '14' }, '\u00A6'));
          cx += 20;
        }

        const insn = insns[ii];
        const text = String(insn.text ?? '').trimStart();
        const parsed = this._parseInstr(text);
        if (!parsed.opcode) continue;

        // Opcode badge
        const opColors = this._opcodeBadgeColors(parsed.opcode);
        const ow = Math.max(30, parsed.opcode.length * 10 + 16);
        g.appendChild(mk('rect', { x: cx, y: py - GH / 2 + 2, width: ow, height: GH - 4,
          fill: opColors.fill, stroke: opColors.stroke, 'stroke-width': '1.5', rx: '3', ry: '3' }));
        g.appendChild(mk('text', { x: cx + 8, y: py + 5, fill: opColors.text, 'font-family': 'monospace', 'font-size': '13' }, parsed.opcode));
        cx += ow + 4;

        // Operand badges
        for (const op of parsed.operands) {
          const info = this._classifyOperand(op);
          const colors = this._operandBadgeColors(info.type);
          const bw = Math.max(30, info.text.length * 10 + 16);

          const rectAttrs = { x: cx, y: py - GH / 2 + 2, width: bw, height: GH - 4,
            fill: colors.fill, stroke: colors.stroke, 'stroke-width': '1.5', rx: '3', ry: '3' };

          if (info.addr) {
            const tg = mk('g', { class: 'mp-annot-clickable', 'data-nav-addr': info.addr });
            tg.appendChild(mk('title', {}, `Navigate to ${info.addr}`));
            tg.appendChild(mk('rect', rectAttrs));
            tg.appendChild(mk('text', { x: cx + 8, y: py + 5, fill: colors.text, 'font-family': 'monospace', 'font-size': '13' }, info.text));
            g.appendChild(tg);
          } else {
            g.appendChild(mk('rect', rectAttrs));
            g.appendChild(mk('text', { x: cx + 8, y: py + 5, fill: colors.text, 'font-family': 'monospace', 'font-size': '13' }, info.text));
          }
          cx += bw + 4;
        }
      }
    }
    this._svgEl.appendChild(g);
  }

  // ---- Disassembly parsing ----

  _parseInstr(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return { opcode: '', operands: [] };
    const tokens = trimmed.split(/\s+/);
    let i = 0;
    if (i < tokens.length && /^(?:0x)?[0-9a-fA-F]+['`][0-9a-fA-F]+$/.test(tokens[i])) i++;
    while (i < tokens.length && /^[0-9a-fA-F]+$/.test(tokens[i])) i++;
    if (i >= tokens.length) return { opcode: '', operands: [] };
    const opcode = tokens[i];
    const rest = tokens.slice(i + 1).join(' ').trim();
    const operands = this._splitOperands(rest);
    return { opcode, operands };
  }

  _splitOperands(str) {
    if (!str) return [];
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '(' || c === '[' || c === '<') depth++;
      else if (c === ')' || c === ']' || c === '>') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(str.slice(start).trim());
    return parts.filter(p => p.length > 0);
  }

  _classifyOperand(op) {
    const addr = this._extractNavigableAddress(op);
    if (addr) return { type: /[a-z]+![a-z_]/i.test(op) ? 'sym' : 'addr', text: op, addr };
    if (/[a-z]+![a-z_]/i.test(op)) return { type: 'sym', text: op, addr: null };
    return { type: 'other', text: op };
  }

  _extractNavigableAddress(op) {
    const text = String(op ?? '').trim();
    if (!text) return null;

    const candidates = [];
    const hexMatches = text.match(/0x[0-9a-fA-F`]+/g) ?? [];
    const dbgMatches = text.match(/\b[0-9a-fA-F]{1,8}`[0-9a-fA-F]{1,16}\b/g) ?? [];
    const plainMatches = text.match(/\b[0-9a-fA-F]{8,16}\b/g) ?? [];
    candidates.push(...hexMatches, ...dbgMatches, ...plainMatches);

    for (const candidate of candidates) {
      const normalized = this._normalizeAddressCandidate(candidate);
      if (!normalized) continue;
      if (this._isNavigableAddress(normalized)) return normalized;
    }
    return null;
  }

  _normalizeAddressCandidate(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const compact = raw.replace(/`/g, '');
    const body = compact.replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]+$/.test(body)) return null;
    return '0x' + body.toLowerCase();
  }

  _isNavigableAddress(addrText) {
    try {
      const value = BigInt(addrText);
      if (value === 0n || value === 1n) return false;
      if (value === 0xFFFFFFFFn || value === 0xFFFFFFFFFFFFFFFFn) return false;
      return value >= 0x0000000000010000n && value <= 0x00007FFFFFFFFFFFn;
    } catch {
      return false;
    }
  }

  _opcodeBadgeColors(opcode) {
    const op = opcode.toLowerCase();
    if (op === 'call')   return { fill: 'rgba(255,68,68,0.15)',    stroke: 'rgba(255,68,68,0.45)',    text: '#ff4444' };
    if (op === 'ret' || op === 'retn') return { fill: 'rgba(197,134,192,0.15)', stroke: 'rgba(197,134,192,0.45)', text: '#c586c0' };
    if (/^j(mp|[a-z])/.test(op)) return { fill: 'rgba(255,169,77,0.15)', stroke: 'rgba(255,169,77,0.45)', text: '#ffa94d' };
    if (op === 'push' || op === 'pop') return { fill: 'rgba(86,156,214,0.15)', stroke: 'rgba(86,156,214,0.45)', text: '#569cd6' };
    if (op === 'cmp' || op === 'test')  return { fill: 'rgba(220,220,170,0.15)', stroke: 'rgba(220,220,170,0.45)', text: '#dcdcaa' };
    if (op === 'int' || op === 'syscall') return { fill: 'rgba(244,71,71,0.15)', stroke: 'rgba(244,71,71,0.45)', text: '#f44747' };
    if (op === 'nop') return { fill: 'rgba(106,153,85,0.15)',   stroke: 'rgba(106,153,85,0.45)',   text: '#6a9955' };
    return { fill: 'rgba(79,193,255,0.15)',  stroke: 'rgba(79,193,255,0.40)',  text: '#4fc1ff' };
  }

  _operandBadgeColors(type) {
    if (type === 'addr') return { fill: 'rgba(206,145,120,0.15)', stroke: 'rgba(206,145,120,0.45)', text: '#ce9178' };
    if (type === 'sym')  return { fill: 'rgba(197,134,192,0.15)', stroke: 'rgba(197,134,192,0.45)', text: '#c586c0' };
    return { fill: 'rgba(138,200,184,0.12)', stroke: 'rgba(138,200,184,0.30)', text: '#8ac8b8' };
  }

  _arrowhead(NS, id, color, opacity) {
    const m = document.createElementNS(NS, 'marker');
    m.setAttribute('id', id); m.setAttribute('viewBox', '0 0 10 7'); m.setAttribute('refX', '10'); m.setAttribute('refY', '3.5');
    m.setAttribute('markerWidth', '10'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto');
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', '0 0, 10 3.5, 0 7'); p.setAttribute('fill', color); p.setAttribute('fill-opacity', opacity); p.setAttribute('stroke', 'none');
    m.appendChild(p); return m;
  }

  // ---- interactivity ----
  _hover(off) { if (this._hoveredOffset === off) return; this._hoveredOffset = off; this._render(); }
  _select(off) {
    if (this._selectedOffset === off) { this._selectedOffset = -1; this._detailEl.style.display = 'none'; }
    else { this._selectedOffset = off; this._updateDetail(off); this._detailEl.style.display = 'block'; }
    this._render();
  }
  _updateDetail(off) {
    if (!this._bytes || off < 0 || off >= 0x1000) return;
    const a = BigInt(this._data.pageAddr) + BigInt(off);
    const b = this._bytes[off];
    let q = ''; for (let i = 7; i >= 0; i--) q += (this._bytes[off + i] ?? 0).toString(16).padStart(2, '0').toUpperCase();
    this._detailBodyEl.innerHTML = [
      `<div class="mp-detail-row"><span class="mp-detail-key">Offset</span><span>0x${off.toString(16).padStart(3, '0')}</span></div>`,
      `<div class="mp-detail-row"><span class="mp-detail-key">Address</span><span>0x${a.toString(16).padStart(16, '0')}</span></div>`,
      `<div class="mp-detail-row"><span class="mp-detail-key">Byte</span><span>0x${b.toString(16).padStart(2, '0').toUpperCase()} (${b})</span></div>`,
      `<div class="mp-detail-row"><span class="mp-detail-key">Category</span><span>${this._colorNames[this._categories[off]]}</span></div>`,
      `<div class="mp-detail-row"><span class="mp-detail-key">Binary</span><span>${b.toString(2).padStart(8, '0')}</span></div>`,
      `<div class="mp-detail-row"><span class="mp-detail-key">As Qword</span><span>0x${q}</span></div>`,
    ].join('');
  }

  _step(d) { if (!this._data?.pageAddr) return; try { const n = BigInt(this._data.pageAddr) + BigInt(d) * 0x1000n; if (n >= 0n) this._goto('0x' + n.toString(16)); } catch {} }
  _goto(r) { const t = String(r ?? '').trim(); if (!t) return; try { BigInt(t); this._recordHistory(t); if (this.onNavigate) this.onNavigate(t); } catch {} }
  _renderPlaceholder(icon, text) {
    this._placeholderEl.style.display = 'flex'; this._svgEl.style.display = 'none'; this._detailEl.style.display = 'none';
    const i = this._placeholderEl.querySelector('.mp-placeholder-icon'); if (i) i.textContent = icon;
    const t = i?.nextElementSibling; if (t) t.textContent = text;
  }
  _esc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  _zoom(delta) {
    const next = Math.min(2.0, Math.max(1.0, this._zoomScale + delta));
    if (next === this._zoomScale) return;
    this._zoomScale = next;
    this._applyZoom();
  }
  _applyZoom() {
    this._svgEl.style.width = (100 * this._zoomScale) + '%';
    this._svgEl.style.height = 'auto';
    if (this._zoomLabelEl) this._zoomLabelEl.textContent = this._zoomScale.toFixed(2) + '\u00D7';
    if (this._zoomSliderEl) this._zoomSliderEl.value = this._zoomScale;
  }

  _loadHistory() {
    try { const raw = localStorage.getItem(this._HISTORY_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
  }
  _recordHistory(addr) {
    this._history = this._history.filter(a => a !== addr);
    this._history.unshift(addr);
    if (this._history.length > this._MAX_HISTORY) this._history.length = this._MAX_HISTORY;
    try { localStorage.setItem(this._HISTORY_KEY, JSON.stringify(this._history)); } catch {}
    this._renderHistorySlots();
  }
  _renderHistorySlots() {
    if (!this._historyRowEl) return;
    const len = this._history.length;
    this._historyRowEl.innerHTML = this._history.map((addr, i) => {
      const isCurrent = i === 0;
      const cls = 'mp-history-slot mp-btn small' + (isCurrent ? ' mp-history-slot-current' : '');
      const opacity = isCurrent ? 1 : Math.max(0.35, 1 - (i / (len || 1)) * 0.65);
      return `<button class="${cls}" data-addr="${addr}" title="${addr}" style="opacity:${opacity.toFixed(2)}">${addr}</button>`;
    }).join('');
    this._historyRowEl.querySelectorAll('.mp-history-slot').forEach(btn => {
      btn.addEventListener('click', () => this._goto(btn.dataset.addr));
    });
  }
}
