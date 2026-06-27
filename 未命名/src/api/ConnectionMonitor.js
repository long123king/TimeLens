const DEFAULT_POLL_INTERVAL_MS = 15000;

/**
 * ConnectionMonitor — polls /api/server/status and tracks up/down state.
 *
 * Usage:
 *   const monitor = new ConnectionMonitor(apiClient);
 *   monitor.onStateChange = (connected, serverData) => { ... };
 *   monitor.onStatusUpdate = (serverData) => { ... };
 *   monitor.start();
 *   // later:
 *   monitor.stop();
 */
export default class ConnectionMonitor {
  constructor(apiClient, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this._api = apiClient;
    this._pollIntervalMs = pollIntervalMs;
    this._timerId = null;
    this._connected = false;

    /** @type {((connected: boolean, serverData: object|null) => void) | null} */
    this.onStateChange = null;

    /** @type {((serverData: object) => void) | null} */
    this.onStatusUpdate = null;
  }

  get isConnected() {
    return this._connected;
  }

  start() {
    if (this._timerId !== null) return; // already running
    this._poll();
    this._timerId = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  stop() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  async _poll() {
    try {
      const data = await this._api.getServerStatus();
      this.onStatusUpdate?.(data);
      if (!this._connected) {
        this._connected = true;
        this.onStateChange?.(true, data);
      }
    } catch {
      if (this._connected) {
        this._connected = false;
        this.onStateChange?.(false, null);
      }
    }
  }
}
