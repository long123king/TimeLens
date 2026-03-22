/**
 * DataManager - HTTP client for WinDbg plugin API
 * Handles all data fetching from the local WinDbg plugin server
 */
export default class DataManager {
  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  _buildPositionQuery(position, time) {
    if (position?.major != null) {
      const minor = position?.minor ?? 0;
      return `major=${encodeURIComponent(position.major)}&minor=${encodeURIComponent(minor)}`;
    }
    return `time=${encodeURIComponent(time)}`;
  }

  /**
   * Fetch memory regions and data
   * @param {string} start - Start address (hex)
   * @param {string} end - End address (hex)
   * @returns {Promise<{regions: Array, data: string}>}
   */
  async fetchMemory(start = '0x0', end = '0xFFFFFFFFFFFFFFFF') {
    const cacheKey = `memory_${start}_${end}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const url = `${this.baseUrl}/memory?start=${start}&end=${end}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, data);
    return data;
  }

  /**
   * Fetch TTD events (memory access, function calls, register changes)
   * @param {number} startTime - Start time position
   * @param {number} endTime - End time position
   * @param {string} type - Event type filter (memory, function, register)
   * @returns {Promise<{events: Array}>}
   */
  async fetchEvents(startTime = 0, endTime = 10000, type = null) {
    const cacheKey = `events_${startTime}_${endTime}_${type}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    let url = `${this.baseUrl}/events?start_time=${startTime}&end_time=${endTime}`;
    if (type) {
      url += `&type=${type}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, data);
    return data;
  }

  /**
   * Fetch call stack at specific time point
   * @param {number} time - Time position
   * @param {number|null} threadId - Optional active thread id
   * @returns {Promise<{frames: Array}>}
   */
  async fetchCallStack(time, threadId = null, position = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const cacheKey = `callstack_${positionKey}_${threadId ?? 'all'}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const threadParam = threadId != null
      ? `&thread_id=${encodeURIComponent(threadId)}&threadId=${encodeURIComponent(threadId)}`
      : '';
    const positionParam = this._buildPositionQuery(position, time);
    const url = `${this.baseUrl}/callstack?${positionParam}${threadParam}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, data);
    return data;
  }

  /**
   * Fetch register values at specific time point
   * @param {number} time - Time position
   * @param {number|null} threadId - Optional active thread id
   * @returns {Promise<Object>}
   */
  async fetchRegisters(time, threadId = null, position = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const cacheKey = `registers_${positionKey}_${threadId ?? 'all'}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const threadParam = threadId != null
      ? `&thread_id=${encodeURIComponent(threadId)}&threadId=${encodeURIComponent(threadId)}`
      : '';
    const positionParam = this._buildPositionQuery(position, time);
    const url = `${this.baseUrl}/registers?${positionParam}${threadParam}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, data);
    return data;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Fetch memory page analysis for current RSP at the given time.
   * Returns bytes (hex-encoded) + CMemoryAnalyzer annotation arrays.
   * @param {number} time - Time position
   * @param {number|null} threadId - Optional active thread id
   * @returns {Promise<Object>}
   */
  async fetchPage(time, threadId = null, position = null, address = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const addressKey = address ? String(address).toLowerCase() : 'rsp';
    const cacheKey = `page_${positionKey}_${threadId ?? 'all'}_${addressKey}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const threadParam = threadId != null
      ? `&thread_id=${encodeURIComponent(threadId)}&threadId=${encodeURIComponent(threadId)}`
      : '';
    const positionParam = this._buildPositionQuery(position, time);
    const addressParam = address ? `&address=${encodeURIComponent(address)}` : '';
    const url = `${this.baseUrl}/page?${positionParam}${threadParam}${addressParam}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    this.cache.set(cacheKey, data);
    return data;
  }
}
