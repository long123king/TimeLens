/**
 * ConnectionPanel — manages the #connection-panel DOM element.
 *
 * Expected HTML structure (see index.html):
 *   <div id="connection-panel">
 *     <div class="cp-row" data-row="server"><span class="cp-label">…</span><span class="cp-value">—</span></div>
 *     … (trace, mode, uptime rows)
 *   </div>
 *
 * Backend response shapes consumed here:
 *   serverData  = response.server  from /api/server/status
 *   traceData   = response.trace   from /api/ttd/trace-info
 */
export default class ConnectionPanel {
  constructor(element) {
    this._el = element;
    this.onStopRequested = null;
    this._stopBtn = this._el?.querySelector('[data-action="stop-server"]') ?? null;
    this._isStopping = false;

    if (this._stopBtn) {
      this._stopBtn.addEventListener('click', () => this._handleStopClick());
      this._setStopEnabled(false);
    }
  }

  setDisconnected() {
    this._setValue('server', '● OFFLINE', 'offline');
    this._setValue('trace', '—', '');
    this._setValue('mode', '—', '');
    this._setValue('uptime', '—', '');
    this._setStopEnabled(false);
    this.setStopping(false);
  }

  /**
   * @param {object|null} serverData  — server sub-object from /api/server/status
   * @param {object|null} traceData   — trace sub-object from /api/ttd/trace-info
   */
  setConnected(serverData, traceData) {
    this._setValue('server', '● ONLINE', 'online');

    if (traceData) {
      if (traceData.available) {
        const name = traceData.dumpFile
          ? traceData.dumpFile.split(/[\\/]/).pop()
          : 'loaded';
        this._setValue('trace', name, '');
      } else {
        this._setValue('trace', 'none', '');
      }
      this._setValue('mode', traceData.isTTD ? 'TTD' : 'live', '');
    } else {
      this._setValue('trace', '—', '');
      this._setValue('mode', '—', '');
    }

    const ms = serverData?.uptimeMs;
    this._setValue('uptime', ms !== undefined ? this._formatUptime(ms) : '—', '');
    this._setStopEnabled(true);
  }

  setStopping(isStopping) {
    this._isStopping = isStopping;
    if (!this._stopBtn) return;
    this._stopBtn.textContent = isStopping ? 'Stopping...' : 'Stop Server';
    this._stopBtn.disabled = isStopping || this._stopBtn.dataset.connected !== '1';
  }

  _setStopEnabled(enabled) {
    if (!this._stopBtn) return;
    this._stopBtn.dataset.connected = enabled ? '1' : '0';
    this._stopBtn.disabled = !enabled || this._isStopping;
  }

  async _handleStopClick() {
    if (!this.onStopRequested || this._isStopping) return;
    this.setStopping(true);
    try {
      await this.onStopRequested();
    } finally {
      this.setStopping(false);
    }
  }

  _setValue(rowName, text, cls) {
    if (!this._el) return;
    const valueEl = this._el.querySelector(`[data-row="${rowName}"] .cp-value`);
    if (!valueEl) return;
    valueEl.textContent = text;
    // Reset classes then apply the new modifier
    valueEl.className = 'cp-value' + (cls ? ` ${cls}` : '');
  }

  _formatUptime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}
