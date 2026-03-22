const FADE_OUT_MS = 300; // matches CSS transition duration

/**
 * NotificationBar — non-blocking queued toast notifications.
 *
 * Expects a #notification-bar element with CSS:
 *   opacity: 0; transition: opacity 0.3s;
 *   &.visible { opacity: 1; }
 *   &.error / &.warning / &.info  (background colours)
 *
 * Usage:
 *   const bar = new NotificationBar(document.getElementById('notification-bar'));
 *   bar.show('Something went wrong', 'error');
 *   bar.show('Connected', 'info', 3000);
 */
export default class NotificationBar {
  constructor(element) {
    this._el = element;
    this._queue = [];
    this._active = false;
  }

  /**
   * @param {string} message
   * @param {'error'|'warning'|'info'} type
   * @param {number} durationMs  — how long the toast stays visible
   */
  show(message, type = 'error', durationMs = 5000) {
    this._queue.push({ message, type, durationMs });
    if (!this._active) {
      this._flush();
    }
  }

  _flush() {
    if (this._queue.length === 0) {
      this._active = false;
      return;
    }

    this._active = true;
    const { message, type, durationMs } = this._queue.shift();

    if (!this._el) {
      // No DOM element; drain the queue silently
      this._active = false;
      return;
    }

    this._el.textContent = message;
    this._el.className = `visible ${type}`;

    setTimeout(() => {
      this._el.classList.remove('visible');
      // Wait for CSS fade-out to finish before showing the next item
      setTimeout(() => this._flush(), FADE_OUT_MS);
    }, durationMs);
  }
}
