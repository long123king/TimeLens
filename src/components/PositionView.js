export default class PositionView {
  constructor(container) {
    this._container = container;
    this.onFetchCallstack = null;
    this.onFetchRegisters = null;
    this.onFetchStackSvg = null;
    this._container.innerHTML = '<div class="placeholder-view">Position — awaiting data</div>';
  }

  setActive(_active) {}
  setDisconnected() {}
  load(_major, _minor, _threadId) {}
}
