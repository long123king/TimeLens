/**
 * ReplayBar — always-visible step controls for storyline replay mode.
 *
 * Floats at the bottom-right of the viewport regardless of the active
 * workspace tab, so the user can advance / retreat through recorded
 * steps without leaving the view they're inspecting.
 *
 * Visibility is controlled by App: `show()` when an archive is loaded,
 * `hide()` when not in replay mode.
 */
export default class ReplayBar {
  constructor() {
    this._root = document.getElementById('replay-bar');
    this._btnPrev = document.getElementById('replay-bar-prev');
    this._btnNext = document.getElementById('replay-bar-next');
    this._btnReset = document.getElementById('replay-bar-reset');
    this._counter = document.getElementById('replay-bar-counter');
    this._desc = document.getElementById('replay-bar-desc');

    this.onPrev = null;
    this.onNext = null;
    this.onReset = null;

    if (this._btnPrev) {
      this._btnPrev.addEventListener('click', () => this.onPrev?.());
    }
    if (this._btnNext) {
      this._btnNext.addEventListener('click', () => this.onNext?.());
    }
    if (this._btnReset) {
      this._btnReset.addEventListener('click', () => this.onReset?.());
    }
  }

  show() {
    this._root?.classList.add('visible');
  }

  hide() {
    this._root?.classList.remove('visible');
  }

  setCurrentStep(index, total, type, description) {
    const safeIndex = Number.isFinite(index) ? index : -1;
    const safeTotal = Number.isFinite(total) ? total : 0;
    const stepLabel = safeIndex >= 0 ? String(safeIndex + 1) : '0';
    if (this._counter) {
      this._counter.textContent = `${stepLabel}/${safeTotal}`;
    }
    if (this._desc) {
      const desc = description ? ` — ${description}` : '';
      this._desc.textContent = type ? `${type}${desc}` : '—';
      this._desc.title = this._desc.textContent;
    }
  }

  setAvailability({ canAdvance, canRetreat }) {
    if (this._btnPrev) this._btnPrev.disabled = !canRetreat;
    if (this._btnNext) this._btnNext.disabled = !canAdvance;
  }
}
