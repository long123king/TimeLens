/**
 * test-queue-race.mjs — Simulate the flame-graph → mem-access queue race.
 *
 * Tests the ApiClient.js request queue under these exact scenarios:
 *   1. Flame graph sampling enqueues callstacks
 *   2. User clicks flame graph frame → drainQueue
 *   3. User clicks Query → drainQueue + getMemAccess
 *
 * Uses a simplified abort model (flush + flag) instead of real AbortController
 * to avoid Node.js AbortSignal event-dispatch quirks. The queue logic is
 * byte-for-byte identical to the real ApiClient.js.
 *
 * Run:  node test-queue-race.mjs
 */

// ---- Miniature ApiClient (exact logic from src/api/ApiClient.js) -----------

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

class FakeApiClient {
  constructor() {
    this._queue = [];
    this._processing = false;
    this._activeController = null;
    this._nextId = 1;
    this.serverLog = [];          // what hit the "server"
    this._serverLatencyMs = 5;   // simulated server latency
    this._serverHangs = false;   // when true, server never responds
    this._nextServerId = 1;
  }

  // ---- Queue logic (identical to ApiClient.js) -----------------------------

  drainQueue(reason = 'queue drained') {
    const drained = [];
    for (const item of this._queue) {
      item.reject(new ApiError('CANCELLED', reason, 0));
      drained.push(item.label);
    }
    this._queue.length = 0;
    if (this._activeController) {
      this._activeController.abort();
      this._activeController = null;
    }
    return drained;
  }

  _enqueue(fn, { priority = 'normal', label = '' } = {}) {
    return new Promise((resolve, reject) => {
      const item = { id: this._nextId++, fn, resolve, reject, priority, label };
      if (priority === 'high') {
        const firstNormal = this._queue.findIndex(i => i.priority !== 'high');
        if (firstNormal >= 0) {
          this._queue.splice(firstNormal, 0, item);
        } else {
          this._queue.push(item);
        }
      } else {
        this._queue.push(item);
      }
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      const ac = new SimAbortController();
      this._activeController = ac;
      try {
        const result = await item.fn(ac.signal);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        if (this._activeController === ac) {
          this._activeController = null;
        }
      }
    }
    this._processing = false;
  }

  // ---- Simulated API methods ------------------------------------------------

  getCallstack(pos) {
    return this._request(`/callstack?pos=${pos}`, {
      priority: 'normal',
      label: `cs-${pos}`,
    });
  }

  getMemAccess({ startAddr, endAddr, mode }) {
    return this._request(`/mem-access?start=${startAddr}&end=${endAddr}&mode=${mode}`, {
      priority: 'high',
      label: `ma-${startAddr}`,
    });
  }

  async _request(path, { priority = 'normal', label = '' } = {}) {
    return this._enqueue(
      (signal) => this._simulateFetch(path, signal),
      { priority, label },
    );
  }

  /**
   * Simulate fetch() with abort support.
   * Server responds after _serverLatencyMs unless _serverHangs=true.
   * If signal.aborted or signal fires mid-flight, throws AbortError.
   */
  async _simulateFetch(path, signal) {
    if (signal.aborted) {
      const err = new Error('Aborted before fetch');
      err.name = 'AbortError';
      throw err;
    }

    const serverId = this._nextServerId++;

    return new Promise((resolve, reject) => {
      let done = false;

      const finish = (err, result) => {
        if (done) return;
        done = true;
        signal._onAbort = null;
        if (err) reject(err);
        else resolve(result);
      };

      // Listen for abort
      signal._onAbort = () => {
        clearTimeout(timer);
        const err = new Error('Aborted mid-flight');
        err.name = 'AbortError';
        finish(err, null);
      };

      const timer = setTimeout(() => {
        if (this._serverHangs) return; // never respond
        this.serverLog.push({ path, time: Date.now(), serverId });
        finish(null, { ok: true, data: `result-for-${path}` });
      }, this._serverLatencyMs);
    });
  }

  dumpState() {
    return {
      processing: this._processing,
      queueLen: this._queue.length,
      queueLabels: this._queue.map(i => i.label),
      activeAborted: this._activeController?.signal?.aborted ?? null,
      serverLogLen: this.serverLog.length,
    };
  }
}

// ---- Minimal AbortController/AbortSignal (no Node.js event quirks) ---------

class SimAbortSignal {
  constructor() {
    this.aborted = false;
    this._onAbort = null;
  }
}

class SimAbortController {
  constructor() {
    this.signal = new SimAbortSignal();
  }
  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    if (this.signal._onAbort) {
      this.signal._onAbort();
    }
  }
}

// ---- Test harness ----------------------------------------------------------

let pass = 0;
let fail = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    fail++;
  } else {
    console.log(`  OK:   ${msg}`);
    pass++;
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Test 1: Basic queue ordering ------------------------------------------

async function test1_basicOrdering() {
  console.log('\n=== Test 1: Basic queue ordering ===');
  const api = new FakeApiClient();

  const csPromises = [0, 1, 2].map(i => api.getCallstack(i));
  const maPromise = api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });

  const csResults = await Promise.allSettled(csPromises);
  const maResult = await maPromise;

  assert(maResult.data.includes('mem-access'), 'mem-access result received');

  const order = api.serverLog.map(l => l.path);
  console.log('  Server log:', order);
  assert(order[0].includes('callstack'), 'cs-0 first (already active)');
  assert(order[1].includes('mem-access'), 'ma jumps ahead (high priority)');
  assert(order[2].includes('callstack'), 'cs-1 third');
}

// ---- Test 2: drainQueue while request is active ---------------------------

async function test2_drainWhileActive() {
  console.log('\n=== Test 2: drainQueue while request is in flight ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 100; // slow

  const csPromise = api.getCallstack(0).catch(e => `cs-rejected:${e.code}`);
  await sleep(10);

  console.log('  Before drain:', JSON.stringify(api.dumpState()));
  const drained = api.drainQueue('tab switch');
  console.log('  Drained:', drained);
  console.log('  After drain:', JSON.stringify(api.dumpState()));

  // Wait for abort + _processQueue to settle
  await sleep(50);
  console.log('  After settle:', JSON.stringify(api.dumpState()));

  assert(api.dumpState().processing === false,
    '_processing is false after drain+settle');

  // Enqueue mem-access (must work)
  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log('  MA result:', maResult?.data);
  assert(maResult?.data?.includes('mem-access'),
    'Mem-access works after drain of active request');

  // Verify cs was rejected
  const csOutcome = await Promise.race([
    csPromise,
    sleep(500).then(() => 'timeout'),
  ]);
  console.log('  CS outcome:', csOutcome);
  assert(csOutcome !== 'timeout', 'Callstack promise settled (not hung)');

  api.serverLog = [];
}

// ---- Test 3: Full click → query flow --------------------------------------

async function test3_fullClickFlow() {
  console.log('\n=== Test 3: Full click → query flow ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 20;

  // Phase 1: Flame graph sampling — enqueue callstacks with stagger
  console.log('  Phase 1: Sampling...');
  for (let i = 0; i < 5; i++) {
    api.getCallstack(i).catch(() => {});
    await sleep(1); // stagger
  }

  await sleep(25);
  const s1 = api.dumpState();
  console.log('  Mid-sampling:', JSON.stringify(s1));

  // Phase 2: Click flame graph → _openMemAccessRange
  // (setActiveTab calls drainQueue if nextTab !== 'flamegraph')
  // (_openMemAccessRange also calls drainQueue)
  console.log('  Phase 2: Click frame → drainQueue ×2');
  api.drainQueue('setActiveTab');
  api.drainQueue('_openMemAccessRange');

  await sleep(50);
  const s2 = api.dumpState();
  console.log('  After drains:', JSON.stringify(s2));
  assert(s2.processing === false, '_processing false after drain');

  // Phase 3: User clicks Query → _searchMemAccess
  console.log('  Phase 3: Click Query → drainQueue + getMemAccess');
  api.drainQueue('search');

  const maResult = await api.getMemAccess({
    startAddr: '0x7ff758f65000', endAddr: '0x7ff758f66000', mode: 'E',
  });

  console.log('  Final state:', JSON.stringify(api.dumpState()));
  console.log('  Server log:', api.serverLog.map(l => l.path));
  assert(maResult?.data?.includes('mem-access'),
    'Mem-access returned data');
  assert(api.serverLog.some(l => l.path.includes('mem-access')),
    'Mem-access reached server');

  api.serverLog = [];
}

// ---- Test 4: setTimeout(0) leak in FlameGraphView._fetchInBatches ---------

async function test4_setTimeoutLeak() {
  console.log('\n=== Test 4: setTimeout(0) leak from FlameGraphView._fetchInBatches ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 50;

  // Simulate: _fetchInBatches's Promise.all has setTimeout(0) scheduled
  // drainQueue is called → setTimeout fires → enqueues leaked callstack
  let leakResult = null;
  const leakDone = new Promise(resolve => {
    setTimeout(async () => {
      console.log('  setTimeout fired!');
      try {
        leakResult = await api.getCallstack(999);
      } catch (e) {
        leakResult = `leak-cancelled:${e.code || e.message}`;
      }
      resolve();
    }, 0);
  });

  // drainQueue immediately
  const drained = api.drainQueue('click');
  console.log('  drainQueue called, drained:', drained);

  await leakDone;
  console.log('  Leaked cs result:', leakResult);
  console.log('  State after leak settles:', JSON.stringify(api.dumpState()));

  // Wait for leaked callstack to complete
  await sleep(100);

  // Now enqueue mem-access
  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log('  MA result:', maResult?.data);
  console.log('  Server log after leak+MA:', api.serverLog.map(l => l.path));

  assert(api.serverLog.some(l => l.path.includes('mem-access')),
    'Mem-access reached server despite setTimeout leak');
  assert(api.dumpState().processing === false,
    '_processing is false after everything');

  api.serverLog = [];
}

// ---- Test 5: drain between items in _processQueue -------------------------

async function test5_drainBetweenItems() {
  console.log('\n=== Test 5: drain while _processQueue is between items ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 10;

  api.getCallstack(0).catch(() => {});
  api.getCallstack(1).catch(() => {});

  await sleep(30);
  console.log('  Mid-processing:', JSON.stringify(api.dumpState()));

  api.drainQueue('tab switch');
  await sleep(30);
  console.log('  After drain+settle:', JSON.stringify(api.dumpState()));

  assert(api.dumpState().processing === false,
    '_processing false');

  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  assert(api.serverLog.some(l => l.path.includes('mem-access')),
    'Mem-access works after drain between items');

  api.serverLog = [];
}

// ---- Test 6: Hung server → drain → recover --------------------------------

async function test6_hungServer() {
  console.log('\n=== Test 6: Hung server on callstack → drainQueue → mem-access ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 30;
  api._serverHangs = true;

  const csPromise = api.getCallstack(0).catch(e => `cs-rej:${e.code}`);
  await sleep(10);

  console.log('  During hung cs:', JSON.stringify(api.dumpState()));

  // drainQueue should abort the hung request
  api.drainQueue('tab switch');
  await sleep(50);

  console.log('  After drain:', JSON.stringify(api.dumpState()));
  assert(api.dumpState().processing === false, '_processing false after hung drain');

  // Recover server and enqueue mem-access
  api._serverHangs = false;
  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log('  MA result:', maResult?.data);

  assert(api.serverLog.some(l => l.path.includes('mem-access')),
    'Mem-access works after hung-callstack drain');

  // Verify cs was rejected
  const csOutcome = await Promise.race([csPromise, sleep(200).then(() => 'timeout')]);
  console.log('  CS outcome:', csOutcome);
  assert(csOutcome !== 'timeout', 'Hung callstack was aborted (not stuck)');

  api.serverLog = [];
}

// ---- Test 7: Stress test — 50 rapid drain/enqueue cycles ------------------

async function test7_stressTest() {
  console.log('\n=== Test 7: Stress — 50 rapid drain/enqueue cycles ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 2;

  for (let round = 0; round < 50; round++) {
    // Enqueue callstacks
    api.getCallstack(round * 3).catch(() => {});
    api.getCallstack(round * 3 + 1).catch(() => {});
    await sleep(0);

    // Drain mid-flight
    api.drainQueue(`round-${round}`);

    // Enqueue mem-access (must succeed)
    const maResult = await api.getMemAccess({
      startAddr: `0x${round.toString(16)}000`,
      endAddr: `0x${round.toString(16)}fff`,
      mode: 'E',
    });

    if (!maResult?.data) {
      console.log(`  Round ${round}: FAILED — ma returned ${JSON.stringify(maResult)}`);
      assert(false, `Round ${round}: mem-access failed`);
      return;
    }

    // Check queue is idle
    const state = api.dumpState();
    if (state.processing || state.queueLen > 0) {
      console.log(`  Round ${round}: STUCK — ${JSON.stringify(state)}`);
      assert(false, `Round ${round}: stuck`);
      return;
    }
  }

  assert(true, 'All 50 stress-test rounds passed');
  api.serverLog = [];
}

// ---- Test 8: drainQueue while queue has multiple items --------------------

async function test8_drainMultiItemQueue() {
  console.log('\n=== Test 8: drainQueue with multiple queued items ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 100; // slow first request

  // Enqueue first (will be active)
  api.getCallstack(0).catch(() => {});
  await sleep(5);

  // Enqueue more (will queue up)
  const p1 = api.getCallstack(1).catch(e => `cs1:${e.code}`);
  const p2 = api.getCallstack(2).catch(e => `cs2:${e.code}`);
  const p3 = api.getCallstack(3).catch(e => `cs3:${e.code}`);

  await sleep(5);
  console.log('  Before drain:', JSON.stringify(api.dumpState()));

  const drained = api.drainQueue('tab switch');
  console.log('  Drained:', drained);
  console.log('  After drain:', JSON.stringify(api.dumpState()));

  await sleep(50);
  console.log('  After settle:', JSON.stringify(api.dumpState()));

  // Wait for all queued promises to settle
  const outcomes = await Promise.all([p1, p2, p3]);
  console.log('  Outcomes:', outcomes);
  assert(outcomes.every(o => o.includes('CANCELLED')),
    'All queued items were cancelled');

  // Enqueue mem-access
  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  assert(maResult?.data?.includes('mem-access'),
    'Mem-access works after draining multi-item queue');

  api.serverLog = [];
}

// ---- Test 9: drainQueue + immediate re-enqueue (no sleep in between) ------

async function test9_drainAndImmediateEnqueue() {
  console.log('\n=== Test 9: drainQueue + immediate enqueue (no yield between) ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 50;

  api.getCallstack(0).catch(() => {});
  await sleep(5);

  api.drainQueue('switch');

  // IMMEDIATELY enqueue mem-access (no await between)
  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log('  MA result:', maResult?.data);
  console.log('  Final state:', JSON.stringify(api.dumpState()));

  assert(api.serverLog.some(l => l.path.includes('mem-access')),
    'Mem-access works with immediate enqueue after drain');

  api.serverLog = [];
}

// ---- Test 10: drainQueue inside catch block (simulates error case) --------

async function test10_drainDuringCatch() {
  console.log('\n=== Test 10: drainQueue while request is erroring ===');

  class FailingClient extends FakeApiClient {
    async _simulateFetch(path, signal) {
      await sleep(5);
      if (signal.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      throw new ApiError('SERVER_ERROR', 'Simulated 500', 500);
    }
  }

  const api = new FailingClient();
  api._serverLatencyMs = 5;

  const p1 = api.getCallstack(0).catch(() => 'caught');
  await sleep(3);

  api.drainQueue('test');
  await sleep(30);

  console.log('  State:', JSON.stringify(api.dumpState()));
  assert(api.dumpState().processing === false,
    '_processing false after drain during error');

  const maResult = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  assert(maResult?.data?.includes('mem-access'),
    'Mem-access works after drain during error');

  api.serverLog = [];
}

// ---- Test 11: queue starvation — normal items never processed -------------

async function test11_noStarvation() {
  console.log('\n=== Test 11: High-priority items do not starve normal items ===');
  const api = new FakeApiClient();
  api._serverLatencyMs = 5;

  // Enqueue 5 callstacks (normal priority)
  const csPromises = [0, 1, 2, 3, 4].map(i => api.getCallstack(i));

  // Enqueue 3 high-priority mem-access items
  const maPromises = ['a', 'b', 'c'].map(l =>
    api.getMemAccess({ startAddr: `0x${l}000`, endAddr: `0x${l}fff`, mode: 'E' }),
  );

  await sleep(100);

  // All should settle
  const csResults = await Promise.allSettled(csPromises);
  const maResults = await Promise.all(maPromises.map(async p => {
    try { return (await p).data; } catch (e) { return `err:${e.code}`; }
  }));

  const fulfilled = csResults.filter(r => r.status === 'fulfilled').length;
  console.log(`  Callstacks: ${fulfilled}/5 fulfilled`);
  console.log('  MA results:', maResults);
  console.log('  Server order:', api.serverLog.map(l => l.path));

  assert(fulfilled === 5, 'All callstacks completed');
  assert(maResults.every(r => r.includes('mem-access')),
    'All mem-access completed');
  assert(api.dumpState().processing === false, 'Idle at end');

  api.serverLog = [];
}

// ---- Run all tests ---------------------------------------------------------

async function main() {
  console.log('=== TimeLens Queue Race Test Suite ===');
  console.log(`Node: ${process.version}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const tests = [
    test1_basicOrdering,
    test2_drainWhileActive,
    test3_fullClickFlow,
    test4_setTimeoutLeak,
    test5_drainBetweenItems,
    test6_hungServer,
    test7_stressTest,
    test8_drainMultiItemQueue,
    test9_drainAndImmediateEnqueue,
    test10_drainDuringCatch,
    test11_noStarvation,
  ];

  for (const testFn of tests) {
    try {
      await testFn();
    } catch (err) {
      console.error(`\n  UNEXPECTED ERROR in ${testFn.name}:`, err.message);
      console.error(err.stack);
      fail++;
    }
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
