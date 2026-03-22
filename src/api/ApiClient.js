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
    this._inflight = new Map(); // url -> Promise
  }

  // ---- public route methods -----------------------------------------------

  getServerStatus() {
    return this._request('/server/status');
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
  } = {}) {
    const url = `${this._baseUrl}${path}`;

    // Dedup: reuse an in-flight request for the same URL
    if (dedupe && this._inflight.has(url)) {
      return this._inflight.get(url);
    }

    const promise = this._doRequestWithRetry(url, maxRetries, timeoutMs);
    if (dedupe) {
      this._inflight.set(url, promise);
      promise.finally(() => this._inflight.delete(url));
    }
    return promise;
  }

  async _doRequestWithRetry(url, maxRetries, timeoutMs) {
    const requestId = generateRequestId();
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      }

      try {
        const response = await this._fetchWithTimeout(url, requestId, timeoutMs);
        const json = await response.json();

        if (!response.ok) {
          const envelope = json?.error;
          throw new ApiError(
            envelope?.code ?? 'HTTP_ERROR',
            envelope?.message ?? `HTTP ${response.status}`,
            response.status,
          );
        }

        return json;
      } catch (err) {
        lastError = err;
        // Do not retry on 4xx client errors from the server
        if (err instanceof ApiError && err.status < 500) break;
      }
    }

    throw lastError;
  }

  async _fetchWithTimeout(url, requestId, timeoutMs) {
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
