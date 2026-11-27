import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildManifest, DATA_BUNDLES } from '../scripts/build-web-data.js';
import {
  DATA_CACHE_NAME,
  PHOTOS_CACHE_NAME,
  createDataStore,
  createOfflineManager,
  createRetryableLoader,
  syncCachePack
} from '../web/public/modules/offline.js';
import { FakeCacheStorage } from './helpers/fake-caches.mjs';

const ORIGIN = 'https://vicflora.test/';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicflora-manifest-'));
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>v1</body></html>');
  fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: #111; }');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{"name":"VicFlora"}');
  fs.writeFileSync(path.join(dir, 'modules', 'offline.js'), 'export const x = 1;');
  for (const bundle of DATA_BUNDLES) {
    fs.writeFileSync(path.join(dir, 'data', bundle.file), JSON.stringify({ id: bundle.id, rev: 1 }));
  }
  return dir;
}

function loadServiceWorker({ manifest, cachesApi, fetchImpl }) {
  const listeners = new Map();
  const posted = [];
  const swSource = fs.readFileSync(path.resolve('web/public/service-worker.js'), 'utf8');
  const selfObj = {
    location: new URL('./service-worker.js', ORIGIN),
    caches: cachesApi,
    fetch: fetchImpl,
    importScripts: () => {
      selfObj.__VICFLORA_MANIFEST__ = manifest;
    },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: msg => posted.push(msg) }]
    },
    addEventListener: (type, fn) => listeners.set(type, fn)
  };
  vm.runInNewContext(swSource, {
    self: selfObj,
    importScripts: selfObj.importScripts,
    caches: cachesApi,
    fetch: fetchImpl,
    URL,
    Request,
    Response,
    Headers,
    Set,
    Promise
  });
  return {
    posted,
    dispatchLifecycle: async type => {
      const waits = [];
      listeners.get(type)({ waitUntil: p => waits.push(p) });
      await Promise.all(waits);
    },
    dispatchFetch: async request => {
      let responsePromise = null;
      listeners.get('fetch')({
        request,
        respondWith: p => {
          responsePromise = p;
        }
      });
      return responsePromise ? await responsePromise : null;
    }
  };
}

test('buildManifest isolates shell hashes from data hashes and emits deterministic manifests', async () => {
  const dir = makeTempWebDir();
  try {
    const first = await buildManifest(dir);
    const second = await buildManifest(dir);
    assert.deepEqual(first, second);
    assert.equal(first.data.length, DATA_BUNDLES.length);
    assert.ok(fs.existsSync(path.resolve('web/public/data/manifest.json')));
    assert.ok(fs.existsSync(path.resolve('web/public/data/sw-manifest.js')));

    // Editing a shell file rotates shellHash only, leaving every data hash untouched.
    fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: #222; }');
    const afterCss = await buildManifest(dir);
    assert.notEqual(afterCss.shellHash, first.shellHash);
    assert.equal(afterCss.dataHash, first.dataHash);
    assert.deepEqual(afterCss.data, first.data);

    // Editing one data bundle rotates only that entry and dataHash, leaving shellHash untouched.
    fs.writeFileSync(path.join(dir, 'data', 'glossary.json'), JSON.stringify({ id: 'glossary', rev: 2 }));
    const afterGlossary = await buildManifest(dir);
    assert.equal(afterGlossary.shellHash, afterCss.shellHash);
    assert.notEqual(afterGlossary.dataHash, afterCss.dataHash);
    const prevGloss = afterCss.data.find(d => d.id === 'glossary');
    const nextGloss = afterGlossary.data.find(d => d.id === 'glossary');
    assert.notEqual(nextGloss.sha256, prevGloss.sha256);
    assert.equal(
      afterGlossary.data.find(d => d.id === 'dichotomous').sha256,
      afterCss.data.find(d => d.id === 'dichotomous').sha256
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service worker precaches only the app shell, preserves data/photos caches, and serves cached data offline', async () => {
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const oldShell = await cachesApi.open('vicflora-shell-oldoldoldold');
  await oldShell.put('/index.html', new Response('stale'));
  const dataCache = await cachesApi.open(DATA_CACHE_NAME);
  await dataCache.put('/data/glossary.json?v=abc123', new Response('{"terms":1}', { headers: { 'Content-Type': 'application/json' } }));
  const photoCache = await cachesApi.open(PHOTOS_CACHE_NAME);
  await photoCache.put('/data/photos/photos-00.bin', new Response('webp'));

  const manifest = {
    version: 1,
    shellHash: 'new123456789',
    dataHash: 'data987654321',
    shell: ['./', './index.html', './app.js'],
    data: [{ id: 'glossary', path: './data/glossary.json', url: './data/glossary.json?v=abc123', sha256: 'abc123', bytes: 11 }]
  };

  const fetched = [];
  const sw = loadServiceWorker({
    manifest,
    cachesApi,
    fetchImpl: async req => {
      const url = typeof req === 'string' ? req : req.url;
      fetched.push(url);
      const ct = url.endsWith('.js') ? 'application/javascript' : 'text/html';
      return new Response(`body:${url}`, { status: 200, headers: { 'Content-Type': ct } });
    }
  });

  await sw.dispatchLifecycle('install');
  assert.deepEqual(fetched.sort(), [
    'https://vicflora.test/',
    'https://vicflora.test/app.js',
    'https://vicflora.test/index.html'
  ]);

  await sw.dispatchLifecycle('activate');
  const cacheNames = (await cachesApi.keys()).sort();
  assert.deepEqual(cacheNames, [DATA_CACHE_NAME, PHOTOS_CACHE_NAME, 'vicflora-shell-new123456789']);
  assert.ok(sw.posted.some(m => m.type === 'sw-cache-ready' && m.shellHash === 'new123456789'));

  // Synthesized manifest matches the active SW's embedded manifest.
  const manifestRes = await sw.dispatchFetch(new Request(`${ORIGIN}data/manifest.json`));
  assert.deepEqual(await manifestRes.json(), manifest);

  // Versioned and unversioned data reads resolve from vicflora-data without hitting the network.
  const exactRes = await sw.dispatchFetch(new Request(`${ORIGIN}data/glossary.json?v=abc123`));
  assert.deepEqual(await exactRes.json(), { terms: 1 });
  const fallbackRes = await sw.dispatchFetch(new Request(`${ORIGIN}data/glossary.json`));
  assert.deepEqual(await fallbackRes.json(), { terms: 1 });
});

test('syncCachePack verifies SHA-256/size, resumes incrementally, prunes obsolete URLs, and handles quota errors', async () => {
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const aBytes = Buffer.from('{"a":1}');
  const bBytes = Buffer.from('{"b":22}');
  const items = [
    { url: './data/a.json?v=1', bytes: aBytes.length, sha256: sha256(aBytes) },
    { url: './data/b.json?v=2', bytes: bBytes.length, sha256: sha256(bBytes) }
  ];

  // Seed item A and an obsolete file to verify incremental resume + GC.
  const cache = await cachesApi.open(DATA_CACHE_NAME);
  await cache.put(new URL('./data/a.json?v=1', ORIGIN).href, new Response(aBytes));
  await cache.put(new URL('./data/old.json?v=0', ORIGIN).href, new Response('old'));

  const fetched = [];
  const res = await syncCachePack({
    cacheName: DATA_CACHE_NAME,
    items,
    cachesApi,
    baseUrl: ORIGIN,
    retryBaseMs: 1,
    fetchImpl: async url => {
      fetched.push(url);
      return new Response(bBytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(res.synced, true);
  assert.deepEqual(fetched, ['./data/b.json?v=2']);
  assert.deepEqual(
    (await cache.keys()).map(k => k.url).sort(),
    [`${ORIGIN}data/a.json?v=1`, `${ORIGIN}data/b.json?v=2`]
  );

  // Rejects corrupted payload without polluting cache.
  const badCaches = new FakeCacheStorage(ORIGIN);
  await assert.rejects(
    syncCachePack({
      cacheName: DATA_CACHE_NAME,
      items: [items[0]],
      cachesApi: badCaches,
      baseUrl: ORIGIN,
      maxRetries: 1,
      retryBaseMs: 1,
      fetchImpl: async () => new Response(Buffer.from('{"a":9}'), { status: 200 })
    }),
    /SHA-256 verification failed/
  );
  assert.equal((await (await badCaches.open(DATA_CACHE_NAME)).keys()).length, 0);

  // Handles QuotaExceededError gracefully.
  const quotaCaches = new FakeCacheStorage(ORIGIN);
  const quotaCache = await quotaCaches.open(DATA_CACHE_NAME);
  quotaCache.putError = Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
  const quotaResult = await syncCachePack({
    cacheName: DATA_CACHE_NAME,
    items: [items[0]],
    cachesApi: quotaCaches,
    baseUrl: ORIGIN,
    retryBaseMs: 1,
    fetchImpl: async () => new Response(aBytes, { status: 200 })
  });
  assert.equal(quotaResult.quotaExceeded, true);
  assert.equal(quotaResult.skippedReason, 'quota');
});

test('createDataStore deduplicates concurrent reads and falls back to prior cached version offline', async () => {
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const payload = Buffer.from('{"glossary":["acuminate"]}');
  const manifest = {
    shellHash: 's1',
    dataHash: 'd1',
    data: [{ id: 'glossary', path: './data/glossary.json', url: './data/glossary.json?v=new', sha256: sha256(payload), bytes: payload.length }]
  };

  let fetches = 0;
  const store = createDataStore({
    cachesApi,
    baseUrl: ORIGIN,
    fetchImpl: async url => {
      if (String(url).includes('manifest.json')) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      fetches += 1;
      await new Promise(r => setTimeout(r, 10));
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  const [r1, r2] = await Promise.all([store.readJson('glossary'), store.readJson('glossary')]);
  assert.deepEqual(r1, { glossary: ['acuminate'] });
  assert.deepEqual(r2, { glossary: ['acuminate'] });
  assert.equal(fetches, 1);

  // Offline fallback when manifest points to a newer URL not yet cached.
  const offlineStore = createDataStore({
    cachesApi,
    baseUrl: ORIGIN,
    navigatorObj: { onLine: false },
    retryBaseMs: 1,
    fetchImpl: async url => {
      if (String(url).includes('manifest.json')) {
        return new Response(
          JSON.stringify({
            shellHash: 's2',
            dataHash: 'd2',
            data: [{ id: 'glossary', path: './data/glossary.json', url: './data/glossary.json?v=newer', sha256: 'deadbeef', bytes: 99 }]
          }),
          { status: 200 }
        );
      }
      throw new TypeError('Offline');
    }
  });
  assert.deepEqual(await offlineStore.readJson('glossary'), { glossary: ['acuminate'] });
});

test('createOfflineManager waits for both active SW and data sync, and reloads once on SW update', async () => {
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const payload = Buffer.from('{"keys":[]}');
  const manifest = {
    shellHash: 's1',
    dataHash: 'd1',
    data: [{ id: 'dichotomous', path: './data/dichotomous-keys.json', url: './data/dichotomous-keys.json?v=1', sha256: sha256(payload), bytes: payload.length }]
  };
  const dataStore = createDataStore({
    cachesApi,
    baseUrl: ORIGIN,
    fetchImpl: async url =>
      new Response(String(url).includes('manifest.json') ? JSON.stringify(manifest) : payload, { status: 200 })
  });

  const swListeners = new Map();
  const worker = { state: 'installing', addEventListener: (e, fn) => { worker._cb = fn; } };
  const sw = {
    controller: null,
    register: async () => ({ installing: worker, addEventListener: () => {} }),
    addEventListener: (e, fn) => swListeners.set(e, fn)
  };

  let reloads = 0;
  const states = [];
  const mgr = createOfflineManager({
    dataStore,
    navigator: { onLine: true, serviceWorker: sw },
    window: { addEventListener: () => {} },
    document: { visibilityState: 'visible', addEventListener: () => {} },
    onStateChange: s => states.push(s.status),
    onReload: () => { reloads += 1; },
    retryDelaysMs: []
  });

  mgr.start();
  await new Promise(r => setTimeout(r, 20));
  assert.notEqual(mgr.getState().status, 'ready'); // Still waiting on worker activation

  worker.state = 'activated';
  worker._cb();
  await mgr.waitUntilReady();
  assert.equal(mgr.getState().status, 'ready');
  assert.equal(reloads, 0);

  // First controllerchange claims initial client (no reload); second is an update (reloads once).
  swListeners.get('controllerchange')();
  assert.equal(reloads, 0);
  swListeners.get('controllerchange')();
  swListeners.get('controllerchange')();
  assert.equal(reloads, 1);
});

test('createRetryableLoader coalesces calls and retries an in-flight failure when requested', async () => {
  let calls = 0;
  let rejectFirst;
  const loader = createRetryableLoader(() => {
    calls += 1;
    if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return Promise.resolve();
  });

  const p1 = loader.run();
  const p2 = loader.run({ retryIfInFlight: true });
  rejectFirst(new Error('transient'));
  assert.equal(await p1, true);
  assert.equal(await p2, true);
  assert.equal(calls, 2);
  assert.equal(loader.isCompleted(), true);
});
