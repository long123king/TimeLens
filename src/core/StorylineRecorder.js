import { generateStepId, createArchive } from '../storyline/types.js';

export default class StorylineRecorder {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.startTime = Date.now();
    this.steps = [];
    this._pendingSteps = [];
    this._name = 'storyline';
  }

  capture({ type, action = null, description = '', requests = [] }) {
    const step = {
      id: generateStepId(),
      index: this.steps.length,
      type,
      timestamp: Date.now(),
      relativeMs: Date.now() - this.startTime,
      description,
      action,
      requests: requests ?? [],
    };
    this.steps.push(step);
    return step;
  }

  startStep(type, action = null, description = '') {
    const step = {
      id: generateStepId(),
      index: -1,
      type,
      timestamp: Date.now(),
      relativeMs: Date.now() - this.startTime,
      description,
      action,
      requests: null,
      pending: true,
      _coalesced: false,
    };
    this._pendingSteps.push(step);
    return step;
  }

  commitStep(step, requests = []) {
    if (!step._coalesced) {
      step.requests = requests ?? [];
    }
    step.pending = false;
    delete step._coalesced;
    this._flushPending();
  }

  getLastStep() {
    if (this._pendingSteps.length > 0) return this._pendingSteps[this._pendingSteps.length - 1];
    if (this.steps.length > 0) return this.steps[this.steps.length - 1];
    return null;
  }

  _flushPending() {
    while (this._pendingSteps.length > 0 && !this._pendingSteps[0].pending) {
      const step = this._pendingSteps.shift();
      delete step.pending;
      step.index = this.steps.length;
      this.steps.push(step);
    }
  }

  async captureInit() {
    const requests = this.apiClient.drainRecordingBuffer();
    return this.capture({
      type: 'init',
      description: this._describeInit(requests),
      requests,
    });
  }

  _describeInit(requests) {
    const parts = [];
    for (const r of (requests ?? [])) {
      if (!r.path) continue;
      const seg = r.path.split('?')[0].split('/').pop() || '?';
      if (seg && seg !== '?') parts.push(seg);
    }
    return parts.length > 0
      ? `Initial state — ${parts.join(', ')}`
      : `Initial state — ${(requests ?? []).length} requests`;
  }

  getSteps() {
    return this.steps;
  }

  exportArchive(traceInfo, name) {
    return createArchive(this.steps, traceInfo, name || this._name);
  }

  downloadArchive(traceInfo, name) {
    const archive = this.exportArchive(traceInfo, name);
    const json = JSON.stringify(archive, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${archive.name}-${Date.now()}.storyline.json`;
    a.click();
    URL.revokeObjectURL(url);
    return archive;
  }
}
