/**
 * test-real-abort-race.mjs — Tests the EXACT real ApiClient.js pattern
 * with realistic AbortController behavior.
 *
 * The key question: when drainQueue aborts the active controller, does
 * _processQueue correctly recover and process the next item?
 *
 * This uses the actual browser-like AbortController (no sim).
 * We handle the AbortError propagation carefully.
 */

let pass = 0;
let fail = 0;
function assert(cond, msg) { cond ? (pass++, console.log(`  OK: ${msg}`)) : (fail++, console.error(`  FAIL: ${msg}`)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- EXACT copy of ApiClient.js queue logic --------------------------------

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

class ApiClient {
  constructor() {
    this._queue = [];
    this._processing = false;
    this._activeController = null;
    this._nextId = 1;
    this.serverLog = [];
    this._serverLatencyMs = 5;
    this._serverHangs = false;
  }

  drainQueue(reason = 'queue drained') {
    for (const item of this._queue) {
      item.reject(new ApiError('CANCELLED', reason, 0));
    }
    this._queue = [];
    if (this._activeController) {
      this._activeController.abort();
      this._activeController = null;
    }
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

  // EXACT pattern from real ApiClient.js — unconditional null in finally
  async _processQueue() {
    if (this._processing) return;
    this._processing = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      this._activeController = new AbortController();
      try {
        const result = await item.fn(this._activeController.signal);
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      } finally {
        this._activeController = null;
      }
    }
    this._processing = false;
  }

  getCallstack(pos) {
    return this._request(`/cs?pos=${pos}`, { priority: 'normal', label: `cs-${pos}` });
  }

  getMemAccess({ startAddr, endAddr, mode }) {
    return this._request(`/ma?start=${startAddr}&end=${endAddr}&mode=${mode}`, {
      priority: 'high', label: `ma-${startAddr.substring(0,8)}`,
    });
  }

  async _request(path, opts = {}) {
    return this._enqueue(
      (signal) => this._simFetch(path, signal),
      opts,
    );
  }

  /**
   * Simulates real fetch() with AbortSignal.
   * Uses a Promise wrapper so abort causes a clean rejection.
   */
  async _simFetch(path, signal) {
    if (signal.aborted) {
      const err = new Error('pre-aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = new Error('mid-abort');
        err.name = 'AbortError';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        if (!this._serverHangs) {
          this.serverLog.push({ path, time: Date.now() });
          resolve({ ok: true, data: `result:${path}` });
        }
      }, this._serverLatencyMs);
    });
  }

  dump() {
    return `proc=${this._processing} q=${this._queue.length} [${this._queue.map(i=>i.label).join(',')}] ac=${this._activeController ? 'set' : 'null'}`;
  }
}

// ---- Tests -----------------------------------------------------------------

async function test1_drainWhileActive_realAC() {
  console.log('\n=== Test 1: drainQueue while active, real AbortController ===');
  const api = new ApiClient();
  api._serverLatencyMs = 100;

  const csP = api.getCallstack(0).catch(e => `cs:${e.code||e.name}`);
  await sleep(10);

  console.log(`  Before drain: ${api.dump()}`);
  api.drainQueue('switch');
  console.log(`  After drain:  ${api.dump()}`);

  // Wait for abort to settle in _processQueue
  await sleep(50);
  console.log(`  After settle: ${api.dump()}`);

  assert(!api._processing, '_processing is false after drain+settle');

  // Now enqueue mem-access
  const maR = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log(`  MA result: ${maR?.data}`);
  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server');
  api.serverLog = [];
}

async function test2_drainAndImmediateEnqueue_realAC() {
  console.log('\n=== Test 2: drainQueue + IMMEDIATE enqueue (no yield) ===');
  const api = new ApiClient();
  api._serverLatencyMs = 100;

  api.getCallstack(0).catch(() => {});
  await sleep(5);

  api.drainQueue('switch');
  console.log(`  After drain: ${api.dump()}`);

  // IMMEDIATELY enqueue mem-access (simulates _searchMemAccess)
  const maR = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log(`  MA result: ${maR?.data}`);
  console.log(`  Final: ${api.dump()}`);

  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server');
  assert(!api._processing, '_processing false at end');
  api.serverLog = [];
}

async function test3_doubleDrain_realAC() {
  console.log('\n=== Test 3: Double drainQueue (setActiveTab + _openMemAccessRange) ===');
  const api = new ApiClient();
  api._serverLatencyMs = 50;

  api.getCallstack(0).catch(() => {});
  await sleep(5);

  api.drainQueue('setActiveTab');
  api.drainQueue('_openMemAccessRange');
  console.log(`  After double drain: ${api.dump()}`);

  await sleep(100);
  console.log(`  After settle: ${api.dump()}`);

  const maR = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server');
  api.serverLog = [];
}

async function test4_hungServerDrain_realAC() {
  console.log('\n=== Test 4: Hung server → drainQueue → MA (server never responds) ===');
  const api = new ApiClient();
  api._serverLatencyMs = 5000;
  api._serverHangs = true;

  const csP = api.getCallstack(0).catch(e => `cs:${e.code||e.name}`);
  await sleep(10);
  console.log(`  Hung cs: ${api.dump()}`);

  api.drainQueue('switch');
  console.log(`  After drain: ${api.dump()}`);

  await sleep(30);
  console.log(`  After settle: ${api.dump()}`);

  // The abort should have cleared _processing
  assert(!api._processing, '_processing false after hung drain');

  // Now MA should work
  api._serverHangs = false;
  api._serverLatencyMs = 5;
  const maR = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log(`  MA result: ${maR?.data}`);

  const csOutcome = await Promise.race([csP, sleep(200).then(() => 'timeout')]);
  console.log(`  CS outcome: ${csOutcome}`);

  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server');
  assert(csOutcome !== 'timeout', 'Hung CS was aborted (not stuck)');
  api.serverLog = [];
}

async function test5_rapidCycles_realAC() {
  console.log('\n=== Test 5: 30 rapid drain/enqueue cycles, real AbortController ===');
  const api = new ApiClient();
  api._serverLatencyMs = 2;

  for (let r = 0; r < 30; r++) {
    api.getCallstack(r * 2).catch(() => {});
    api.getCallstack(r * 2 + 1).catch(() => {});
    await sleep(0);
    api.drainQueue(`r${r}`);

    const maR = await api.getMemAccess({ startAddr: `0x${r.toString(16)}000`, endAddr: `0x${r.toString(16)}fff`, mode: 'E' });
    if (!maR?.data) { assert(false, `Round ${r}: MA failed`); return; }
    if (api._processing || api._queue.length > 0) {
      assert(false, `Round ${r}: stuck — ${api.dump()}`);
      return;
    }
  }
  assert(true, '30 rapid cycles passed');
  api.serverLog = [];
}

async function test6_fullClickFlow_realAC() {
  console.log('\n=== Test 6: Full click→query flow with real AbortController ===');

  // Simulate the EXACT sequence:
  // 1. Flame graph is sampling callstacks
  // 2. User clicks frame → _openMemAccessRange (setActiveTab + drainQueue)
  // 3. setTimeout(0) leak from _fetchInBatches
  // 4. User clicks Query → _searchMemAccess (drainQueue + getMemAccess)

  const api = new ApiClient();
  api._serverLatencyMs = 20;

  // Phase 1: Flame graph actively sampling
  console.log('  Phase 1: Sampling...');
  for (let i = 0; i < 3; i++) {
    api.getCallstack(i).catch(() => {});
    await sleep(1);
  }
  await sleep(15);
  console.log(`  Mid-sampling: ${api.dump()}`);

  // Phase 2: Click frame (drainQueue ×2)
  console.log('  Phase 2: drainQueue ×2');
  api.drainQueue('setActiveTab');
  api.drainQueue('_openMemAccessRange');
  await sleep(30);
  console.log(`  After drain: ${api.dump()}`);
  assert(!api._processing, '_processing false after drain');

  // Phase 3: setTimeout leak (from _fetchInBatches Promise.all)
  console.log('  Phase 3: setTimeout leak...');
  let leaked = null;
  const leakDone = new Promise(r => {
    setTimeout(async () => {
      try { leaked = await api.getCallstack(999); }
      catch (e) { leaked = `cancelled:${e.code||e.name}`; }
      r();
    }, 0);
  });
  await leakDone;
  console.log(`  Leaked CS: ${leaked}`);
  await sleep(50);
  console.log(`  After leak settle: ${api.dump()}`);

  // Phase 4: Click Query (_searchMemAccess)
  console.log('  Phase 4: _searchMemAccess');
  api.drainQueue('search');

  const maR = await api.getMemAccess({
    startAddr: '0x7ff758f65000', endAddr: '0x7ff758f66000', mode: 'E',
  });
  console.log(`  MA result: ${maR?.data}`);
  console.log(`  Server log: ${api.serverLog.map(l=>l.path)}`);

  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server');
  assert(!api._processing, 'Idle at end');
  api.serverLog = [];
}

async function test7_concurrentPoll_realAC() {
  console.log('\n=== Test 7: Status poll contention with MA ===');

  // Simulate: ConnectionMonitor.status poll fires while user queries MA
  const api = new ApiClient();
  api._serverLatencyMs = 30;

  // ConnectionMonitor polls periodically
  api.getCallstack(0).catch(() => {}); // let's call it a poll
  await sleep(2);

  // User clicks Query
  api.drainQueue('search');

  const maR = await api.getMemAccess({ startAddr: '0x1000', endAddr: '0x2000', mode: 'E' });
  console.log(`  MA result: ${maR?.data}`);
  console.log(`  Server log: ${api.serverLog.map(l=>l.path)}`);

  assert(api.serverLog.some(l => l.path.includes('/ma?')), 'MA reached server despite poll');
  api.serverLog = [];
}

// ---- Main ------------------------------------------------------------------

async function main() {
  console.log(`=== Real AbortController Queue Tests (Node ${process.version}) ===\n`);

  const tests = [
    test1_drainWhileActive_realAC,
    test2_drainAndImmediateEnqueue_realAC,
    test3_doubleDrain_realAC,
    test4_hungServerDrain_realAC,
    test5_rapidCycles_realAC,
    test6_fullClickFlow_realAC,
    test7_concurrentPoll_realAC,
  ];

  for (const t of tests) {
    try { await t(); }
    catch (e) { console.error(`  CRASH in ${t.name}: ${e.message}\n${e.stack}`); fail++; }
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
