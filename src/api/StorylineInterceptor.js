export default class StorylineInterceptor {
  constructor() {
    this._fixtures = new Map();
    this.active = false;
  }

  loadFixtures(steps, upToIndex) {
    this._fixtures.clear();
    for (let i = 0; i <= upToIndex; i++) {
      const step = steps[i];
      if (!step) continue;
      for (const req of (step.requests ?? [])) {
        if (req.status >= 200 && req.status < 300 && req.path) {
          this._fixtures.set(req.path, {
            status: req.status,
            body: req.responseBody,
            text: req.responseText,
            responseType: req.responseType || 'json',
            contentType: req.contentType || 'application/json',
          });
        }
      }
    }
    this.active = true;
  }

  loadArchive(archive) {
    this.loadFixtures(archive.steps, archive.steps.length - 1);
  }

  intercept(url) {
    if (!this.active) return null;
    const fixture = this._fixtures.get(url);
    if (!fixture) return null;
    if (fixture.responseType === 'text') {
      return {
        status: fixture.status,
        text: fixture.text || '',
        body: null,
        contentType: fixture.contentType || 'text/plain',
      };
    }
    if (fixture.body != null) {
      return {
        status: fixture.status,
        body: fixture.body,
        contentType: fixture.contentType || 'application/json',
      };
    }
    return null;
  }

  deactivate() {
    this.active = false;
  }

  clear() {
    this._fixtures.clear();
    this.active = false;
  }
}
