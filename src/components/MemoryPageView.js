/**
 * MemoryPageView - DOM text rendering of a memory page analysis result.
 *
 * The old canvas path made monospace text look soft in the right dock because
 * it was rasterized into an image. This version renders native HTML rows so
 * browser text remains crisp at all zoom levels.
 */

const QWORDS = 512; // 4096 / 8

export default class MemoryPageView {
  constructor(container, options = {}) {
    this._container = container;
    this._autoScrollToRsp = options.autoScrollToRsp !== false;
    this._data = null;
    this._bytes = null;
    this._isCodePage = false;
    this._pendingScrollFrame = null;
    this._renderVersion = 0;

    this._symMap = new Map();
    this._localMap = new Map();
    this._heapMap = new Map();
    this._astrMap = new Map();
    this._ustrMap = new Map();
    this._disasmByOffset = null;
  }

  setData(pageData, isCodePage = false) {
    this._data = pageData;

    this._symMap.clear();
    this._localMap.clear();
    this._heapMap.clear();
    this._astrMap.clear();
    this._ustrMap.clear();
    this._bytes = null;
    this._isCodePage = isCodePage;
    this._disasmByOffset = null;

    if (pageData?.available) {
      const hex = pageData.bytes ?? '';
      this._bytes = new Uint8Array(0x1000);
      for (let i = 0; i < 0x1000 && (i * 2 + 2) <= hex.length; i++) {
        this._bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }

      // Read annotations from nested path (new code/data-split endpoints),
      // falling back to flat properties (legacy /api/page endpoint).
      const ann = pageData.annotations ?? {};
      const syms = ann.ptr2sym ?? pageData.ptr2sym ?? [];
      const locals = ann.ptr2local ?? pageData.ptr2local ?? [];
      const heaps = ann.ptr2heap ?? pageData.ptr2heap ?? [];
      const astrs = ann.ptr2astr ?? pageData.ptr2astr ?? [];
      const ustrs = ann.ptr2ustr ?? pageData.ptr2ustr ?? [];

      this._symMap = new Map(syms.map((entry) => [entry.offset, entry]));
      this._localMap = new Map(locals.map((entry) => [entry.fromOffset, entry]));
      this._heapMap = new Map(heaps.map((entry) => [entry.offset, entry]));
      this._pageModule = this._resolvePageModule();

      for (const entry of astrs) {
        const aligned = entry.offset & ~7;
        if (!this._astrMap.has(aligned)) this._astrMap.set(aligned, entry.text);
      }
      for (const entry of ustrs) {
        const aligned = entry.offset & ~7;
        if (!this._ustrMap.has(aligned)) this._ustrMap.set(aligned, entry.text);
      }

      if (isCodePage) {
        const disasm = pageData.disasm ?? [];
        this._disasmByOffset = new Map();
        for (const insn of disasm) {
          this._disasmByOffset.set(insn.offset, insn);
        }
      }
    }

    this._render();
  }

  resize() {
    // Native DOM layout handles sizing; kept for API compatibility.
  }

  _scheduleScrollTop(targetTop) {
    if (this._pendingScrollFrame != null) {
      cancelAnimationFrame(this._pendingScrollFrame);
    }

    this._pendingScrollFrame = requestAnimationFrame(() => {
      this._container.scrollTop = targetTop;
      this._pendingScrollFrame = null;
    });
  }

  _scheduleScrollToElement(rowElement, alignRatio = 0.33) {
    if (!rowElement) {
      this._scheduleScrollTop(0);
      return;
    }

    const renderVersion = this._renderVersion;
    if (this._pendingScrollFrame != null) {
      cancelAnimationFrame(this._pendingScrollFrame);
    }

    this._pendingScrollFrame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (renderVersion !== this._renderVersion || !rowElement.isConnected) {
          this._pendingScrollFrame = null;
          return;
        }

        const containerRect = this._container.getBoundingClientRect();
        const rowRect = rowElement.getBoundingClientRect();
        const rowTopInContainer = rowRect.top - containerRect.top + this._container.scrollTop;
        const targetTop = rowTopInContainer - (this._container.clientHeight * alignRatio) + (rowRect.height / 2);
        const maxScrollTop = Math.max(0, this._container.scrollHeight - this._container.clientHeight);

        this._container.scrollTop = Math.max(0, Math.min(Math.round(targetTop), maxScrollTop));
        this._pendingScrollFrame = null;
      });
    });
  }

  _resolvePageModule() {
    for (const entry of this._symMap.values()) {
      const bang = entry.symbol.indexOf('!');
      if (bang >= 0) return entry.symbol.slice(0, bang).toLowerCase();
    }
    return '';
  }

  _parseDisasmParts(text) {
    const tokens = text.trim().split(/\s+/);
    if (!tokens.length) return [];
    let i = 0;
    if (i < tokens.length && /^(?:0x)?[0-9a-fA-F]+['`][0-9a-fA-F]+$/.test(tokens[i])) i++;
    while (i < tokens.length && /^[0-9a-fA-F]+$/.test(tokens[i])) i++;
    if (i >= tokens.length) return [];
    const opcode = tokens[i];
    const rest = tokens.slice(i + 1).join(' ').trim();
    if (!rest) return [opcode];
    const operands = rest.split(',').map(s => s.trim()).filter(Boolean);
    return [opcode, ...operands];
  }

  _getAnnotation(offset) {
    const symbol = this._symMap.get(offset);
    if (symbol) return { kind: 'sym', text: symbol.symbol };

    const local = this._localMap.get(offset);
    if (local) {
      return { kind: 'local', text: `\u2192 +0x${local.toOffset.toString(16).padStart(3, '0')}` };
    }

    const heap = this._heapMap.get(offset);
    if (heap) {
      return { kind: 'heap', text: `heap 0x${heap.heapSize.toString(16)} (${heap.heapBase})` };
    }

    const ascii = this._astrMap.get(offset);
    if (ascii) return { kind: 'str', text: `"${ascii.slice(0, 120)}"` };

    const unicode = this._ustrMap.get(offset);
    if (unicode) return { kind: 'str', text: `L"${unicode.slice(0, 120)}"` };

    return null;
  }

  _getDisasmAnnotationsForQword(offset) {
    if (!this._disasmByOffset) return null;
    const parts = [];
    for (let b = 0; b < 8; b++) {
      const insn = this._disasmByOffset.get(offset + b);
      if (!insn) continue;
      const text = String(insn.text ?? '').trimStart();
      const tokenParts = this._parseDisasmParts(text);
      parts.push({ insn, text, tokenParts });
    }
    return parts.length ? parts : null;
  }

  _highlightBytes(hexEl, offset) {
    if (!this._bytes) return;

    let html = '';
    for (let b = 0; b < 8; b++) {
      const byteOff = offset + b;
      const val = this._bytes[byteOff];
      html += val.toString(16).padStart(2, '0').toUpperCase();
    }
    hexEl.innerHTML = html;
  }

  _render() {
    this._renderVersion += 1;
    this._container.replaceChildren();

    if (!this._data?.available) {
      const empty = document.createElement('div');
      empty.className = 'page-empty';
      empty.textContent = '\u2014';
      this._container.appendChild(empty);
      return;
    }

    if (this._isCodePage) {
      this._renderCodePage();
      return;
    }

    const fragment = document.createDocumentFragment();
    const pageAddrBig = BigInt(this._data.pageAddr);
    const rspBig = this._data.rsp ? BigInt(this._data.rsp) : null;
    const rspOff = rspBig != null ? Number(rspBig - pageAddrBig) : -1;
    const rspRow = (rspOff >= 0 && rspOff < 0x1000) ? Math.floor(rspOff / 8) : -1;
    let rspRowElement = null;

    for (let rowIndex = 0; rowIndex < QWORDS; rowIndex++) {
      const offset = rowIndex * 8;
      const annotation = this._getAnnotation(offset);
      const row = document.createElement('div');
      row.className = 'page-row';
      if (annotation) row.classList.add(`page-row-${annotation.kind}`);
      if (rowIndex === rspRow) {
        row.classList.add('page-row-rsp');
        rspRowElement = row;
      }

      const addr = document.createElement('span');
      addr.className = 'page-cell page-addr';
      addr.textContent = `0x${(pageAddrBig + BigInt(offset)).toString(16).padStart(12, '0')}`;

      const hex = document.createElement('span');
      hex.className = 'page-cell page-hex';
      this._highlightBytes(hex, offset);

      const annot = document.createElement('span');
      annot.className = 'page-cell page-annot';
      annot.textContent = annotation?.text ?? '';
      if (annotation?.text) annot.title = annotation.text;

      row.append(addr, hex, annot);
      fragment.appendChild(row);
    }

    this._container.appendChild(fragment);

    if (this._autoScrollToRsp && rspRowElement) {
      this._scheduleScrollToElement(rspRowElement, 0.33);
    } else {
      this._scheduleScrollTop(0);
    }
  }

  _renderCodePage() {
    const fragment = document.createDocumentFragment();
    const rspRow = -1;
    let rspRowElement = null;

    for (let rowIndex = 0; rowIndex < QWORDS; rowIndex++) {
      const disasmParts = this._getDisasmAnnotationsForQword(rowIndex * 8);
      const row = document.createElement('div');
      row.className = 'page-row page-row-code';
      if (disasmParts) row.classList.add('page-row-call');

      const annot = document.createElement('span');
      annot.className = 'page-cell page-annot';

      if (disasmParts) {
        for (let di = 0; di < disasmParts.length; di++) {
          if (di > 0) {
            const sep = document.createElement('span');
            sep.className = 'page-disasm-sep';
            sep.textContent = ' \u00A6 ';
            annot.appendChild(sep);
          }

          const { tokenParts } = disasmParts[di];
          for (let ti = 0; ti < tokenParts.length; ti++) {
            const p = tokenParts[ti];
            const isOpcode = ti === 0;
            const tag = document.createElement('span');
            if (isOpcode) {
              tag.className = 'page-disasm-tag page-disasm-opcode';
            } else {
              tag.className = 'page-disasm-tag page-disasm-operand';
            }
            tag.textContent = p;
            annot.appendChild(tag);
          }
        }
      }

      row.append(annot);
      fragment.appendChild(row);
    }

    this._container.appendChild(fragment);

    if (this._autoScrollToRsp && rspRowElement) {
      this._scheduleScrollToElement(rspRowElement, 0.33);
    } else {
      this._scheduleScrollTop(0);
    }
  }
}
