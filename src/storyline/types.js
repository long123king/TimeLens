export const STEP_TYPES = [
  'init',
  'tab-switch',
  'timeline-seek',
  'thread-select',
  'address-click',
  'module-click',
  'position-open',
  'page-navigate',
  'search',
  'command',
  'mem-access',
  'flamegraph',
  'auto',
];

export function generateStepId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `step-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createArchive(steps, traceInfo, name) {
  let requestCount = 0;
  for (const step of steps) {
    requestCount += (step.requests ?? []).length;
  }

  return {
    formatVersion: '2.0',
    name: name || 'storyline',
    createdAt: new Date().toISOString(),
    duration: steps.length > 0
      ? steps[steps.length - 1].relativeMs
      : 0,
    stepCount: steps.length,
    requestCount,
    traceInfo: traceInfo || null,
    steps,
  };
}
