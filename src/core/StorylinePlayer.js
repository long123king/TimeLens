export default class StorylinePlayer {
  constructor(archive, apiClient, interceptor) {
    this.archive = archive;
    this.steps = archive.steps ?? [];
    this.apiClient = apiClient;
    this.interceptor = interceptor;
    this.currentIndex = -1;
    this.onStepReplayed = null;
  }

  get totalSteps() {
    return this.steps.length;
  }

  get currentStep() {
    if (this.currentIndex >= 0 && this.currentIndex < this.steps.length) {
      return this.steps[this.currentIndex];
    }
    return null;
  }

  get isAtEnd() {
    return this.currentIndex >= this.steps.length - 1;
  }

  get isAtStart() {
    return this.currentIndex <= 0;
  }

  get canAdvance() {
    return this.currentIndex < this.steps.length - 1;
  }

  get canRetreat() {
    return this.currentIndex > 0;
  }

  async advance() {
    if (this.isAtEnd) return false;
    this.currentIndex++;
    await this._executeCurrent();
    this.onStepReplayed?.(this.currentIndex);
    return true;
  }

  async retreat() {
    if (this.currentIndex < 0) return false;
    this.currentIndex--;
    await this._replayFromStart(this.currentIndex);
    this.onStepReplayed?.(this.currentIndex);
    return true;
  }

  async goTo(index) {
    const target = Math.max(0, Math.min(this.steps.length - 1, index));
    this.currentIndex = -1;
    await this._replayFromStart(target);
    this.onStepReplayed?.(this.currentIndex);
  }

  async _executeCurrent() {
    const step = this.steps[this.currentIndex];
    if (!step) return;

    this.interceptor.loadFixtures(this.steps, this.currentIndex);

    if (step.action) {
      await this._applyAction(step.type, step.action);
    }

    try {
      await this.apiClient.waitForIdle(3000);
    } catch {}
  }

  async _replayFromStart(targetIndex) {
    this.interceptor.clear();
    this.apiClient.setInterceptor(this.interceptor);

    this.currentIndex = -1;
    if (this._onReset) await this._onReset();

    for (let i = 0; i <= targetIndex; i++) {
      this.currentIndex = i;
      const step = this.steps[i];
      if (!step) continue;

      this.interceptor.loadFixtures(this.steps, i);

      if (step.action) {
        await this._applyAction(step.type, step.action);
      }

      try {
        await this.apiClient.waitForIdle(3000);
      } catch {}
    }

    this.currentIndex = targetIndex;
  }

  async _applyAction(type, action) {
    if (!this._actions) return;
    const handler = this._actions[type];
    if (handler) {
      await handler(action);
    }
  }

  setActionHandlers(handlers) {
    this._actions = handlers;
  }

  setResetHandler(fn) {
    this._onReset = fn;
  }
}
