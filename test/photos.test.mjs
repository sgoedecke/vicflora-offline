import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { PHOTOS_CACHE_NAME } from '../web/public/modules/offline.js';
import {
  PhotoStore,
  formatBytes,
  getDrawingMeta,
  getPhotoMeta,
  getTaxonMediaMetas,
  isConstrainedConnection,
  resolveOnlineUrl
} from '../web/public/modules/photos.js';
import {
  formatAttribution,
  formatDrawingCaption,
  imageAssetKey,
  pickBestDrawing
} from '../scripts/fetch-photos.js';
import { FakeCacheStorage } from './helpers/fake-caches.mjs';

const require = createRequire(import.meta.url);
const { compilePhotosIndex } = require('../scripts/build-web-data.js');

const ORIGIN = 'https://vicflora.test/';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeFakeWebp(tag) {
  const payload = Buffer.from(tag, 'utf8');
  const buf = Buffer.alloc(12 + payload.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8);
  payload.copy(buf, 12);
  return buf;
}

function makePack(version, entries) {
  const chunks = [];
  const credits = [];
  const creditToIdx = new Map();
  const internCredit = text => {
    const value = text || 'VicFlora';
    if (!creditToIdx.has(value)) {
      creditToIdx.set(value, credits.length);
      credits.push(value);
    }
    return creditToIdx.get(value);
  };
  const media = {};
  let offset = 0;
  for (const entry of entries) {
    const bytes = makeFakeWebp(entry.tag);
    const item = {
      kind: entry.kind === 'drawing' ? 'drawing' : 'photo',
      shard: 0,
      offset,
      length: bytes.length,
      hash: entry.hash,
      credit: internCredit(entry.attribution),
      url: entry.onlineSuffix || `/${entry.hash}.jpg`
    };
    if (entry.caption) item.caption = entry.caption;
    if (!media[entry.taxonId]) media[entry.taxonId] = [];
    media[entry.taxonId].push(item);
    chunks.push(bytes);
    offset += bytes.length;
  }
  const shardBytes = Buffer.concat(chunks);
  const shardFile = `photos-00-${version}.bin`;
  const drawingsCount = Object.values(media).filter(list => list.some(item => item.kind === 'drawing')).length;
  const index = {
    version,
    format: 'image/webp',
    cdnPrefix: 'https://cdn.vicflora.test',
    totalImages: entries.length,
    taxaCount: Object.keys(media).length,
    drawingsCount,
    totalBytes: shardBytes.length,
    shards: [{ file: shardFile, bytes: shardBytes.length, sha256: sha256(shardBytes), count: entries.length }],
    credits,
    media
  };
  return { index, shardFile, shardBytes };
}

function makeUrlTracker() {
  let seq = 0;
  const created = new Map();
  const revoked = [];
  return {
    created,
    revoked,
    api: {
      createObjectURL: blob => {
        const url = `blob:test/${++seq}`;
        created.set(url, blob);
        return url;
      },
      revokeObjectURL: url => revoked.push(url)
    }
  };
}

function makePrefs() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

test('photo/drawing metadata and attribution helpers behave as expected', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
  assert.equal(isConstrainedConnection({ saveData: true }), true);
  assert.equal(isConstrainedConnection({ effectiveType: '2g' }), true);
  assert.equal(isConstrainedConnection({ effectiveType: '4g' }), false);

  const pack = makePack('v1', [
    { taxonId: 't1', tag: 'img1', hash: 'h1', attribution: '© Alice', onlineSuffix: '/h1.jpg' },
    { taxonId: 't1', tag: 'drw1', hash: 'h2', kind: 'drawing', asExtraDrawing: true, caption: 'Leaf', attribution: '© Bob' }
  ]);
  assert.equal(resolveOnlineUrl(pack.index, '/x.jpg'), 'https://cdn.vicflora.test/x.jpg');
  assert.equal(resolveOnlineUrl(pack.index, 'https://other/x.jpg'), 'https://other/x.jpg');
  assert.equal(getPhotoMeta(pack.index, 't1').onlineUrl, 'https://cdn.vicflora.test/h1.jpg');
  assert.equal(getDrawingMeta(pack.index, 't1').caption, 'Leaf');
  assert.equal(getTaxonMediaMetas(pack.index, 't1').length, 2);

  assert.equal(formatAttribution({ creator: 'Jane Doe', license: 'CC BY 4.0', rightsHolder: 'RBGV' }), 'Jane Doe · CC BY 4.0');
  assert.equal(formatDrawingCaption('Acacia dealbata — a, habit; b, flower.', 'Acacia dealbata'), 'a, habit; b, flower.');
  assert.equal(
    pickBestDrawing(
      [
        { id: '1', subtype: 'Illustration', previewUrl: 'https://a/1.jpg' },
        { id: '2', subtype: 'Illustration', subjectCategory: 'Flora of Victoria Figure', previewUrl: 'https://a/2.jpg' }
      ],
      '1'
    ).id,
    '2'
  );

  // Distinct VicFlora Canto asset URLs must not collide even when VicFlora reuses numeric image IDs (e.g. 26399).
  const photoUrl = 'https://vicflora-cdn.rbg.vic.gov.au/assets/canto/preview/6ultu0mof97h39lrefh91mbu7f-20240328130330931.jpg';
  const drawingUrl = 'https://vicflora-cdn.rbg.vic.gov.au/assets/canto/preview/je3s5cpaa50lnfhbmlrrrum47h-20240327103354388.jpg';
  assert.notEqual(imageAssetKey(photoUrl, '26399'), imageAssetKey(drawingUrl, '26399'));
  assert.equal(
    pickBestDrawing(
      [{ id: '26399', subtype: 'Illustration', subjectCategory: 'Flora of Victoria Figure', previewUrl: drawingUrl }],
      '26399',
      photoUrl
    )?.previewUrl,
    drawingUrl
  );
});

test('PhotoStore syncs verified shards into Cache Storage and slices exact offline blobs with LRU eviction', async () => {
  const pack = makePack('v1', [
    { taxonId: 't1', tag: 'photo-one', hash: 'h1' },
    { taxonId: 't2', tag: 'photo-two', hash: 'h2' }
  ]);
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const urls = makeUrlTracker();
  const completed = [];

  const store = new PhotoStore({
    cachesApi,
    originBase: ORIGIN,
    urlApi: urls.api,
    prefs: makePrefs(),
    navigatorObj: { onLine: true },
    retryBaseMs: 1,
    fetchImpl: async url => {
      if (String(url).endsWith('/index.json')) return new Response(JSON.stringify(pack.index), { status: 200 });
      if (String(url).endsWith(pack.shardFile)) return new Response(pack.shardBytes, { status: 200 });
      return new Response('missing', { status: 404 });
    }
  });

  const syncRes = await store.syncPack({ onShardComplete: info => completed.push(info.shardIndex) });
  assert.equal(syncRes.synced, true);
  assert.deepEqual(completed, [0]);

  const status = await store.getStatus();
  assert.equal(status.synced, true);
  assert.equal(status.matchedShardCount, 1);

  // Go offline and verify exact sliced WebP bytes come straight from vicflora-photos Cache Storage.
  store.navigator = { onLine: false };
  const src1 = await store.getPhotoSource('t1');
  const src2 = await store.getPhotoSource('t2');
  assert.equal(src1.offline, true);
  assert.equal(src2.offline, true);
  assert.deepEqual(Buffer.from(await urls.created.get(src1.src).arrayBuffer()), makeFakeWebp('photo-one'));
  assert.deepEqual(Buffer.from(await urls.created.get(src2.src).arrayBuffer()), makeFakeWebp('photo-two'));

  // LRU cache caps at 40 entries and revokes evicted object URLs.
  for (let i = 0; i < 42; i += 1) {
    store.cacheObjectUrl(`lru-${i}`, `blob:lru/${i}`);
  }
  assert.equal(store.objectUrls.size, 40);
  assert.ok(urls.revoked.length >= 4);
});

test('PhotoStore preserves a working v1 pack if v2 upgrade fails, then GCs v1 once v2 succeeds', async () => {
  const v1 = makePack('v1', [{ taxonId: 't1', tag: 'v1-img', hash: 'h1' }]);
  const v2 = makePack('v2', [{ taxonId: 't1', tag: 'v2-img', hash: 'h2' }]);
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const urls = makeUrlTracker();

  let activePack = v1;
  let failShard = false;
  const store = new PhotoStore({
    cachesApi,
    originBase: ORIGIN,
    urlApi: urls.api,
    prefs: makePrefs(),
    navigatorObj: { onLine: true },
    maxShardRetries: 1,
    retryBaseMs: 1,
    fetchImpl: async url => {
      if (String(url).endsWith('/index.json')) return new Response(JSON.stringify(activePack.index), { status: 200 });
      if (failShard) return new Response('corrupt', { status: 500 });
      return new Response(activePack.shardBytes, { status: 200 });
    }
  });

  await store.syncPack();
  assert.equal((await store.getStatus()).version, 'v1');

  // Switch server to v2 and fail shard download: v1 must stay intact and readable offline.
  activePack = v2;
  failShard = true;
  await assert.rejects(store.syncPack(), /HTTP 500/);
  assert.equal((await store.getStatus()).version, 'v1');
  store.navigator = { onLine: false };
  const stillV1 = await store.getPhotoSource('t1');
  assert.equal(stillV1.offline, true);
  assert.deepEqual(Buffer.from(await urls.created.get(stillV1.src).arrayBuffer()), makeFakeWebp('v1-img'));

  // Re-enable network: v2 completes and v1 shard is pruned from vicflora-photos.
  store.navigator = { onLine: true };
  failShard = false;
  const upgrade = await store.syncPack();
  assert.equal(upgrade.synced, true);
  assert.equal((await store.getStatus()).version, 'v2');

  const cache = await cachesApi.open(PHOTOS_CACHE_NAME);
  const keys = (await cache.keys()).map(k => k.url);
  assert.ok(keys.some(u => u.endsWith(v2.shardFile)));
  assert.ok(!keys.some(u => u.endsWith(v1.shardFile)));
});

test('PhotoStore respects constrained connections, quota errors, and clearPack + disable', async () => {
  const pack = makePack('v1', [{ taxonId: 't1', tag: 'img1', hash: 'h1' }]);
  const cachesApi = new FakeCacheStorage(ORIGIN);
  const urls = makeUrlTracker();
  const prefs = makePrefs();

  const store = new PhotoStore({
    cachesApi,
    originBase: ORIGIN,
    urlApi: urls.api,
    prefs,
    navigatorObj: { onLine: true, connection: { saveData: true } },
    retryBaseMs: 1,
    fetchImpl: async url =>
      new Response(String(url).endsWith('/index.json') ? JSON.stringify(pack.index) : pack.shardBytes, { status: 200 })
  });

  // Auto-sync skips constrained network unless forced.
  assert.equal((await store.syncPack()).skippedReason, 'constrained-network');
  assert.equal((await store.syncPack({ force: true })).synced, true);

  // Reading populates object URL; clearPack + disable revokes it and removes cache.
  const src = await store.getPhotoSource('t1');
  assert.equal(src.offline, true);
  store.setDisabled(true);
  await store.clearPack();
  assert.ok(urls.revoked.includes(src.src));
  assert.equal((await cachesApi.keys()).includes(PHOTOS_CACHE_NAME), false);
  assert.equal((await store.getStatus()).disabled, true);
  assert.equal((await store.syncPack({ force: true })).skippedReason, 'disabled');
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
    const builtHashes = new Set(
      Object.values(built.media).flatMap(list => list.map(item => String(item.hash)))
    );
    assert.equal(builtHashes.size, rawHashes.size);
  }
});
