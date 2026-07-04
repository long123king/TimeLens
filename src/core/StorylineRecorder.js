import { generateStepId, createArchive } from '../storyline/types.js';

export default class StorylineRecorder {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.startTime = Date.now();
    this.steps = [];
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
