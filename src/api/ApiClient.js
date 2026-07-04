const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_MS = 300;

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * ApiClient — base HTTP client for the dk embedded server.
 *
 * Features:
 * - X-Request-ID header on every request
 * - AbortController-based timeout
 * - Retry with exponential back-off (network errors and 5xx only)
 * - In-flight request dedup: concurrent calls to the same URL share one Promise
 * - Structured ApiError from the server's error envelope
 */
export default class ApiClient {
  constructor(baseUrl = '/api') {
    this._baseUrl = baseUrl;
    this._queue = [];           // { id, fn, resolve, reject, priority, label, path }
    this._processing = false;
    this._activeController = null;
    this._activeLabel = '';     // label of currently-processing item (for debug UI)
    this._activeStart = 0;      // timestamp when current item started
    this._nextId = 1;
    this._history = [];         // [{ id, label, priority, path, startTime, endTime, elapsedMs, status, error? }]
  }

  /**
   * Cancel all queued (not-yet-started) requests. Does NOT abort the
   * currently-processing request — the single-threaded dk server cannot
   * handle abrupt connection teardown and will crash.
   *
   * Call before starting a priority operation, then call waitForIdle()
   * to let the active request finish naturally.
   */
  drainQueue(reason = 'queue drained') {
    const now = Date.now();
    for (const item of this._queue) {
      item.reject(new ApiError('CANCELLED', reason, 0));
      this._addHistory(item, 'cancelled', now, now, reason);
    }
    this._queue = [];
  }

  _addHistory(item, status, startTime, endTime, detail = '') {
    const entry = {
      id: item.id,
      label: item.label,
      priority: item.priority,
      path: item._path || item.label || '',
      startTime,
      endTime,
      elapsedMs: endTime - startTime,
      status,
      detail,
    };
    this._history.push(entry);
    if (this._history.length > 200) this._history.shift();
  }

  /**
   * Return current queue state for debugging/visualization.
   */
  dumpQueueState() {
    return {
      processing: this._processing,
      queueLength: this._queue.length,
      activeAborted: this._activeController?.signal?.aborted ?? false,
      activeLabel: this._activeLabel,
      activeStart: this._activeStart,
      items: this._queue.map(item => ({
        id: item.id,
        label: item.label,
        _path: item._path || item.label,
        priority: item.priority,
      })),
      history: [...this._history],
    };
  }

  /**
   * Returns a promise that resolves when the queue is fully idle:
   * no item currently processing and no items waiting.
   * Use before enqueuing a priority request to ensure no contending
   * requests are in flight (critical for the single-threaded dk server).
   */
  async waitForIdle(timeoutMs = 5000) {
    if (!this._processing && this._queue.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (this._processing) {
      if (Date.now() >= deadline) {
        console.warn('[ApiClient] waitForIdle timed out — proceeding anyway');
        break;
      }
      await new Promise(r => setTimeout(r, 5));
    }
  }

  /** Enqueue a request. priority: 'normal' (default) or 'high'. */
  _enqueue(fn, { priority = 'normal', label = '' } = {}) {
    return new Promise((resolve, reject) => {
      const item = { id: this._nextId++, fn, resolve, reject, priority, label };
      if (priority === 'high') {
        // Insert after any currently-processing item, before other queued items
        const firstNormal = this._queue.findIndex(i => i.priority !== 'high');
        if (firstNormal >= 0) {
          this._queue.splice(firstNormal, 0, item);
        } else {
          this._queue.push(item);
        }
      } else {
        this._queue.push(item);
      }
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      this._activeController = new AbortController();
      this._activeLabel = item.label;
      this._activeStart = Date.now();
      try {
        const result = await item.fn(this._activeController.signal);
        item.resolve(result);
        this._addHistory(item, 'ok', this._activeStart, Date.now());
      } catch (err) {
        item.reject(err);
        this._addHistory(item, 'error', this._activeStart, Date.now(),
          err.message || err.code || String(err));
      } finally {
        this._activeController = null;
        this._activeLabel = '';
      }
    }
    this._processing = false;
  }

  // ---- public route methods -----------------------------------------------

  getServerStatus() {
    return this._request('/server/status');
  }

  getCallstack({ major, minor, threadId } = {}) {
    const parts = [];
    if (major != null) parts.push(`major=${encodeURIComponent(String(major))}`);
    if (minor != null) parts.push(`minor=${encodeURIComponent(String(minor))}`);
    if (threadId != null) {
      parts.push(`thread_id=${encodeURIComponent(String(threadId))}`);
      parts.push(`threadId=${encodeURIComponent(String(threadId))}`);
    }
    return this._request(`/callstack?${parts.join('&')}`, {
      maxRetries: 0,
      timeoutMs: 10000,
      dedupe: false,
    });
  }

  getPageSvg({ major, minor, threadId, address, dark = true } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    if (address) parts.push(`address=${encodeURIComponent(String(address))}`);
    if (!dark) parts.push('dark=0');
    return this._requestText(`/page/svg?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000 });
  }

  getRegisters({ major, minor, threadId } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    return this._request(`/registers?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000, dedupe: false });
  }

  getPage({ major, minor, threadId, address } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    if (address) parts.push(`address=${encodeURIComponent(String(address))}`);
    return this._request(`/page?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000, dedupe: false });
  }

  getPageRender({ major, minor, threadId, address } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    if (address) parts.push(`address=${encodeURIComponent(String(address))}`);
    return this._request(`/page/render?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000, dedupe: false });
  }

  // Code-page render: returns bytes + disasm only, no annotations.
  // The frontend is expected to have already determined the page type
  // (via PE-section inspection) before calling this.
  getPageRenderCode({ major, minor, threadId, address } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    if (address) parts.push(`address=${encodeURIComponent(String(address))}`);
    return this._request(`/page/render/code?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000, dedupe: false });
  }

  // Data-page render: returns bytes + annotations only, no disasm.
  getPageRenderData({ major, minor, threadId, address } = {}) {
    const parts = [];
    if (major != null) { parts.push(`major=${encodeURIComponent(String(major))}`); parts.push(`minor=${encodeURIComponent(String(minor ?? 0))}`); }
    if (threadId != null) { parts.push(`thread_id=${encodeURIComponent(String(threadId))}`); parts.push(`threadId=${encodeURIComponent(String(threadId))}`); }
    if (address) parts.push(`address=${encodeURIComponent(String(address))}`);
    return this._request(`/page/render/data?${parts.join('&')}`, { maxRetries: 0, timeoutMs: 10000, dedupe: false });
  }

  getMemory({ start, end } = {}) {
    return this._request(`/memory?start=${encodeURIComponent(String(start ?? '0x0'))}&end=${encodeURIComponent(String(end ?? '0xFFFFFFFFFFFFFFFF'))}`, { maxRetries: 0, timeoutMs: 60000, dedupe: false });
  }

  getEvents({ startTime, endTime, type } = {}) {
    let url = `/events?start_time=${encodeURIComponent(String(startTime ?? 0))}&end_time=${encodeURIComponent(String(endTime ?? 10000))}`;
    if (type) url += `&type=${encodeURIComponent(String(type))}`;
    return this._request(url, { maxRetries: 0, timeoutMs: 30000, dedupe: false });
  }

  getTraceInfo() {
    return this._request('/ttd/trace-info');
  }

  getModules() {
    return this._request('/ttd/modules');
  }

  getThreads() {
    return this._request('/ttd/threads');
  }

  getMemoryLayout() {
    return this._request('/memory/layout');
  }

  getEnvironment() {
    return this._request('/environment');
  }

  getPe(imageBase = '') {
    const suffix = imageBase ? `?imageBase=${encodeURIComponent(String(imageBase).trim())}` : '';
    return this._request(`/pe${suffix}`);
  }

  getMemAccess({ startAddr, endAddr, mode = 'W',
                 timeStartMajor, timeStartMinor, timeEndMajor, timeEndMinor,
                 timeStartPct, timeEndPct, timeoutMs = 60000, maxResults = 5000 } = {}) {
    const safeMode = ['R', 'W', 'RW', 'E', 'C'].includes(mode) ? mode : 'W';
    const s = String(startAddr ?? '').trim();
    const e = String(endAddr ?? '').trim();
    let url = `/ttd/mem-access?start_addr=${encodeURIComponent(s)}&end_addr=${encodeURIComponent(e)}&mode=${encodeURIComponent(safeMode)}`;
    // Build a compact label for queue display
    const addrLabel = `${s.substring(0, 18)}–${e.substring(0, 18)}`;
    const rangeParts = [];
    if (timeStartPct !== undefined) rangeParts.push(`${Number(timeStartPct)}%`);
    if (timeEndPct !== undefined) rangeParts.push(`${Number(timeEndPct)}%`);
    const rangeLabel = rangeParts.length ? `[${rangeParts.join('–')}]` : '';
    const displayLabel = `mem-access ${safeMode} ${addrLabel} ${rangeLabel}`.trim();
    if (timeStartMajor != null) url += `&timeStartMajor=${encodeURIComponent(String(timeStartMajor))}`;
    if (timeStartMinor != null) url += `&timeStartMinor=${encodeURIComponent(String(timeStartMinor))}`;
    if (timeEndMajor != null) url += `&timeEndMajor=${encodeURIComponent(String(timeEndMajor))}`;
    if (timeEndMinor != null) url += `&timeEndMinor=${encodeURIComponent(String(timeEndMinor))}`;
    if (timeStartPct !== undefined) url += `&timeStartPct=${encodeURIComponent(Number(timeStartPct))}`;
    if (timeEndPct !== undefined) url += `&timeEndPct=${encodeURIComponent(Number(timeEndPct))}`;
    if (timeoutMs !== undefined) url += `&timeoutMs=${encodeURIComponent(Number(timeoutMs))}`;
    url += `&maxResults=${encodeURIComponent(Number.isFinite(maxResults) ? Math.max(1, Math.min(5000, maxResults)) : 5000)}`;
    url += '&noLimit=true';
    return this._request(url,
      {
        maxRetries: 0,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 60000,
        dedupe: false,
        priority: 'high',
        label: displayLabel,
      },
    );
  }

  getLifetimeEvents() {
    return this._request('/ttd/events/lifetime', {
      maxRetries: 0,
      timeoutMs: 15000,
      dedupe: false,
    });
  }

  searchStrings(query, limit = 100) {
    const encodedQuery = encodeURIComponent(String(query ?? '').trim());
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;
    return this._request(`/strings?q=${encodedQuery}&limit=${safeLimit}`, {
      maxRetries: 0,
      timeoutMs: 30000,
      dedupe: false,
    });
  }

  queryModel(expression, { depth = 2 } = {}) {
    const expr = encodeURIComponent(String(expression ?? '').trim());
    const safeDepth = Number.isFinite(Number(depth)) ? Math.max(0, Math.min(8, Number(depth))) : 2;
    return this._request(`/model?expr=${expr}&depth=${safeDepth}`, {
      maxRetries: 0,
      timeoutMs: 30000,
      dedupe: false,
    });
  }

  executeWindbgCommand(command) {
    const encodedCommand = encodeURIComponent(command);
    return this._request(`/command/execute?command=${encodedCommand}`, {
      maxRetries: 0,
      timeoutMs: 30000,
      dedupe: false,
    });
  }

  searchFunctionCalls(target, limit = 200) {
    const encodedTarget = encodeURIComponent(target);
    return this._request(`/function-calls?target=${encodedTarget}&limit=${limit}`, {
      maxRetries: 0,
      timeoutMs: 30000,
      dedupe: false,
    });
  }

  stopServer() {
    // Stop is a command endpoint; avoid retries to prevent duplicate requests.
    return this._request('/server/stop', { maxRetries: 0, dedupe: false });
  }

  // ---- internals -----------------------------------------------------------

  async _request(path, {
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    dedupe = true,
    priority = 'normal',
    label = null,
  } = {}) {
    const url = `${this._baseUrl}${path}`;
    const displayLabel = label ?? path.substring(0, 60);

    return this._enqueue(
      (signal) => this._doRequestWithRetry(url, maxRetries, timeoutMs, 'json', signal),
      { priority, label: displayLabel, _path: url },
    );
  }

  async _requestText(path, {
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    priority = 'normal',
    label = null,
  } = {}) {
    const url = `${this._baseUrl}${path}`;
    const displayLabel = label ?? path.substring(0, 60);

    return this._enqueue(
      (signal) => this._doRequestWithRetry(url, maxRetries, timeoutMs, 'text', signal),
      { priority, label: displayLabel, _path: url },
    );
  }

  async _doRequestWithRetry(url, maxRetries, timeoutMs, responseType = 'json', queueSignal = null) {
    const requestId = generateRequestId();
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      }

      try {
        const response = await this._fetchWithTimeout(url, requestId, timeoutMs, queueSignal);
        const body = responseType === 'text' ? await response.text() : await response.json();

        if (!response.ok) {
          const envelope = responseType === 'text' ? null : body?.error;
          throw new ApiError(
            envelope?.code ?? 'HTTP_ERROR',
            envelope?.message ?? `HTTP ${response.status}`,
            response.status,
          );
        }

        return body;
      } catch (err) {
        lastError = err;
        if (err instanceof ApiError && err.status < 500) break;
        if (err.name === 'AbortError') break;
      }
    }

    throw lastError;
  }

  async _fetchWithTimeout(url, requestId, timeoutMs, _queueSignal = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { 'X-Request-ID': requestId },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
