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
    this._pendingScrollFrame = null;
    this._renderVersion = 0;

    this._symMap = new Map();
    this._localMap = new Map();
    this._heapMap = new Map();
    this._astrMap = new Map();
    this._ustrMap = new Map();
    this._callMap = new Map();
    this._callByteOffsets = new Set();
  }

  setData(pageData) {
    this._data = pageData;

    this._symMap.clear();
    this._localMap.clear();
    this._heapMap.clear();
    this._astrMap.clear();
    this._ustrMap.clear();
    this._callMap.clear();
    this._callByteOffsets.clear();
    this._bytes = null;

    if (pageData?.available) {
      const hex = pageData.bytes ?? '';
      this._bytes = new Uint8Array(0x1000);
      for (let i = 0; i < 0x1000 && (i * 2 + 2) <= hex.length; i++) {
        this._bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }

      this._symMap = new Map((pageData.ptr2sym ?? []).map((entry) => [entry.offset, entry]));
      this._localMap = new Map((pageData.ptr2local ?? []).map((entry) => [entry.fromOffset, entry]));
      this._heapMap = new Map((pageData.ptr2heap ?? []).map((entry) => [entry.offset, entry]));

      this._pageModule = this._resolvePageModule();

      for (const entry of (pageData.ptr2astr ?? [])) {
        const aligned = entry.offset & ~7;
        if (!this._astrMap.has(aligned)) this._astrMap.set(aligned, entry.text);
      }
      for (const entry of (pageData.ptr2ustr ?? [])) {
        const aligned = entry.offset & ~7;
        if (!this._ustrMap.has(aligned)) this._ustrMap.set(aligned, entry.text);
      }

      for (const entry of (pageData.ptr2call ?? [])) {
        this._callMap.set(entry.offset, entry);
        const len = entry.instrLen || 5;
        for (let j = 0; j < len; j++) {
          this._callByteOffsets.add(entry.offset + j);
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

  _readQword(offset) {
    if (!this._bytes) return '????????????????';

    let hi = 0;
    let lo = 0;
    for (let byteIndex = 7; byteIndex >= 4; byteIndex--) hi = (hi * 256 + this._bytes[offset + byteIndex]) >>> 0;
    for (let byteIndex = 3; byteIndex >= 0; byteIndex--) lo = (lo * 256 + this._bytes[offset + byteIndex]) >>> 0;
    return hi.toString(16).padStart(8, '0').toUpperCase()
      + lo.toString(16).padStart(8, '0').toUpperCase();
  }

  _resolvePageModule() {
    for (const entry of this._symMap.values()) {
      const bang = entry.symbol.indexOf('!');
      if (bang >= 0) return entry.symbol.slice(0, bang).toLowerCase();
    }
    return '';
  }

  _getAnnotation(offset) {
    for (let b = 0; b < 8; b++) {
      const call = this._callMap.get(offset + b);
      if (call) {
        const kind = call.kind || 'call';
        const label = `${kind} \u2192 ${call.targetAddr || ''}`;
        const sym = call.symbol || '';
        const isJmp = kind === 'jmp' || kind === 'jmp8';
        const callMod = sym ? (() => { const b = sym.indexOf('!'); return b >= 0 ? sym.slice(0, b).toLowerCase() : ''; })() : '';
        const isXMod = callMod && this._pageModule && callMod !== this._pageModule;
        return { kind: 'call', text: label, sym, isJmp, isXMod };
      }
    }

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

  _highlightBytes(hexEl, offset) {
    if (!this._bytes) return;

    let html = '';
    for (let b = 0; b < 8; b++) {
      const byteOff = offset + b;
      const val = this._bytes[byteOff];
      const hex = val.toString(16).padStart(2, '0').toUpperCase();
      if (this._callByteOffsets.has(byteOff)) {
        html += `<span class="phl-call">${hex}</span>`;
      } else {
        html += hex;
      }
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

      if (annotation?.kind === 'call') {
        const tag = document.createElement('span');
        tag.className = 'page-call-tag';
        if (annotation.isJmp) tag.classList.add('page-call-jmp');
        if (annotation.isXMod) tag.classList.add('page-call-xmod');
        tag.textContent = annotation.text;
        tag.title = annotation.text;
        annot.appendChild(tag);

        if (annotation.sym) {
          const symText = document.createElement('span');
          symText.className = 'page-call-sym';
          symText.textContent = ' ' + annotation.sym;
          symText.title = annotation.sym;
          annot.appendChild(symText);
        }
      } else {
        annot.textContent = annotation?.text ?? '';
        if (annotation?.text) annot.title = annotation.text;
      }

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
}
