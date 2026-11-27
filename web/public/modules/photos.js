import {
  PHOTOS_CACHE_NAME,
  fetchWithTimeout,
  isQuotaError,
  pruneCache,
  resolveUrl,
  syncCachePack
} from './offline.js';

const LEGACY_IDB_NAME = 'vicflora-photos-v1';
const PHOTOS_DISABLED_KEY = 'vicflora-offline-photos-disabled';
const MAX_OBJECT_URLS = 40;
const DEFAULT_LOOKUP_TIMEOUT_MS = 1500;
const DEFAULT_INDEX_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SHARD_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1500;

export function resolveOnlineUrl(index, urlOrSuffix) {
  if (!urlOrSuffix) return null;
  if (/^https?:\/\//i.test(urlOrSuffix)) return urlOrSuffix;
  return `${index?.cdnPrefix || ''}${urlOrSuffix}`;
}

export function isValidPhotoIndex(data) {
  return Boolean(
    data &&
      typeof data === 'object' &&
      typeof data.version === 'string' &&
      Array.isArray(data.shards) &&
      data.media &&
      typeof data.media === 'object'
  );
}

function countDrawings(index) {
  let count = 0;
  for (const list of Object.values(index?.media || {})) {
    if (Array.isArray(list) && list.some(item => item?.kind === 'drawing')) {
      count += 1;
    }
  }
  return count;
}

export function isConstrainedConnection(connection) {
  if (!connection) return false;
  if (connection.saveData === true) return true;
  return connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g';
}

function resolveCredit(index, credit) {
  if (typeof credit === 'number' && Array.isArray(index?.credits)) {
    return index.credits[credit] || 'VicFlora';
  }
  return credit || 'VicFlora';
}

function hydrateMediaItem(index, item) {
  if (!item || typeof item !== 'object' || !item.hash) return null;
  return {
    shard: item.shard,
    offset: item.offset,
    length: item.length,
    key: String(item.hash),
    kind: item.kind === 'drawing' ? 'drawing' : 'photo',
    caption: typeof item.caption === 'string' ? item.caption : '',
    attribution: resolveCredit(index, item.credit),
    onlineUrl: resolveOnlineUrl(index, item.url)
  };
}

export function getTaxonMediaMetas(index, taxonId) {
  const list = index?.media?.[taxonId];
  if (!Array.isArray(list) || !list.length) return [];
  const items = [];
  for (const raw of list) {
    const meta = hydrateMediaItem(index, raw);
    if (meta) items.push(meta);
  }
  return items;
}

export function getPhotoMeta(index, taxonId) {
  return getTaxonMediaMetas(index, taxonId)[0] || null;
}

export function getDrawingMeta(index, taxonId) {
  const metas = getTaxonMediaMetas(index, taxonId);
  return metas.find(item => item.kind === 'drawing') || null;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function withTimeout(promise, ms, label = 'Operation timed out') {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function dropLegacyIndexedDB() {
  try {
    globalThis.indexedDB?.deleteDatabase?.(LEGACY_IDB_NAME);
  } catch {
    // Best-effort cleanup of pre-CacheStorage photo database.
  }
}

export class PhotoStore {
  constructor({
    baseUrl = './data/photos',
    cacheName = PHOTOS_CACHE_NAME,
    cachesApi = globalThis.caches,
    fetchImpl = (...args) => globalThis.fetch(...args),
    urlApi = globalThis.URL,
    navigatorObj = globalThis.navigator,
    storage = navigatorObj?.storage,
    locks = navigatorObj?.locks,
    cryptoSubtle = globalThis.crypto?.subtle,
    prefs = globalThis.localStorage,
    originBase = globalThis.location?.href,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    indexTimeoutMs = DEFAULT_INDEX_TIMEOUT_MS,
    maxShardRetries = DEFAULT_MAX_SHARD_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cacheName = cacheName;
    this.caches = cachesApi;
    this.fetch = fetchImpl;
    this.urlApi = urlApi;
    this.storage = storage;
    this.locks = locks;
    this.cryptoSubtle = cryptoSubtle;
    this.navigator = navigatorObj;
    this.prefs = prefs;
    this.originBase = originBase;
    this.idleTimeoutMs = idleTimeoutMs;
    this.indexTimeoutMs = indexTimeoutMs;
    this.maxShardRetries = maxShardRetries;
    this.retryBaseMs = retryBaseMs;

    this.index = null;
    this.indexPromise = null;
    this.downloading = false;
    this.generation = 0;
    this.lastIndexFailAt = 0;
    this.objectUrls = new Map();
    this.pendingReads = new Map();
    this._disabledFallback = false;
  }

  isSupported() {
    return Boolean(this.caches);
  }

  _indexUrl() {
    return resolveUrl(`${this.baseUrl}/index.json`, this.originBase);
  }

  _shardUrl(file) {
    return resolveUrl(`${this.baseUrl}/${file}`, this.originBase);
  }

  isDisabled() {
    try {
      if (typeof this.prefs?.getItem === 'function') {
        return this.prefs.getItem(PHOTOS_DISABLED_KEY) === '1';
      }
    } catch {
      // Fall back to in-memory flag when storage is restricted.
    }
    return this._disabledFallback;
  }

  setDisabled(disabled) {
    const next = Boolean(disabled);
    this._disabledFallback = next;
    try {
      if (next) this.prefs?.setItem?.(PHOTOS_DISABLED_KEY, '1');
      else this.prefs?.removeItem?.(PHOTOS_DISABLED_KEY);
    } catch {
      // Keep in-memory fallback.
    }
  }

  async _saveCachedIndex(cache, data) {
    await cache.put(
      this._indexUrl(),
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      })
    );
  }

  async loadCachedIndex() {
    if (this.index) return this.index;
    if (this.isDisabled() || !this.isSupported()) return null;
    try {
      const cache = await this.caches.open(this.cacheName);
      const res = await cache.match(this._indexUrl());
      const data = res ? await res.json() : null;
      if (isValidPhotoIndex(data)) {
        this.index = data;
        return data;
      }
    } catch {
      // Ignore cache errors; caller may fall back to network.
    }
    return null;
  }

  async fetchFreshIndex({ signal, timeoutMs = this.indexTimeoutMs, commitToMemory = true } = {}) {
    let req = null;
    try {
      req = await fetchWithTimeout(this.fetch, `${this.baseUrl}/index.json`, {
        signal,
        timeoutMs,
        cache: 'no-cache'
      });
      const { response } = req;
      if (!response.ok) throw new Error(`Failed to load photo index: HTTP ${response.status}`);
      if ((response.headers?.get?.('content-type') || '').toLowerCase().includes('text/html')) {
        throw new Error('Photo index returned HTML instead of JSON');
      }
      const data = await response.json();
      if (!isValidPhotoIndex(data)) throw new Error('Invalid photo index format');
      this.lastIndexFailAt = 0;
      if (commitToMemory && (data.shards.length > 0 || !this.index?.shards?.length)) {
        this.index = data;
      }
      return data;
    } catch (error) {
      this.lastIndexFailAt = Date.now();
      if (req?.didTimeOut?.()) throw new Error('Timed out loading photo index');
      throw error;
    } finally {
      req?.cleanup();
    }
  }

  loadIndex({ preferNetwork = false, allowNetwork = true, timeoutMs = this.indexTimeoutMs } = {}) {
    if (preferNetwork) {
      return this.fetchFreshIndex({ timeoutMs }).catch(async error => {
        const cached = await this.loadCachedIndex();
        if (cached) return cached;
        throw error;
      });
    }
    if (this.index) return Promise.resolve(this.index);
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const cached = await this.loadCachedIndex();
        if (cached) return cached;
        if (!allowNetwork || this.navigator?.onLine === false) return null;
        if (this.lastIndexFailAt && Date.now() - this.lastIndexFailAt < 10000) return null;
        const fresh = await this.fetchFreshIndex({ timeoutMs });
        if (fresh?.shards?.length && this.isSupported() && !this.isDisabled()) {
          this.caches
            .open(this.cacheName)
            .then(cache => this._saveCachedIndex(cache, fresh))
            .catch(() => {});
        }
        return fresh;
      })().finally(() => {
        if (!this.index) this.indexPromise = null;
      });
    }
    return this.indexPromise;
  }

  async _countCachedShards(index) {
    const shards = index?.shards || [];
    if (!shards.length || !this.isSupported()) return 0;
    const cache = await this.caches.open(this.cacheName);
    const keys = new Set((await cache.keys()).map(req => req.url));
    return shards.filter(s => keys.has(this._shardUrl(s.file))).length;
  }

  async getStatus({ allowNetwork = false } = {}) {
    const disabled = this.isDisabled();
    const supported = this.isSupported();
    const constrainedNetwork = isConstrainedConnection(this.navigator?.connection);
    let index = disabled ? this.index : await this.loadCachedIndex().catch(() => null);
    if (!disabled && !index && allowNetwork) {
      index = await this.loadIndex({ allowNetwork: true }).catch(() => null);
    }

    const shards = index?.shards || [];
    const available = !disabled && Boolean(shards.length && index?.totalImages > 0);
    const matchedShardCount = available ? await this._countCachedShards(index).catch(() => 0) : 0;
    const persisted = !disabled && this.storage?.persisted
      ? await this.storage.persisted().catch(() => null)
      : null;

    return {
      supported,
      available,
      synced: available && matchedShardCount === shards.length,
      disabled,
      persisted,
      constrainedNetwork,
      version: index?.version || null,
      matchedShardCount,
      shardCount: shards.length,
      totalBytes: index?.totalBytes || 0,
      totalImages: index?.totalImages || 0,
      taxaCount: index?.taxaCount || Object.keys(index?.media || {}).length,
      drawingsCount: index?.drawingsCount || countDrawings(index)
    };
  }

  cacheObjectUrl(key, url) {
    if (this.objectUrls.has(key)) {
      const existing = this.objectUrls.get(key);
      this.objectUrls.delete(key);
      if (existing && existing !== url) this.urlApi?.revokeObjectURL?.(existing);
    }
    this.objectUrls.set(key, url);
    while (this.objectUrls.size > MAX_OBJECT_URLS) {
      const oldestKey = this.objectUrls.keys().next().value;
      const oldestUrl = this.objectUrls.get(oldestKey);
      this.objectUrls.delete(oldestKey);
      this.urlApi?.revokeObjectURL?.(oldestUrl);
    }
    return url;
  }

  revokeAllObjectUrls() {
    for (const url of this.objectUrls.values()) {
      this.urlApi?.revokeObjectURL?.(url);
    }
    this.objectUrls.clear();
  }

  async readOfflineObjectUrl(index, meta, timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS) {
    if (this.isDisabled() || !this.isSupported()) return null;
    const { key } = meta;
    if (this.objectUrls.has(key)) {
      const existing = this.objectUrls.get(key);
      this.objectUrls.delete(key);
      this.objectUrls.set(key, existing);
      return existing;
    }

    const shard = index?.shards?.[meta.shard];
    if (!shard?.file) return null;
    if (this.pendingReads.has(key)) return this.pendingReads.get(key);

    const gen = this.generation;
    const shardUrl = this._shardUrl(shard.file);
    const readPromise = (async () => {
      try {
        const res = await withTimeout(
          this.caches.open(this.cacheName).then(cache => cache.match(shardUrl)),
          timeoutMs,
          'Photo cache read timed out'
        );
        if (gen !== this.generation || !res) return null;
        const shardBlob = await withTimeout(res.blob(), timeoutMs, 'Photo blob read timed out');
        if (gen !== this.generation) return null;
        if (meta.offset < 0 || meta.length <= 0 || meta.offset + meta.length > shardBlob.size) return null;
        if (this.objectUrls.has(key)) return this.objectUrls.get(key);
        const imageBlob = shardBlob.slice(meta.offset, meta.offset + meta.length, index.format || 'image/webp');
        const url = this.urlApi.createObjectURL(imageBlob);
        if (gen !== this.generation) {
          this.urlApi?.revokeObjectURL?.(url);
          return null;
        }
        return this.cacheObjectUrl(key, url);
      } catch {
        return null;
      } finally {
        if (this.pendingReads.get(key) === readPromise) this.pendingReads.delete(key);
      }
    })();

    this.pendingReads.set(key, readPromise);
    return readPromise;
  }

  async _resolveMetaToSource(index, meta, { allowRemote, forceRemote, timeoutMs, constrained }) {
    const base = {
      key: meta.key,
      shard: meta.shard,
      kind: meta.kind || 'photo',
      caption: meta.caption || '',
      attribution: meta.attribution,
      onlineUrl: meta.onlineUrl
    };
    const objectUrl = await this.readOfflineObjectUrl(index, meta, timeoutMs);
    if (objectUrl) {
      return { ...base, src: objectUrl, offline: true, deferred: false };
    }
    const isOffline = this.navigator?.onLine === false;
    if (!allowRemote || isOffline || (constrained && !forceRemote)) {
      return { ...base, src: null, offline: false, deferred: true, constrained };
    }
    return { ...base, src: meta.onlineUrl, offline: false, deferred: false };
  }

  async getMediaSources(taxonId, { timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, allowRemote = true, forceRemote = false } = {}) {
    try {
      return await withTimeout(
        (async () => {
          const constrained = isConstrainedConnection(this.navigator?.connection);
          const index = await this.loadIndex({
            allowNetwork: allowRemote && (!constrained || forceRemote)
          }).catch(() => null);
          const metas = getTaxonMediaMetas(index, taxonId);
          if (!metas.length) return [];
          return Promise.all(
            metas.map(meta =>
              this._resolveMetaToSource(index, meta, { allowRemote, forceRemote, timeoutMs, constrained })
            )
          );
        })(),
        timeoutMs,
        'Photo lookup timed out'
      );
    } catch {
      return [];
    }
  }

  async getPhotoSource(taxonId, options) {
    const sources = await this.getMediaSources(taxonId, options);
    return sources[0] || null;
  }

  async _runWithSyncLock(fn) {
    if (this.downloading) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'busy' };
    }
    if (this.locks?.request) {
      return this.locks.request('vicflora-photos-sync', { ifAvailable: true }, async lock => {
        if (!lock) return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'locked' };
        return fn();
      });
    }
    return fn();
  }

  async syncPack({ onProgress, onShardComplete, signal, force = false } = {}) {
    if (this.isDisabled()) return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'disabled' };
    if (!this.isSupported()) return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'unsupported' };
    if (this.navigator?.onLine === false) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'offline' };
    }
    if (!force && isConstrainedConnection(this.navigator?.connection)) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'constrained-network' };
    }

    return this._runWithSyncLock(async () => {
      if (this.downloading) {
        return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'busy' };
      }
      this.downloading = true;
      const gen = this.generation;
      try {
        const prevIndex = await this.loadCachedIndex().catch(() => null);
        const index = await this.fetchFreshIndex({ signal, commitToMemory: false });
        const shards = index.shards || [];
        if (!shards.length) return { synced: false, upToDate: true, downloadedBytes: 0 };

        const cache = await this.caches.open(this.cacheName);
        const prevComplete = Boolean(
          prevIndex?.shards?.length &&
            prevIndex.version !== index.version &&
            (await this._countCachedShards(prevIndex)) === prevIndex.shards.length
        );

        // Preserve a working previous complete pack until all new shards are stored.
        if (!prevComplete) {
          this.index = index;
          try {
            await this._saveCachedIndex(cache, index);
          } catch (error) {
            if (isQuotaError(error)) {
              return { synced: false, upToDate: false, downloadedBytes: 0, quotaExceeded: true, skippedReason: 'quota' };
            }
            throw error;
          }
        }

        this.storage?.persist?.().catch(() => {});

        const shardItems = shards.map((shard, shardIndex) => ({
          url: `${this.baseUrl}/${shard.file}`,
          bytes: shard.bytes,
          sha256: shard.sha256,
          contentType: 'application/octet-stream',
          shard,
          shardIndex
        }));

        const result = await syncCachePack({
          cacheName: this.cacheName,
          items: shardItems,
          keepUrls: [this._indexUrl()],
          cachesApi: this.caches,
          fetchImpl: this.fetch,
          cryptoSubtle: this.cryptoSubtle,
          baseUrl: this.originBase,
          signal,
          idleTimeoutMs: this.idleTimeoutMs,
          maxRetries: this.maxShardRetries,
          retryBaseMs: this.retryBaseMs,
          gc: false,
          onProgress: progress => {
            onProgress?.({
              loadedBytes: progress.loadedBytes,
              totalBytes: progress.totalBytes,
              shardIndex: progress.itemIndex,
              shardCount: progress.totalCount,
              completedCount: progress.completedCount,
              phase: progress.phase
            });
          },
          onItemCached: ({ item }) => {
            onShardComplete?.({ shardIndex: item.shardIndex, shard: item.shard });
          }
        });

        if (result.quotaExceeded) return result;
        if (signal?.aborted || this.isDisabled() || gen !== this.generation) {
          throw new DOMException('Sync cancelled', 'AbortError');
        }

        // Commit the new index before pruning obsolete shards from previous versions.
        if (prevComplete) {
          try {
            await this._saveCachedIndex(cache, index);
          } catch (error) {
            if (isQuotaError(error)) {
              return {
                synced: false,
                upToDate: false,
                downloadedBytes: result.downloadedBytes,
                quotaExceeded: true,
                skippedReason: 'quota'
              };
            }
            throw error;
          }
          this.index = index;
        }

        const keepUrls = new Set([this._indexUrl(), ...shards.map(s => this._shardUrl(s.file))]);
        await pruneCache(cache, keepUrls).catch(() => {});
        dropLegacyIndexedDB();
        return result;
      } finally {
        this.downloading = false;
      }
    });
  }

  async clearPack() {
    this.generation += 1;
    this.pendingReads.clear();
    this.revokeAllObjectUrls();
    this.index = null;
    this.indexPromise = null;
    this.lastIndexFailAt = 0;
    if (this.isSupported()) {
      await this.caches.delete(this.cacheName).catch(() => {});
    }
    dropLegacyIndexedDB();
  }
}
