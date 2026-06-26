export default class FlameGraphView {
  constructor(container) {
    this._container = container;
    this.onGetTraceBounds = null;
    this.onGetThreads = null;
    this.onGetThreadLifetimes = null;
    this.onGetActiveThreadId = null;
    this.onFetchCallstacks = null;
    this.onClickFrame = null;
    this._container.innerHTML = '<div class="placeholder-view">Flame Graph — awaiting data</div>';
  }

  setActive(_active) {}
  setDisconnected() {}
}
