/**
 * DataManager — delegates all HTTP requests through the shared ApiClient queue.
 */
export default class DataManager {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.cache = new Map();
  }

  _buildPositionQuery(position, time) {
    if (position?.major != null) {
      const minor = position?.minor ?? 0;
      return `major=${encodeURIComponent(position.major)}&minor=${encodeURIComponent(minor)}`;
    }
    return `time=${encodeURIComponent(time)}`;
  }

  async fetchMemory(start = '0x0', end = '0xFFFFFFFFFFFFFFFF') {
    const cacheKey = `memory_${start}_${end}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const data = await this.apiClient.getMemory({ start, end });
    this.cache.set(cacheKey, data);
    return data;
  }

  async fetchEvents(startTime = 0, endTime = 10000, type = null) {
    const cacheKey = `events_${startTime}_${endTime}_${type}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const data = await this.apiClient.getEvents({ startTime, endTime, type });
    this.cache.set(cacheKey, data);
    return data;
  }

  async fetchCallStack(time, threadId = null, position = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const cacheKey = `callstack_${positionKey}_${threadId ?? 'all'}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const data = await this.apiClient.getCallstack({
      major: position?.major,
      minor: position?.minor,
      threadId,
    });
    this.cache.set(cacheKey, data);
    return data;
  }

  async fetchRegisters(time, threadId = null, position = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const cacheKey = `registers_${positionKey}_${threadId ?? 'all'}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const data = await this.apiClient.getRegisters({
      major: position?.major,
      minor: position?.minor,
      threadId,
    });
    this.cache.set(cacheKey, data);
    return data;
  }

  async fetchPage(time, threadId = null, position = null, address = null) {
    const positionKey = position?.major != null
      ? `${position.major}:${position?.minor ?? 0}`
      : `time:${time}`;
    const addressKey = address ? String(address).toLowerCase() : 'rsp';
    const cacheKey = `page_${positionKey}_${threadId ?? 'all'}_${addressKey}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const data = await this.apiClient.getPage({
      major: position?.major,
      minor: position?.minor,
      threadId,
      address,
    });
    this.cache.set(cacheKey, data);
    return data;
  }

  clearCache() {
    this.cache.clear();
  }
}
