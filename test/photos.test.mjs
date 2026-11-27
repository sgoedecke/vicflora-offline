import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  PhotoStore,
  formatBytes,
  getActiveImageKeys,
  getDrawingMeta,
  getPhotoMeta,
  getTaxonMediaMetas,
  groupEntriesByShard,
  isConstrainedConnection,
  isValidWebpBytes,
  resolveOnlineUrl
} from '../web/public/modules/photos.js';

const require = createRequire(import.meta.url);
const {
  formatAttribution,
  formatDrawingCaption,
  pickBestDrawing
} = require('../scripts/fetch-photos.js');
const { compilePhotosIndex } = require('../scripts/build-web-data.js');

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeWebP(tag) {
  const payload = Buffer.from(tag, 'utf8');
  const buf = Buffer.alloc(12 + payload.length);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(4 + payload.length, 4);
  buf.write('WEBP', 8, 'ascii');
  payload.copy(buf, 12);
  return new Uint8Array(buf);
}

function makeShard(filePrefix, images) {
  const chunks = [];
  let offset = 0;
  const entries = [];
  for (const img of images) {
    const hash = sha256Hex(img).slice(0, 12);
    entries.push({ offset, length: img.byteLength, hash, bytes: img });
    chunks.push(img);
    offset += img.byteLength;
  }
  const combined = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    combined.set(c, pos);
    pos += c.byteLength;
  }
  const sha256 = sha256Hex(combined);
  const file = `${filePrefix}-${sha256.slice(0, 12)}.bin`;
  return { file, sha256, bytes: combined.byteLength, count: images.length, buffer: combined, entries };
}

function createMemoryDb({ hangGetImage = false, quotaOnPut = false } = {}) {
  const images = new Map();
  const meta = new Map();
  return {
    images,
    meta,
    isSupported: () => true,
    async getImage(key) {
      if (hangGetImage) return new Promise(() => {});
      return images.get(key) ?? null;
    },
    async putShardAtomic(entries, metaKey, metaValue) {
      if (quotaOnPut) {
        const err = new Error('Quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      for (const [key, bytes] of entries) {
        images.set(key, bytes);
      }
      meta.set(metaKey, metaValue);
    },
    async getAllImageKeys() {
      return [...images.keys()];
    },
    async deleteImages(keys) {
      for (const key of keys) images.delete(key);
    },
    async getMeta(key) {
      return meta.get(key) ?? null;
    },
    async putMeta(key, value) {
      meta.set(key, value);
    },
    async clearAll() {
      images.clear();
      meta.clear();
    }
  };
}

function createFakeUrlApi() {
  let seq = 0;
  const active = new Map();
  const revoked = [];
  return {
    active,
    revoked,
    createObjectURL(blob) {
      const url = `blob:test-${++seq}`;
      active.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      active.delete(url);
      revoked.push(url);
    }
  };
}

function makeBinaryResponse(uint8, { status = 200, contentType = 'application/octet-stream' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength)
  };
}

function makeJsonResponse(data, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => data
  };
}

test('formatAttribution formats CC, copyright, HTML, and deduplicated credits cleanly', () => {
  assert.equal(
    formatAttribution({
      creator: 'Annabel Carle',
      copyrightOwner: 'Annabel Carle',
      license: 'CC BY-NC-SA 4.0',
      rights: 'Copyright 2011 Royal Botanic Gardens Board'
    }),
    'Annabel Carle · CC BY-NC-SA 4.0'
  );

  assert.equal(
    formatAttribution({
      creator: 'Carle, Geoff',
      copyrightOwner: 'Geoff Carle',
      license: null,
      rights: '©Geoff Carle'
    }),
    '© Carle, Geoff'
  );

  assert.equal(
    formatAttribution({
      creator: 'Walsh, Neville G.',
      copyrightOwner: 'Royal Botanic Gardens Victoria',
      license: 'CC BY-NC-SA 4.0',
      rights: null
    }),
    'Walsh, Neville G. · Royal Botanic Gardens Victoria · CC BY-NC-SA 4.0'
  );

  assert.equal(
    formatAttribution({
      creator: null,
      copyrightOwner: null,
      license: null,
      rights: 'Reproduced from <i>Flora of Victoria</i>.'
    }),
    'Reproduced from Flora of Victoria.'
  );

  assert.equal(
    formatAttribution({
      creator: null,
      copyrightOwner: 'Royal Botanic Gardens Victoria',
      license: 'CC BY-NC-SA 4.0',
      rights: null
    }),
    'Royal Botanic Gardens Victoria · CC BY-NC-SA 4.0'
  );

  assert.equal(
    formatAttribution({
      creator: 'Muchan, John.',
      copyrightOwner: 'John Muchan',
      license: 'CC BY-NC-SA 4.0',
      rights: null
    }),
    'Muchan, John. · CC BY-NC-SA 4.0'
  );

  assert.equal(
    formatAttribution({
      creator: 'Jane Doe',
      copyrightOwner: 'Royal Botanic Gardens Victoria',
      license: null,
      rights: null
    }),
    'Jane Doe · Royal Botanic Gardens Victoria'
  );

  assert.equal(formatAttribution({}), 'VicFlora');
});

test('photo helpers resolve URLs, content-addressed keys, shards, WebP headers, and connection hints', () => {
  const index = {
    version: '1',
    cdnPrefix: 'https://cdn.example/preview/',
    credits: ['Alice · CC BY 4.0', '© Bob', 'Carol'],
    shards: [
      { file: 'photos-00-aaaa.bin', sha256: 'a'.repeat(64), bytes: 40, count: 2 },
      { file: 'photos-01-bbbb.bin', sha256: 'b'.repeat(64), bytes: 20, count: 1 }
    ],
    media: {
      a: [{ kind: 'photo', shard: 0, offset: 0, length: 20, hash: 'hashA1111111', credit: 0, url: 'abc.jpg' }],
      b: [{ kind: 'photo', shard: 0, offset: 0, length: 20, hash: 'hashA1111111', credit: 0, url: 'abc.jpg' }], // shared hero image
      c: [{ kind: 'photo', shard: 0, offset: 20, length: 20, hash: 'hashC3333333', credit: 1, url: 'https://other.example/c.jpg' }],
      d: [{ kind: 'photo', shard: 1, offset: 0, length: 20, hash: 'hashD4444444', credit: 2, url: 'def.jpg' }]
    }
  };

  assert.equal(resolveOnlineUrl(index, 'abc.jpg'), 'https://cdn.example/preview/abc.jpg');
  assert.equal(resolveOnlineUrl(index, 'https://other.example/c.jpg'), 'https://other.example/c.jpg');

  const metaA = getPhotoMeta(index, 'a');
  assert.deepEqual(metaA, {
    shard: 0,
    offset: 0,
    length: 20,
    key: 'hashA1111111',
    kind: 'photo',
    caption: '',
    attribution: 'Alice · CC BY 4.0',
    onlineUrl: 'https://cdn.example/preview/abc.jpg'
  });
  assert.equal(getPhotoMeta(index, 'missing'), null);

  const grouped = groupEntriesByShard(index);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].size, 2); // a and b deduplicated by content hash
  assert.equal(grouped[1].size, 1);

  assert.equal(isValidWebpBytes(makeWebP('hello')), true);
  assert.equal(isValidWebpBytes(new Uint8Array([60, 104, 116, 109, 108, 62])), false);
  assert.equal(isConstrainedConnection({ saveData: true }), true);
  assert.equal(isConstrainedConnection({ effectiveType: '2g' }), true);
  assert.equal(isConstrainedConnection({ effectiveType: '4g', saveData: false }), false);

  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3.5 * 1024 * 1024), '3.5 MB');
  assert.equal(formatBytes(65 * 1024 * 1024), '65 MB');
});

test('PhotoStore syncs verified shards, skips when current, incrementally updates, and GCs obsolete images', async () => {
  const imgA = makeWebP('species-A');
  const imgC = makeWebP('species-C');
  const imgD = makeWebP('species-D');
  const imgD2 = makeWebP('species-D-updated');

  const s0 = makeShard('photos-00', [imgA, imgC]);
  const s1 = makeShard('photos-01', [imgD]);
  const s1New = makeShard('photos-01', [imgD2]);

  let currentIndex = {
    version: 'v-hash-1',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0.bytes + s1.bytes,
    totalImages: 3,
    taxaCount: 4,
    credits: ['Alice', 'Bob', 'Carol'],
    shards: [
      { file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 2 },
      { file: s1.file, sha256: s1.sha256, bytes: s1.bytes, count: 1 }
    ],
    media: {
      a: [{ kind: 'photo', shard: 0, offset: s0.entries[0].offset, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }],
      b: [{ kind: 'photo', shard: 0, offset: s0.entries[0].offset, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }],
      c: [{ kind: 'photo', shard: 0, offset: s0.entries[1].offset, length: s0.entries[1].length, hash: s0.entries[1].hash, credit: 1, url: 'c.jpg' }],
      d: [{ kind: 'photo', shard: 1, offset: s1.entries[0].offset, length: s1.entries[0].length, hash: s1.entries[0].hash, credit: 2, url: 'd.jpg' }]
    }
  };

  const blobs = new Map([
    [s0.file, s0.buffer],
    [s1.file, s1.buffer],
    [s1New.file, s1New.buffer]
  ]);
  const fetched = [];
  const fetchImpl = async url => {
    fetched.push(url);
    if (url.endsWith('/index.json')) return makeJsonResponse(currentIndex);
    const file = url.split('/').pop();
    if (blobs.has(file)) return makeBinaryResponse(blobs.get(file));
    return { ok: false, status: 404, headers: new Headers() };
  };

  const db = createMemoryDb();
  const urlApi = createFakeUrlApi();
  const store = new PhotoStore({
    baseUrl: './data/photos',
    fetchImpl,
    db,
    urlApi,
    navigatorObj: { onLine: true },
    retryBaseMs: 1
  });

  // Before sync: falls back online.
  const [onlineA] = await store.getMediaSources('a');
  assert.equal(onlineA.offline, false);
  assert.equal(onlineA.src, 'https://cdn.example/a.jpg');

  // Sync shards and verify per-shard callbacks & progress.
  const shardCallbacks = [];
  const events = [];
  const firstSync = await store.syncPack({
    onProgress: e => events.push(e),
    onShardComplete: info => shardCallbacks.push(info)
  });
  assert.equal(firstSync.synced, true);
  assert.equal(firstSync.downloadedBytes, currentIndex.totalBytes);
  assert.equal(shardCallbacks.length, 2);
  assert.equal(events.at(-1).phase, 'done');
  assert.equal(db.images.size, 3);

  // Subsequent sync fetches only index.json (re-check) and ZERO shard binaries.
  fetched.length = 0;
  const noopSync = await store.syncPack();
  assert.equal(noopSync.synced, false);
  assert.equal(noopSync.upToDate, true);
  assert.equal(noopSync.downloadedBytes, 0);
  assert.deepEqual(fetched, ['./data/photos/index.json']);

  // Offline retrieval returns exact unpacked bytes and deduplicates shared keys.
  const [offlineA] = await store.getMediaSources('a');
  const [offlineB] = await store.getMediaSources('b');
  assert.equal(offlineA.offline, true);
  assert.equal(offlineA.src, offlineB.src);
  assert.deepEqual(new Uint8Array(await urlApi.active.get(offlineA.src).arrayBuffer()), imgA);

  // Incremental pack update: shard 0 unchanged, shard 1 replaced with new content-addressed filename.
  currentIndex = {
    ...currentIndex,
    version: 'v-hash-2',
    totalBytes: s0.bytes + s1New.bytes,
    credits: ['Alice', 'Bob', 'Carol 2'],
    shards: [
      { file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 2 },
      { file: s1New.file, sha256: s1New.sha256, bytes: s1New.bytes, count: 1 }
    ],
    media: {
      ...currentIndex.media,
      d: [{ kind: 'photo', shard: 1, offset: s1New.entries[0].offset, length: s1New.entries[0].length, hash: s1New.entries[0].hash, credit: 2, url: 'd2.jpg' }]
    }
  };

  fetched.length = 0;
  const incSync = await store.syncPack();
  assert.equal(incSync.synced, true);
  assert.equal(incSync.downloadedBytes, s1New.bytes);
  assert.deepEqual(fetched, ['./data/photos/index.json', `./data/photos/${s1New.file}`]);
  // Obsolete imgD key was garbage-collected after sync succeeded!
  assert.equal(db.images.has(s1.entries[0].hash), false);
  assert.equal(db.images.has(s1New.entries[0].hash), true);
  assert.equal(db.images.size, 3);
});

test('C1 regression: manifest update without re-sync never serves wrong-species bytes at offset 0', async () => {
  const imgA = makeWebP('old-species-A');
  const imgB = makeWebP('new-species-B');
  const s0Old = makeShard('photos-00', [imgA]);
  const s0New = makeShard('photos-00', [imgB]);

  const oldIndex = {
    version: 'v1',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0Old.bytes,
    totalImages: 1,
    credits: ['Old Credit'],
    shards: [{ file: s0Old.file, sha256: s0Old.sha256, bytes: s0Old.bytes, count: 1 }],
    media: {
      taxonA: [{ kind: 'photo', shard: 0, offset: 0, length: s0Old.entries[0].length, hash: s0Old.entries[0].hash, credit: 0, url: 'old.jpg' }]
    }
  };

  const newIndex = {
    version: 'v2',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0New.bytes,
    totalImages: 1,
    credits: ['New Credit'],
    shards: [{ file: s0New.file, sha256: s0New.sha256, bytes: s0New.bytes, count: 1 }],
    media: {
      // Offset 0 of shard 0 is now assigned to taxonB with a different content hash!
      taxonB: [{ kind: 'photo', shard: 0, offset: 0, length: s0New.entries[0].length, hash: s0New.entries[0].hash, credit: 0, url: 'new.jpg' }]
    }
  };

  const db = createMemoryDb();
  const urlApi = createFakeUrlApi();
  const storeV1 = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi,
    navigatorObj: { onLine: true },
    fetchImpl: async url => (url.endsWith('/index.json') ? makeJsonResponse(oldIndex) : makeBinaryResponse(s0Old.buffer))
  });
  await storeV1.syncPack();

  // Now simulate a new index arriving BEFORE shard sync runs (e.g. offline right after update).
  const storeV2 = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi,
    navigatorObj: { onLine: false },
    fetchImpl: async () => makeJsonResponse(newIndex)
  });
  storeV2.index = newIndex;

  const [resultB] = await storeV2.getMediaSources('taxonB');
  // MUST NOT return old-species-A bytes with New Credit!
  assert.equal(resultB.offline, false);
  assert.equal(resultB.deferred, true);
  assert.equal(resultB.src, null);
});

test('C2 regression: rejects captive-portal HTML 200, truncated body, and bad SHA-256 without poisoning IDB', async () => {
  const imgA = makeWebP('real-image');
  const s0 = makeShard('photos-00', [imgA]);
  const index = {
    version: 'v-verify',
    format: 'image/webp',
    totalBytes: s0.bytes,
    totalImages: 1,
    credits: ['Alice'],
    shards: [{ file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }] }
  };

  const badResponses = [
    // Captive portal / Netlify SPA fallback returning HTML 200
    () => makeBinaryResponse(new TextEncoder().encode('<html>Portal</html>'), { contentType: 'text/html' }),
    // Truncated body
    () => makeBinaryResponse(s0.buffer.slice(0, 6)),
    // Same byte length as expected, but corrupted bytes (SHA-256 mismatch)
    () => {
      const corrupted = new Uint8Array(s0.buffer);
      corrupted[corrupted.length - 1] ^= 0xff;
      return makeBinaryResponse(corrupted);
    }
  ];

  for (const makeBad of badResponses) {
    const db = createMemoryDb();
    const store = new PhotoStore({
      baseUrl: './data/photos',
      db,
      urlApi: createFakeUrlApi(),
      navigatorObj: { onLine: true },
      maxShardRetries: 1,
      retryBaseMs: 1,
      fetchImpl: async url => (url.endsWith('/index.json') ? makeJsonResponse(index) : makeBad())
    });

    await assert.rejects(() => store.syncPack());
    assert.equal(db.images.size, 0, 'bad bytes must never be committed to IDB');
    const status = await store.getStatus();
    assert.equal(status.synced, false, 'pack must never be marked synced after bad bytes');
  }
});

test('C3 regression: full pack refresh that fails mid-way keeps previous offline photos intact', async () => {
  const imgA = makeWebP('photo-A');
  const imgB = makeWebP('photo-B-new');
  const sOld = makeShard('photos-00', [imgA]);
  const sNew = makeShard('photos-00', [imgB]);

  const indexV1 = {
    version: 'v1',
    format: 'image/webp',
    totalBytes: sOld.bytes,
    totalImages: 1,
    credits: ['Alice'],
    shards: [{ file: sOld.file, sha256: sOld.sha256, bytes: sOld.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: sOld.entries[0].length, hash: sOld.entries[0].hash, credit: 0, url: 'a.jpg' }] }
  };

  const indexV2 = {
    version: 'v2',
    format: 'image/webp',
    totalBytes: sNew.bytes,
    totalImages: 1,
    credits: ['Alice', 'Bob'],
    shards: [{ file: sNew.file, sha256: sNew.sha256, bytes: sNew.bytes, count: 1 }],
    media: {
      a: [{ kind: 'photo', shard: 0, offset: 0, length: sOld.entries[0].length, hash: sOld.entries[0].hash, credit: 0, url: 'a.jpg' }],
      b: [{ kind: 'photo', shard: 0, offset: 0, length: sNew.entries[0].length, hash: sNew.entries[0].hash, credit: 1, url: 'b.jpg' }]
    }
  };

  const db = createMemoryDb();
  const urlApi = createFakeUrlApi();
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi,
    navigatorObj: { onLine: true },
    maxShardRetries: 1,
    retryBaseMs: 1,
    fetchImpl: async url => (url.endsWith('/index.json') ? makeJsonResponse(indexV1) : makeBinaryResponse(sOld.buffer))
  });
  await store.syncPack();
  assert.equal(db.images.has(sOld.entries[0].hash), true);

  // Now simulate v2 where the ONLY shard changed and its fetch fails on weak trailhead signal.
  store.fetch = async url => {
    if (url.endsWith('/index.json')) return makeJsonResponse(indexV2);
    throw new Error('Trailhead signal dropped');
  };
  await assert.rejects(() => store.syncPack(), /Trailhead signal dropped/);

  // Existing offline photo A MUST still be intact in IDB!
  assert.equal(db.images.has(sOld.entries[0].hash), true);
  const [offlineA] = await store.getMediaSources('a');
  assert.equal(offlineA.offline, true);
});

test('H1 regression: hung IndexedDB lookup times out cleanly instead of blocking species rendering', async () => {
  const db = createMemoryDb({ hangGetImage: true });
  const index = {
    version: 'v1',
    credits: ['Alice'],
    shards: [{ file: 'photos-00-aaa.bin', sha256: 'a'.repeat(64), bytes: 20, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: 20, hash: 'hashA', credit: 0, url: 'a.jpg' }] }
  };
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true },
    fetchImpl: async () => makeJsonResponse(index)
  });
  store.index = index;

  const start = Date.now();
  const result = await store.getMediaSources('a', { timeoutMs: 40 });
  const elapsed = Date.now() - start;
  assert.deepEqual(result, []);
  assert.ok(elapsed < 500, `lookup should time out quickly, took ${elapsed}ms`);
});

test('H2 regression: stalled mid-stream fetch aborts on idle timeout and succeeds on retry', async () => {
  const imgA = makeWebP('stalled-then-ok');
  const s0 = makeShard('photos-00', [imgA]);
  const index = {
    version: 'v-stall',
    format: 'image/webp',
    totalBytes: s0.bytes,
    totalImages: 1,
    credits: ['Alice'],
    shards: [{ file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }] }
  };

  let shardAttempts = 0;
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/index.json')) return makeJsonResponse(index);
    shardAttempts += 1;
    if (shardAttempts === 1) {
      // Simulate TCP open, headers sent, stream stalls forever until aborted.
      let chunkSent = false;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        body: {
          getReader() {
            return {
              read() {
                if (!chunkSent) {
                  chunkSent = true;
                  return Promise.resolve({ done: false, value: s0.buffer.slice(0, 4) });
                }
                return new Promise((_, reject) => {
                  opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });
              },
              cancel: async () => {}
            };
          }
        }
      };
    }
    return makeBinaryResponse(s0.buffer);
  };

  const db = createMemoryDb();
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true },
    idleTimeoutMs: 50,
    maxShardRetries: 2,
    retryBaseMs: 5,
    fetchImpl
  });

  const result = await store.syncPack();
  assert.equal(result.synced, true);
  assert.equal(shardAttempts, 2);
  assert.equal(db.images.size, 1);
});

test('H4/M3/M4 regressions: Save-Data deferral, cross-tab lock contention, and QuotaExceededError handling', async () => {
  const imgA = makeWebP('constrained-img');
  const s0 = makeShard('photos-00', [imgA]);
  const index = {
    version: 'v-net',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0.bytes,
    totalImages: 1,
    credits: ['Alice'],
    shards: [{ file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }] }
  };
  const fetchImpl = async url => (url.endsWith('/index.json') ? makeJsonResponse(index) : makeBinaryResponse(s0.buffer));

  // Save-Data / 2G skips auto-sync and defers remote preview unless forceRemote is set.
  const constrainedStore = new PhotoStore({
    baseUrl: './data/photos',
    db: createMemoryDb(),
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true, connection: { saveData: true, effectiveType: '2g' } },
    fetchImpl
  });
  const skipped = await constrainedStore.syncPack();
  assert.equal(skipped.synced, false);
  assert.equal(skipped.skippedReason, 'constrained-network');

  // On Save-Data with no cached index, getMediaSources does not burn 976 KB fetching index.json.
  const noIndexPhoto = await constrainedStore.getMediaSources('a');
  assert.deepEqual(noIndexPhoto, []);

  // Once index is cached (e.g. from earlier wifi visit), Save-Data defers remote preview unless forceRemote is set.
  constrainedStore.index = index;
  const [deferredPhoto] = await constrainedStore.getMediaSources('a');
  assert.equal(deferredPhoto.deferred, true);
  assert.equal(deferredPhoto.src, null);

  const [forcedPhoto] = await constrainedStore.getMediaSources('a', { forceRemote: true });
  assert.equal(forcedPhoto.deferred, false);
  assert.equal(forcedPhoto.src, 'https://cdn.example/a.jpg');

  // Force override still syncs on Save-Data.
  const forcedSync = await constrainedStore.syncPack({ force: true });
  assert.equal(forcedSync.synced, true);

  // Cross-tab navigator.locks prevents concurrent syncs.
  let lockHeld = false;
  const fakeLocks = {
    async request(_name, opts, cb) {
      if (opts.ifAvailable && lockHeld) return cb(null);
      lockHeld = true;
      try {
        return await cb({});
      } finally {
        lockHeld = false;
      }
    }
  };
  const dbLock = createMemoryDb();
  let releaseFetch;
  const slowFetch = async url => {
    if (url.endsWith('/index.json')) return makeJsonResponse(index);
    await new Promise(resolve => { releaseFetch = resolve; });
    return makeBinaryResponse(s0.buffer);
  };
  const tab1 = new PhotoStore({
    baseUrl: './data/photos',
    db: dbLock,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true, locks: fakeLocks },
    fetchImpl: slowFetch
  });
  const tab2 = new PhotoStore({
    baseUrl: './data/photos',
    db: dbLock,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true, locks: fakeLocks },
    fetchImpl
  });
  const p1 = tab1.syncPack();
  await new Promise(resolve => setTimeout(resolve, 10));
  const r2 = await tab2.syncPack();
  assert.equal(r2.skippedReason, 'locked');
  releaseFetch();
  const r1 = await p1;
  assert.equal(r1.synced, true);

  // QuotaExceededError fails cleanly without throwing unhandled rejection.
  const quotaStore = new PhotoStore({
    baseUrl: './data/photos',
    db: createMemoryDb({ quotaOnPut: true }),
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true },
    fetchImpl
  });
  const qRes = await quotaStore.syncPack();
  assert.equal(qRes.synced, false);
  assert.equal(qRes.quotaExceeded, true);
});

test('QA regressions: pre-header retry, failed v2 preserves v1 index, empty index guard, pendingReads recovery, getStatus zero-network', async () => {
  const imgA1 = makeWebP('species-A-v1');
  const imgA2 = makeWebP('species-A-v2');
  const s1 = makeShard('photos-00', [imgA1]);
  const s2 = makeShard('photos-00', [imgA2]);

  const indexV1 = {
    version: 'v1',
    format: 'image/webp',
    totalBytes: s1.bytes,
    totalImages: 1,
    credits: ['Alice v1'],
    shards: [{ file: s1.file, sha256: s1.sha256, bytes: s1.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s1.entries[0].length, hash: s1.entries[0].hash, credit: 0, url: 'a1.jpg' }] }
  };
  const indexV2 = {
    version: 'v2',
    format: 'image/webp',
    totalBytes: s2.bytes,
    totalImages: 1,
    credits: ['Alice v2'],
    shards: [{ file: s2.file, sha256: s2.sha256, bytes: s2.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s2.entries[0].length, hash: s2.entries[0].hash, credit: 0, url: 'a2.jpg' }] }
  };

  // 1. Pre-header fetch() throw retries and succeeds on attempt 2.
  let preHeaderAttempts = 0;
  let indexFetches = 0;
  const db = createMemoryDb();
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true },
    maxShardRetries: 3,
    retryBaseMs: 1,
    fetchImpl: async url => {
      if (url.endsWith('/index.json')) {
        indexFetches += 1;
        return makeJsonResponse(indexV1);
      }
      preHeaderAttempts += 1;
      if (preHeaderAttempts === 1) throw new TypeError('Failed to fetch');
      return makeBinaryResponse(s1.buffer);
    }
  });

  // getStatus() before sync makes 0 network fetches (important for boot & Save-Data/2g).
  await store.getStatus();
  assert.equal(indexFetches, 0);

  const syncRes = await store.syncPack();
  assert.equal(syncRes.synced, true);
  assert.equal(preHeaderAttempts, 2, 'pre-header fetch error must be retried');
  assert.equal(indexFetches, 1);

  // 2. Empty fallback index must NOT wipe working in-memory index.
  store.fetch = async () => makeJsonResponse({ version: '0', totalBytes: 0, totalImages: 0, shards: [], credits: [], media: {} });
  await store.syncPack();
  assert.equal((await store.getMediaSources('a'))[0].offline, true);

  // 3. Failed v2 update over working v1 pack keeps v1 index intact so taxon A (whose imgHash changed) still works offline!
  store.fetch = async url => {
    if (url.endsWith('/index.json')) return makeJsonResponse(indexV2);
    throw new TypeError('Dropped at trailhead');
  };
  await assert.rejects(() => store.syncPack());
  store.navigator = { onLine: false };
  const [stillV1] = await store.getMediaSources('a');
  assert.equal(stillV1.offline, true);
  assert.equal(stillV1.attribution, 'Alice v1');
  assert.equal((await db.getMeta('index')).version, 'v1');

  // 4. Hung db.getImage() clears pendingReads on timeout so subsequent read after recovery succeeds.
  let hangNext = true;
  const flakyDb = createMemoryDb();
  flakyDb.images.set(s1.entries[0].hash, imgA1);
  const origGetImage = flakyDb.getImage.bind(flakyDb);
  flakyDb.getImage = key => (hangNext ? new Promise(() => {}) : origGetImage(key));

  const flakyStore = new PhotoStore({
    baseUrl: './data/photos',
    db: flakyDb,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: false },
    fetchImpl: async () => makeJsonResponse(indexV1)
  });
  flakyStore.index = indexV1;

  const timedOut = await flakyStore.getMediaSources('a', { timeoutMs: 30 });
  assert.ok(timedOut.length === 0 || timedOut[0].offline === false);
  // Allow inner timeout cleanup microtask, then recover IDB.
  await new Promise(r => setTimeout(r, 20));
  hangNext = false;
  const [recovered] = await flakyStore.getMediaSources('a', { timeoutMs: 200 });
  assert.equal(recovered.offline, true);
});

test('service worker and Netlify config isolate photo assets from SW precache and SPA fallback', () => {
  const sw = fs.readFileSync(new URL('../web/public/service-worker.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/modules\/photos\.js'/);
  // index.json must NOT be in core cache.addAll ASSETS
  assert.doesNotMatch(sw, /'\.\/data\/photos\/index\.json'/);
  // All /data/photos/ requests bypass the service worker
  assert.match(sw, /\/data\/photos\//);

  assert.ok(fs.existsSync(new URL('../web/public/404.html', import.meta.url)),
    'web/public/404.html must exist for Netlify 404 rule');

  const netlify = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const data404Idx = netlify.indexOf('from = "/data/*"');
  const spaFallbackIdx = netlify.indexOf('from = "/*"');
  assert.ok(data404Idx !== -1 && spaFallbackIdx !== -1 && data404Idx < spaFallbackIdx,
    '/data/* 404 rule must precede /* SPA fallback');
  assert.match(netlify, /immutable/);
});

test('drawing metadata helpers clean captions and select best botanical illustration', () => {
  assert.equal(
    formatDrawingCaption(
      'a. habit, ×1; b. spikelet, ×6. Source: Flora of Victoria Vol. 2, Fig. 122a–b. Illustration: Anita Barley.'
    ),
    'a. habit, ×1; b. spikelet, ×6.'
  );
  assert.equal(
    formatDrawingCaption('<b>a.</b> leaf; <i>b.</i> flower (Source: Flora of Victoria Vol. 3)'),
    'a. leaf; b. flower'
  );
  assert.equal(formatDrawingCaption('Source: Flora of Victoria Vol. 2.'), '');

  const picked = pickBestDrawing(
    [
      { id: 'hero-1', subtype: 'Illustration', subjectCategory: 'Flora of Victoria Figure', previewUrl: 'https://cdn/h.jpg' },
      { id: 'photo-1', subtype: 'Photograph', subjectCategory: 'Habit', previewUrl: 'https://cdn/p.jpg' },
      { id: 'draw-other', subtype: 'Illustration', subjectCategory: 'Other', previewUrl: 'https://cdn/o.jpg' },
      { id: 'draw-fov', subtype: 'Illustration', subjectCategory: 'Flora of Victoria Figure', previewUrl: 'https://cdn/f.jpg', caption: 'a. habit' }
    ],
    'hero-1'
  );
  assert.equal(picked.id, 'draw-fov');
  assert.equal(pickBestDrawing([{ id: 'hero-1', subtype: 'Illustration', previewUrl: 'https://cdn/h.jpg' }], 'hero-1'), null);
});

test('dual media: PhotoStore syncs, serves, and garbage-collects paired photos and botanical drawings', async () => {
  const photoImg = makeWebP('species-photo-bytes');
  const drawingImg = makeWebP('botanical-drawing-bytes');
  const heroDrawingImg = makeWebP('hero-only-drawing-bytes');
  const s0 = makeShard('photos-00', [photoImg, drawingImg, heroDrawingImg]);
  const [ePhoto, eDraw, eHeroDraw] = s0.entries;

  const indexV1 = {
    version: 'v-draw-1',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0.bytes,
    totalImages: 3,
    taxaCount: 2,
    drawingsCount: 1,
    credits: [
      'Photographer (CC BY 4.0)',
      'Anita Barley (CC BY-NC-SA 4.0)',
      'Illustrator (CC BY-NC-SA 4.0)'
    ],
    shards: [{ file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 3 }],
    media: {
      'taxon-both': [
        { kind: 'photo', shard: 0, offset: ePhoto.offset, length: ePhoto.length, hash: ePhoto.hash, credit: 0, url: 'p.jpg' },
        { kind: 'drawing', shard: 0, offset: eDraw.offset, length: eDraw.length, hash: eDraw.hash, credit: 1, url: 'd.jpg', caption: 'a. habit, ×1; b. flower, ×4' }
      ],
      'taxon-draw-only': [
        { kind: 'drawing', shard: 0, offset: eHeroDraw.offset, length: eHeroDraw.length, hash: eHeroDraw.hash, credit: 2, url: 'hd.jpg', caption: 'a. habit' }
      ]
    }
  };

  assert.equal(getPhotoMeta(indexV1, 'taxon-both').kind, 'photo');
  assert.equal(getPhotoMeta(indexV1, 'taxon-draw-only').kind, 'drawing');
  assert.equal(getPhotoMeta(indexV1, 'taxon-draw-only').caption, 'a. habit');
  assert.equal(getDrawingMeta(indexV1, 'taxon-both').kind, 'drawing');
  assert.equal(getDrawingMeta(indexV1, 'taxon-both').caption, 'a. habit, ×1; b. flower, ×4');
  assert.equal(getTaxonMediaMetas(indexV1, 'taxon-both').length, 2);
  assert.equal(getTaxonMediaMetas(indexV1, 'taxon-draw-only').length, 1);

  const grouped = groupEntriesByShard(indexV1);
  assert.equal(grouped[0].size, 3);
  assert.equal(getActiveImageKeys(indexV1).size, 3);

  const db = createMemoryDb();
  const urlApi = createFakeUrlApi();
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    urlApi,
    navigatorObj: { onLine: true },
    fetchImpl: async url => (url.endsWith('/index.json') ? makeJsonResponse(indexV1) : makeBinaryResponse(s0.buffer))
  });

  // Before sync, online fallback returns both photo and drawing with kinds + caption.
  const onlineMedia = await store.getMediaSources('taxon-both');
  assert.equal(onlineMedia.length, 2);
  assert.equal(onlineMedia[0].kind, 'photo');
  assert.equal(onlineMedia[0].offline, false);
  assert.equal(onlineMedia[1].kind, 'drawing');
  assert.equal(onlineMedia[1].caption, 'a. habit, ×1; b. flower, ×4');
  assert.equal(onlineMedia[1].onlineUrl, 'https://cdn.example/d.jpg');

  // After sync, both come from offline IndexedDB and GC retains all 3 keys.
  const synced = await store.syncPack();
  assert.equal(synced.synced, true);
  assert.equal(db.images.size, 3);
  const status = await store.getStatus();
  assert.equal(status.drawingsCount, 1);

  const offlineMedia = await store.getMediaSources('taxon-both');
  assert.equal(offlineMedia.length, 2);
  assert.equal(offlineMedia[0].offline, true);
  assert.equal(offlineMedia[1].offline, true);
  assert.equal(offlineMedia[1].kind, 'drawing');
  assert.ok(offlineMedia[1].src.startsWith('blob:test-'));

  const drawOnlyMedia = await store.getMediaSources('taxon-draw-only');
  assert.equal(drawOnlyMedia.length, 1);
  assert.equal(drawOnlyMedia[0].kind, 'drawing');
  assert.equal(drawOnlyMedia[0].caption, 'a. habit');
  assert.equal(drawOnlyMedia[0].offline, true);
});

test('drop offline images & disable resync clears storage, skips sync, and allows re-enabling', async () => {
  const imgA = makeWebP('photo-A');
  const s0 = makeShard('photos-00', [imgA]);
  const indexV1 = {
    version: 'v1',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: s0.bytes,
    totalImages: 1,
    credits: ['Alice'],
    shards: [{ file: s0.file, sha256: s0.sha256, bytes: s0.bytes, count: 1 }],
    media: { a: [{ kind: 'photo', shard: 0, offset: 0, length: s0.entries[0].length, hash: s0.entries[0].hash, credit: 0, url: 'a.jpg' }] }
  };

  const prefsMap = new Map();
  const prefs = {
    getItem: k => (prefsMap.has(k) ? prefsMap.get(k) : null),
    setItem: (k, v) => prefsMap.set(k, String(v)),
    removeItem: k => prefsMap.delete(k)
  };
  let droppedDb = false;
  const db = createMemoryDb();
  db.dropDatabase = async () => {
    droppedDb = true;
    await db.clearAll();
  };

  let shardFetches = 0;
  const store = new PhotoStore({
    baseUrl: './data/photos',
    db,
    prefs,
    urlApi: createFakeUrlApi(),
    navigatorObj: { onLine: true },
    fetchImpl: async url => {
      if (url.endsWith('/index.json')) return makeJsonResponse(indexV1);
      shardFetches += 1;
      return makeBinaryResponse(s0.buffer);
    }
  });

  // Initial sync populates IndexedDB.
  const firstSync = await store.syncPack();
  assert.equal(firstSync.synced, true);
  assert.equal(db.images.size, 1);
  assert.equal(shardFetches, 1);

  // User drops offline images and opts out of resyncing.
  store.setDisabled(true);
  await store.clearPack();
  assert.equal(droppedDb, true);
  assert.equal(db.images.size, 0);
  assert.equal(db.meta.size, 0);
  assert.equal(store.isDisabled(), true);

  // Status reports disabled and does not recreate IDB entries.
  const disabledStatus = await store.getStatus();
  assert.equal(disabledStatus.disabled, true);
  assert.equal(disabledStatus.synced, false);

  // Subsequent syncPack calls are skipped even with force: true while disabled.
  const skipped = await store.syncPack({ force: true });
  assert.equal(skipped.synced, false);
  assert.equal(skipped.skippedReason, 'disabled');
  assert.equal(shardFetches, 1);

  // Online lookup still returns remote preview without writing back to IndexedDB.
  const onlineFallback = await store.getMediaSources('a');
  assert.equal(onlineFallback.length, 1);
  assert.equal(onlineFallback[0].offline, false);
  assert.equal(onlineFallback[0].src, 'https://cdn.example/a.jpg');
  assert.equal(db.meta.size, 0);

  // Re-enabling allows sync to download and store images again.
  store.setDisabled(false);
  const resync = await store.syncPack({ force: true });
  assert.equal(resync.synced, true);
  assert.equal(db.images.size, 1);
  assert.equal(shardFetches, 2);
});

test('compilePhotosIndex normalizes mismatched positional arrays into named media objects with interned credits', () => {
  const raw = {
    version: 'v-raw',
    format: 'image/webp',
    cdnPrefix: 'https://cdn.example/',
    totalBytes: 100,
    totalImages: 3,
    taxaCount: 2,
    drawingsCount: 1,
    shards: [{ file: 'photos-00.bin', sha256: 'a'.repeat(64), bytes: 100, count: 3 }],
    taxa: {
      't-both': [0, 0, 30, 'h1', 'Shared Credit', 'p.jpg'],
      't-draw': [0, 30, 30, 'h2', 'Shared Credit', 'hd.jpg', 'drawing', 'a. habit']
    },
    drawings: {
      't-both': [0, 60, 40, 'h3', 'Artist Credit', 'd.jpg', 'a. leaf; b. flower']
    }
  };
  const compiled = compilePhotosIndex(raw);
  assert.equal('taxa' in compiled, false);
  assert.equal('drawings' in compiled, false);
  assert.deepEqual(compiled.credits, ['Shared Credit', 'Artist Credit']);
  assert.deepEqual(getPhotoMeta(compiled, 't-both'), {
    shard: 0,
    offset: 0,
    length: 30,
    key: 'h1',
    kind: 'photo',
    caption: '',
    attribution: 'Shared Credit',
    onlineUrl: 'https://cdn.example/p.jpg'
  });
  assert.deepEqual(getDrawingMeta(compiled, 't-both'), {
    shard: 0,
    offset: 60,
    length: 40,
    key: 'h3',
    kind: 'drawing',
    caption: 'a. leaf; b. flower',
    attribution: 'Artist Credit',
    onlineUrl: 'https://cdn.example/d.jpg'
  });
  assert.deepEqual(getPhotoMeta(compiled, 't-draw'), {
    shard: 0,
    offset: 30,
    length: 30,
    key: 'h2',
    kind: 'drawing',
    caption: 'a. habit',
    attribution: 'Shared Credit',
    onlineUrl: 'https://cdn.example/hd.jpg'
  });

  // Verify the built web/public/data/photos/index.json matches raw vicflora-data/photos/index.json losslessly.
  const builtPath = new URL('../web/public/data/photos/index.json', import.meta.url);
  const rawPath = new URL('../vicflora-data/photos/index.json', import.meta.url);
  if (fs.existsSync(builtPath) && fs.existsSync(rawPath)) {
    const built = JSON.parse(fs.readFileSync(builtPath, 'utf8'));
    const rawSource = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    assert.ok(Array.isArray(built.credits) && built.credits.length > 0);
    assert.equal('taxa' in built, false);
    assert.equal('drawings' in built, false);
    assert.equal(Object.keys(built.media).length, built.taxaCount);
    const rawHashes = new Set([
      ...Object.values(rawSource.taxa || {}).map(e => String(e[3])),
      ...Object.values(rawSource.drawings || {}).map(e => String(e[3]))
    ]);
    assert.equal(getActiveImageKeys(built).size, rawHashes.size);
  }
});


