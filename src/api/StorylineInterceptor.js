// Canonicalize a URL for tolerant matching.
//
// Rules:
//   - Sort query parameters alphabetically
//   - Collapse "thread_id=X" and "threadId=X" (the API emits both) into a
//     single "threadId=X" entry. If they disagree, keep the first one seen.
//   - If both forms already produce the same string (0 or 1 params) return
//     the input unchanged so the original key still hits the fast path.
function canonicalizeUrl(url) {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return url;
  const path = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const parts = query.split('&').filter(Boolean);
  if (parts.length <= 1) return url;

  const merged = new Map();
  for (const p of parts) {
    const eq = p.indexOf('=');
    const rawKey = eq < 0 ? p : p.slice(0, eq);
    const value = eq < 0 ? '' : p.slice(eq + 1);
    // Collapse the redundant thread_id / threadId pair into one canonical key.
    const key = rawKey === 'thread_id' ? 'threadId' : rawKey;
    if (!merged.has(key)) merged.set(key, value);
  }

  const sorted = Array.from(merged.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return `${path}?${sorted.map(([k, v]) => (v ? `${k}=${v}` : k)).join('&')}`;
}

export default class StorylineInterceptor {
  constructor() {
    this._fixtures = new Map();
    this._canonicalFixtures = new Map();
    this.active = false;
  }

  loadFixtures(steps, upToIndex) {
    this._fixtures.clear();
    this._canonicalFixtures.clear();
    for (let i = 0; i <= upToIndex; i++) {
      const step = steps[i];
      if (!step) continue;
      for (const req of (step.requests ?? [])) {
        if (req.status >= 200 && req.status < 300 && req.path) {
          const fixture = {
            status: req.status,
            body: req.responseBody,
            text: req.responseText,
            responseType: req.responseType || 'json',
            contentType: req.contentType || 'application/json',
          };
          this._fixtures.set(req.path, fixture);
          const canonical = canonicalizeUrl(req.path);
          if (canonical !== req.path && !this._canonicalFixtures.has(canonical)) {
            this._canonicalFixtures.set(canonical, fixture);
          }
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
    const exact = this._fixtures.get(url);
    if (exact) return exact;
    const canonical = this._canonicalFixtures.get(canonicalizeUrl(url));
    if (canonical) return canonical;
    return null;
  }

  deactivate() {
    this.active = false;
  }

  clear() {
    this._fixtures.clear();
    this._canonicalFixtures.clear();
    this.active = false;
  }
}
