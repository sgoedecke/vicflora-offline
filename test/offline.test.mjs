import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createOfflineManager, createRetryableLoader } from '../web/public/modules/offline.js';

function createEmitter() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn(event);
      }
    }
  };
}

function createMockWorker(initialState = 'installing') {
  const emitter = createEmitter();
  return {
    state: initialState,
    addEventListener: emitter.addEventListener,
    removeEventListener: emitter.removeEventListener,
    setState(next) {
      this.state = next;
      emitter.dispatch('statechange');
    }
  };
}

function createMockRegistration({ active = null, waiting = null, installing = null } = {}) {
  const emitter = createEmitter();
  let updateCalls = 0;
  return {
    active,
    waiting,
    installing,
    addEventListener: emitter.addEventListener,
    dispatchUpdateFound() {
      emitter.dispatch('updatefound');
    },
    async update() {
      updateCalls += 1;
    },
    getUpdateCalls: () => updateCalls
  };
}

function createMockEnv({ online = true, controller = null, registerImpl, storagePersist = null } = {}) {
  const win = createEmitter();
  const doc = createEmitter();
  const sw = createEmitter();
  let reloaded = 0;
  let registerCalls = 0;
  let persistCalls = 0;

  win.location = {
    reload() {
      reloaded += 1;
    }
  };
  doc.visibilityState = 'visible';

  const nav = {
    onLine: online,
    serviceWorker: {
      controller,
      addEventListener: sw.addEventListener,
      removeEventListener: sw.removeEventListener,
      async register(url) {
        registerCalls += 1;
        return registerImpl(url, registerCalls);
      }
    }
  };

  if (storagePersist) {
    nav.storage = {
      async persist() {
        persistCalls += 1;
        return storagePersist();
      }
    };
  }

  return {
    win,
    doc,
    nav,
    swEmitter: sw,
    getRegisterCalls: () => registerCalls,
    getReloadCount: () => reloaded,
    getPersistCalls: () => persistCalls
  };
}

async function flushMicrotasks(n = 6) {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

test('OfflineManager stays not-ready when first install is interrupted, then recovers via fresh register on reconnect', async () => {
  const worker1 = createMockWorker('installing');
  const reg1 = createMockRegistration({ installing: worker1 });
  const worker2 = createMockWorker('installing');
  const reg2 = createMockRegistration({ installing: worker2 });

  const env = createMockEnv({
    online: true,
    registerImpl: (_url, call) => (call === 1 ? reg1 : reg2)
  });

  const states = [];
  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    onStateChange: s => states.push(s.status),
    retryDelaysMs: []
  });

  manager.start();
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'installing');
  assert.equal(manager.getState().hasActiveWorker, false);

  // Simulate airplane mode interrupting the initial install
  env.nav.onLine = false;
  reg1.installing = null;
  worker1.setState('redundant');
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'offline-incomplete');
  assert.equal(manager.getState().hasActiveWorker, false);
  assert.equal(env.getRegisterCalls(), 1);

  // User turns reception back on: manager must call register() again (not update() on cleared reg1)
  env.nav.onLine = true;
  env.win.dispatch('online');
  await flushMicrotasks();

  assert.equal(env.getRegisterCalls(), 2);
  assert.equal(manager.getState().status, 'installing');

  // Progress message arrives from installing SW
  env.swEmitter.dispatch('message', {
    data: { type: 'sw-cache-progress', cached: 12, total: 18 }
  });
  assert.equal(manager.getState().cached, 12);
  assert.equal(manager.getState().total, 18);
  assert.equal(manager.getState().hasActiveWorker, false);

  // Second install finishes and activates
  reg2.installing = null;
  reg2.active = worker2;
  worker2.setState('activated');
  env.swEmitter.dispatch('controllerchange');
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'ready');
  assert.equal(manager.getState().hasActiveWorker, true);
  // First-time claim must not trigger an unnecessary reload
  assert.equal(env.getReloadCount(), 0);
});

test('OfflineManager recovers automatically if opened while offline and register() throws', async () => {
  const worker = createMockWorker('installing');
  const reg = createMockRegistration({ installing: worker });

  const env = createMockEnv({
    online: false,
    registerImpl: (_url, call) => {
      if (call === 1) throw new TypeError('Failed to fetch');
      return reg;
    }
  });

  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    retryDelaysMs: []
  });

  manager.start();
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'offline-incomplete');
  assert.equal(env.getRegisterCalls(), 1);

  // Reconnect triggers re-registration
  env.nav.onLine = true;
  env.win.dispatch('online');
  await flushMicrotasks();

  assert.equal(env.getRegisterCalls(), 2);
  assert.equal(manager.getState().status, 'installing');

  reg.installing = null;
  reg.active = worker;
  worker.setState('activated');
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'ready');
  assert.equal(manager.getState().hasActiveWorker, true);
});

test('OfflineManager recovers from transient SecurityError on reconnect/retry without premature unsupported', async () => {
  const managerUnsupported = createOfflineManager({
    navigator: {},
    window: createEmitter(),
    document: createEmitter()
  });
  managerUnsupported.start();
  assert.equal(managerUnsupported.getState().status, 'unsupported');
  assert.equal(managerUnsupported.getState().hasActiveWorker, false);

  const worker = createMockWorker('installing');
  const reg = createMockRegistration({ installing: worker });
  let timersScheduled = 0;

  const env = createMockEnv({
    online: true,
    registerImpl: (_url, call) => {
      if (call === 1) {
        const err = new Error('The script has an unsupported MIME type (text/html)');
        err.name = 'SecurityError';
        throw err;
      }
      return reg;
    }
  });
  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    setTimeout: () => {
      timersScheduled += 1;
      return timersScheduled;
    }
  });

  manager.start();
  await flushMicrotasks();

  // SecurityError must not mark unsupported, must not become ready, and must not spin timer retries
  assert.equal(manager.getState().status, 'failed');
  assert.equal(manager.getState().hasActiveWorker, false);
  assert.equal(timersScheduled, 0);

  // Reconnecting after captive portal/network clears recovers cleanly
  env.win.dispatch('online');
  await flushMicrotasks();
  assert.equal(env.getRegisterCalls(), 2);
  assert.equal(manager.getState().status, 'installing');

  reg.installing = null;
  reg.active = worker;
  worker.setState('activated');
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'ready');
  assert.equal(manager.getState().hasActiveWorker, true);
});

test('OfflineManager reloads on upgrade controllerchange, and checks for updates on foreground when already ready', async () => {
  const activeWorker = createMockWorker('activated');
  const reg = createMockRegistration({ active: activeWorker });
  const env = createMockEnv({
    online: true,
    controller: activeWorker,
    registerImpl: () => reg
  });

  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc
  });

  manager.start();
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'ready');
  assert.equal(manager.getState().hasActiveWorker, true);

  env.doc.visibilityState = 'visible';
  env.doc.dispatch('visibilitychange');
  assert.equal(reg.getUpdateCalls(), 1);

  // New deploy takes control -> reloads once
  env.swEmitter.dispatch('controllerchange');
  env.swEmitter.dispatch('controllerchange');
  assert.equal(env.getReloadCount(), 1);
});

test('service-worker.js precaches resumably, rejects HTML for data assets, and activates only after all assets succeed', async () => {
  const swSource = fs.readFileSync(new URL('../web/public/service-worker.js', import.meta.url), 'utf8');
  const indexHtml = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');

  // Verify cache version matches app version badge in index.html
  const swVersionMatch = swSource.match(/const CACHE_NAME = 'vicflora-offline-(v\d+)';/);
  const htmlVersionMatch = indexHtml.match(/class="app-version"[^>]*>(v\d+)</);
  assert.ok(swVersionMatch, 'service-worker.js defines CACHE_NAME');
  assert.ok(htmlVersionMatch, 'index.html displays app version');
  assert.equal(swVersionMatch[1], htmlVersionMatch[1], 'SW cache version matches index.html app version');

  // Persistent CacheStorage across simulated interrupted install + retry
  const storeByCacheName = new Map([['vicflora-offline-v17', new Map([['./old', {}]])]]);
  function openCache(name) {
    if (!storeByCacheName.has(name)) storeByCacheName.set(name, new Map());
    const map = storeByCacheName.get(name);
    return {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        return map.get(key);
      },
      async put(req, res) {
        const key = typeof req === 'string' ? req : req.url;
        map.set(key, res);
      }
    };
  }

  const cachesMock = {
    async open(name) {
      return openCache(name);
    },
    async keys() {
      return Array.from(storeByCacheName.keys());
    },
    async delete(name) {
      return storeByCacheName.delete(name);
    }
  };

  function runServiceWorkerHarness(fetchImpl) {
    const swListeners = {};
    const messages = [];
    let skipWaitingCalled = false;
    let claimCalled = false;

    const sandbox = {
      URL,
      Request: class MockRequest {
        constructor(url, opts = {}) {
          this.url = url;
          this.cache = opts.cache || 'default';
        }
      },
      caches: cachesMock,
      fetch: fetchImpl,
      self: null
    };
    sandbox.self = {
      location: { origin: 'https://example.test', href: 'https://example.test/service-worker.js' },
      addEventListener(type, fn) {
        swListeners[type] = fn;
      },
      skipWaiting() {
        skipWaitingCalled = true;
        return Promise.resolve();
      },
      clients: {
        async matchAll() {
          return [{ postMessage: msg => messages.push(msg) }];
        },
        claim() {
          claimCalled = true;
          return Promise.resolve();
        }
      }
    };

    vm.runInNewContext(swSource, sandbox);

    return {
      async triggerInstall() {
        let p;
        swListeners.install({ waitUntil: promise => { p = promise; } });
        return p;
      },
      async triggerActivate() {
        let p;
        swListeners.activate({ waitUntil: promise => { p = promise; } });
        return p;
      },
      messages,
      wasSkipWaitingCalled: () => skipWaitingCalled,
      wasClaimCalled: () => claimCalled
    };
  }

  function makeResponse(url, { status = 200, contentType = null, redirected = false, responseUrl = null } = {}) {
    const inferredType =
      contentType ??
      (url.endsWith('.json')
        ? 'application/json'
        : url.endsWith('.js')
          ? 'application/javascript'
          : url.endsWith('.css')
            ? 'text/css'
            : url.endsWith('.svg')
              ? 'image/svg+xml'
              : url.endsWith('.png')
                ? 'image/png'
                : 'text/html');
    return {
      status,
      redirected,
      url: responseUrl ?? new URL(url, 'https://example.test/').href,
      headers: { get: name => (name.toLowerCase() === 'content-type' ? inferredType : null) },
      clone() {
        return this;
      }
    };
  }

  // Attempt 1: interrupted right before multi-keys.json (also verify cache: 'no-cache')
  const fetchedAttempt1 = [];
  const cacheModes = new Set();
  const sw1 = runServiceWorkerHarness(async req => {
    fetchedAttempt1.push(req.url);
    cacheModes.add(req.cache);
    if (req.url === './data/multi-keys.json') {
      throw new TypeError('Network disconnected');
    }
    return makeResponse(req.url);
  });

  await assert.rejects(() => sw1.triggerInstall(), /Network disconnected/);
  assert.equal(sw1.wasSkipWaitingCalled(), false, 'must not skipWaiting when install fails');
  assert.ok(fetchedAttempt1.includes('./data/dichotomous-keys.json'));
  assert.deepEqual([...cacheModes], ['no-cache'], 'precacheAssets must revalidate with cache: no-cache');

  // Attempt 2: captive portal serves HTML for multi-keys.json -> rejected
  const sw2 = runServiceWorkerHarness(async req => {
    if (req.url === './data/multi-keys.json') {
      return makeResponse(req.url, { status: 200, contentType: 'text/html; charset=utf-8' });
    }
    return makeResponse(req.url);
  });
  await assert.rejects(() => sw2.triggerInstall(), /Invalid response/);
  assert.equal(sw2.wasSkipWaitingCalled(), false);

  // Attempt 3: captive portal redirects or returns cross-origin URL -> rejected
  const swRedirect = runServiceWorkerHarness(async req => {
    if (req.url === './data/multi-keys.json') {
      return makeResponse(req.url, { redirected: true, responseUrl: 'https://portal.wifi/login' });
    }
    return makeResponse(req.url);
  });
  await assert.rejects(() => swRedirect.triggerInstall(), /Invalid response/);

  const swCrossOrigin = runServiceWorkerHarness(async req => {
    if (req.url === './data/multi-keys.json') {
      return makeResponse(req.url, { redirected: false, responseUrl: 'https://portal.wifi/data/multi-keys.json' });
    }
    return makeResponse(req.url);
  });
  await assert.rejects(() => swCrossOrigin.triggerInstall(), /Invalid response/);

  // Attempt 4: online again -> resumes from partial cache and only fetches remaining 2 files
  const fetchedAttempt3 = [];
  const sw3 = runServiceWorkerHarness(async req => {
    fetchedAttempt3.push(req.url);
    return makeResponse(req.url);
  });

  await sw3.triggerInstall();
  assert.deepEqual(fetchedAttempt3, ['./data/multi-keys.json', './data/descriptions.json']);
  assert.equal(sw3.wasSkipWaitingCalled(), true);

  const lastProgress = sw3.messages.filter(m => m.type === 'sw-cache-progress').at(-1);
  assert.equal(lastProgress.cached, lastProgress.total);

  // Activate cleans up old v17 cache, claims clients, and broadcasts sw-cache-ready
  await sw3.triggerActivate();
  assert.equal(sw3.wasClaimCalled(), true);
  assert.equal(storeByCacheName.has('vicflora-offline-v17'), false);
  assert.equal(storeByCacheName.has(`vicflora-offline-${swVersionMatch[1]}`), true);
  assert.ok(sw3.messages.some(m => m.type === 'sw-cache-ready'));
});

test('service-worker.js ASSETS covers every module in web/public/modules/*.js and rejects redirected HTML shell', async () => {
  const swSource = fs.readFileSync(new URL('../web/public/service-worker.js', import.meta.url), 'utf8');
  const modulesDir = new URL('../web/public/modules/', import.meta.url);
  const moduleFiles = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js')).sort();
  assert.ok(moduleFiles.length > 0);

  const assetsBlockMatch = swSource.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assetsBlockMatch, 'ASSETS array found');
  const assets = [...assetsBlockMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

  for (const file of moduleFiles) {
    assert.ok(
      assets.includes(`./modules/${file}`),
      `service-worker.js ASSETS is missing ./modules/${file}`
    );
  }

  // Also verify redirected HTML for './' (captive portal on app shell) is rejected
  const cacheMap = new Map();
  const swListeners = {};
  const sandbox = {
    URL,
    Request: class MockRequest {
      constructor(url, opts = {}) {
        this.url = url;
        this.cache = opts.cache || 'default';
      }
    },
    caches: {
      async open() {
        return {
          async match(k) { return cacheMap.get(typeof k === 'string' ? k : k.url); },
          async put(k, v) { cacheMap.set(typeof k === 'string' ? k : k.url, v); }
        };
      }
    },
    fetch: async () => ({
      status: 200,
      redirected: true,
      url: 'https://captive.portal/login',
      headers: { get: () => 'text/html' }
    }),
    self: {
      location: { origin: 'https://example.test', href: 'https://example.test/service-worker.js' },
      addEventListener(type, fn) { swListeners[type] = fn; },
      skipWaiting: () => Promise.resolve(),
      clients: { matchAll: async () => [], claim: () => Promise.resolve() }
    }
  };
  vm.runInNewContext(swSource, sandbox);
  let installPromise;
  swListeners.install({ waitUntil: p => { installPromise = p; } });
  await assert.rejects(() => installPromise, /Invalid response/);
  assert.equal(cacheMap.size, 0);
});

test('OfflineManager keeps retrying with capped backoff while visible, pauses when hidden, dedupes ready, and requests persistent storage', async () => {
  const scheduled = [];
  let nextTimerId = 1;
  const setTimer = (fn, delay) => {
    const id = nextTimerId++;
    scheduled.push({ id, fn, delay, cleared: false });
    return id;
  };
  const clearTimer = id => {
    const entry = scheduled.find(t => t.id === id);
    if (entry) entry.cleared = true;
  };

  let failCount = 4;
  const finalWorker = createMockWorker('installing');
  const finalReg = createMockRegistration({ installing: finalWorker });

  const env = createMockEnv({
    online: true,
    storagePersist: () => true,
    registerImpl: () => {
      if (failCount > 0) {
        failCount -= 1;
        throw new TypeError('Flaky network');
      }
      return finalReg;
    }
  });

  const emittedStatuses = [];
  let currentTime = 10_000;
  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    retryDelaysMs: [3000, 6000, 12000],
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    now: () => currentTime,
    onStateChange: s => emittedStatuses.push(s.status)
  });

  manager.start();
  await flushMicrotasks();

  // First 3 failures back off 3000 -> 6000 -> 12000, 4th stays capped at 12000 (doesn't stop)
  assert.equal(scheduled.at(-1).delay, 3000);
  scheduled.at(-1).fn();
  await flushMicrotasks();
  assert.equal(scheduled.at(-1).delay, 6000);
  scheduled.at(-1).fn();
  await flushMicrotasks();
  assert.equal(scheduled.at(-1).delay, 12000);
  scheduled.at(-1).fn();
  await flushMicrotasks();
  assert.equal(scheduled.at(-1).delay, 12000);

  // Going hidden cancels the pending retry timer
  env.doc.visibilityState = 'hidden';
  env.doc.dispatch('visibilitychange');
  assert.equal(scheduled.at(-1).cleared, true);

  // Returning to foreground retries immediately and succeeds
  env.doc.visibilityState = 'visible';
  env.doc.dispatch('visibilitychange');
  await flushMicrotasks();
  assert.equal(manager.getState().status, 'installing');

  // Multiple ready signals should only emit 'ready' once and call storage.persist() once
  finalReg.installing = null;
  finalReg.active = finalWorker;
  finalWorker.setState('activated');
  env.swEmitter.dispatch('controllerchange');
  env.swEmitter.dispatch('message', { data: { type: 'sw-cache-ready' } });
  await flushMicrotasks();

  assert.equal(emittedStatuses.filter(s => s === 'ready').length, 1);
  assert.equal(env.getPersistCalls(), 1);

  // Simultaneous pageshow + visibilitychange only triggers one registration.update()
  env.win.dispatch('pageshow');
  env.doc.dispatch('visibilitychange');
  assert.equal(finalReg.getUpdateCalls(), 1);

  // After throttle window passes, foregrounding checks for update again
  currentTime += 2000;
  env.doc.dispatch('visibilitychange');
  assert.equal(finalReg.getUpdateCalls(), 2);
});

test('OfflineManager ignores redundant state when another installing worker superseded it', async () => {
  const worker1 = createMockWorker('installing');
  const worker2 = createMockWorker('installing');
  const reg = createMockRegistration({ installing: worker1 });

  const env = createMockEnv({
    online: true,
    registerImpl: () => reg
  });

  const statuses = [];
  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    retryDelaysMs: [3000],
    onStateChange: s => statuses.push(s.status)
  });

  manager.start();
  await flushMicrotasks();
  assert.equal(manager.getState().status, 'installing');

  // Browser starts installing a newer worker and marks the old one redundant
  reg.installing = worker2;
  worker1.setState('redundant');
  await flushMicrotasks();

  assert.ok(!statuses.includes('failed'), 'must not flash failed when superseded');
  assert.equal(manager.getState().status, 'installing');

  reg.installing = null;
  reg.active = worker2;
  worker2.setState('activated');
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'ready');
});

test('OfflineManager transitions from checking to unsupported once', async () => {
  const env = createMockEnv({
    online: true,
    registerImpl: () => {
      const err = new Error('Blocked');
      err.name = 'NotSupportedError';
      throw err;
    }
  });
  const transitions = [];
  const manager = createOfflineManager({
    navigator: env.nav,
    window: env.win,
    document: env.doc,
    onStateChange: s => transitions.push(s.status)
  });

  manager.start();
  await flushMicrotasks();

  assert.equal(manager.getState().status, 'unsupported');
  assert.equal(transitions.filter(s => s === 'unsupported').length, 1);
  assert.equal(manager.getState().hasActiveWorker, false);
});

test('createRetryableLoader retries once when reconnect/SW-ready arrives during a doomed in-flight load', async () => {
  let calls = 0;
  let rejectFirst;
  let resolveSecond;

  const loader = createRetryableLoader(() => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_, reject) => {
        rejectFirst = reject;
      });
    }
    return new Promise(resolve => {
      resolveSecond = resolve;
    });
  });

  // Initial page load hangs on a dead socket
  const firstPromise = loader.run();
  assert.equal(calls, 1);
  assert.equal(loader.isCompleted(), false);

  // Reconnect / SW ready arrives while the first request is still pending
  const reconnectPromise = loader.run({ retryIfInFlight: true });
  assert.equal(reconnectPromise, firstPromise);
  assert.equal(calls, 1);

  // Old hanging request finally rejects -> loader must automatically start one follow-up attempt
  rejectFirst(new TypeError('Failed to fetch'));
  await flushMicrotasks();

  assert.equal(calls, 2);
  assert.equal(loader.isCompleted(), false);

  // Second attempt succeeds from fresh network / SW cache
  resolveSecond();
  const [r1, r2] = await Promise.all([firstPromise, reconnectPromise]);
  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(loader.isCompleted(), true);

  // Subsequent calls are no-ops once completed
  await loader.run({ retryIfInFlight: true });
  assert.equal(calls, 2);
});
