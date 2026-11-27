const DB_NAME = 'vicflora-photos-v1';
const DB_VERSION = 1;
const STORE_IMAGES = 'images';
const STORE_META = 'meta';
const META_KEY = 'pack';
const INDEX_META_KEY = 'index';
const PHOTOS_DISABLED_KEY = 'vicflora-offline-photos-disabled';
const MAX_OBJECT_URLS = 40;
const DEFAULT_OPEN_TIMEOUT_MS = 4000;
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

export function isValidWebpBytes(bytes) {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  );
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
  const type = connection.effectiveType;
  return type === 'slow-2g' || type === '2g';
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

export function groupEntriesByShard(index) {
  const shardCount = index?.shards?.length || 0;
  const groups = Array.from({ length: shardCount }, () => new Map());
  for (const list of Object.values(index?.media || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.hash) continue;
      const { shard, offset, length, hash } = item;
      if (shard < 0 || shard >= shardCount) continue;
      const key = String(hash);
      if (!groups[shard].has(key)) {
        groups[shard].set(key, { offset, length });
      }
    }
  }
  return groups;
}

export function getActiveImageKeys(index) {
  const keys = new Set();
  for (const list of Object.values(index?.media || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.hash) {
        keys.add(String(item.hash));
      }
    }
  }
  return keys;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function isQuotaError(error) {
  if (!error) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
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

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Sync cancelled', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Sync cancelled', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function sha256Hex(bytes, subtle) {
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDBAdapter(
  idb = globalThis.indexedDB,
  { openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS } = {}
) {
  let dbPromise = null;
  let openSeq = 0;

  function open() {
    if (!idb) return Promise.reject(new Error('IndexedDB is not supported in this browser.'));
    if (!dbPromise) {
      const seq = ++openSeq;
      let timedOut = false;
      dbPromise = withTimeout(
        new Promise((resolve, reject) => {
          const req = idb.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_IMAGES)) {
              db.createObjectStore(STORE_IMAGES);
            }
            if (!db.objectStoreNames.contains(STORE_META)) {
              db.createObjectStore(STORE_META);
            }
          };
          req.onblocked = () => {
            if (seq === openSeq) dbPromise = null;
            reject(new Error('Photo database open was blocked by another tab.'));
          };
          req.onsuccess = () => {
            const db = req.result;
            if (timedOut || seq !== openSeq) {
              db.close();
              return;
            }
            db.onversionchange = () => {
              db.close();
              if (seq === openSeq) dbPromise = null;
            };
            db.onclose = () => {
              if (seq === openSeq) dbPromise = null;
            };
            resolve(db);
          };
          req.onerror = () => {
            if (seq === openSeq) dbPromise = null;
            reject(req.error || new Error('Could not open photo database.'));
          };
        }),
        openTimeoutMs,
        'Timed out opening photo database.'
      ).catch(error => {
        timedOut = true;
        if (seq === openSeq) dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  }

  async function withDb(fn) {
    try {
      const db = await open();
      return await fn(db);
    } catch (error) {
      // Safari/WebKit can silently close an idle IDBDatabase without firing onclose.
      if (error?.name === 'InvalidStateError') {
        dbPromise = null;
        const db = await open();
        return fn(db);
      }
      throw error;
    }
  }

  return {
    isSupported() {
      return Boolean(idb);
    },
    getImage(key) {
      return withDb(db => {
        const tx = db.transaction(STORE_IMAGES, 'readonly');
        return requestToPromise(tx.objectStore(STORE_IMAGES).get(key));
      });
    },
    getAllImageKeys() {
      return withDb(db => {
        const tx = db.transaction(STORE_IMAGES, 'readonly');
        return requestToPromise(tx.objectStore(STORE_IMAGES).getAllKeys());
      });
    },
    deleteImages(keys) {
      if (!keys.length) return Promise.resolve();
      return withDb(async db => {
        const tx = db.transaction(STORE_IMAGES, 'readwrite');
        const store = tx.objectStore(STORE_IMAGES);
        for (const key of keys) {
          store.delete(key);
        }
        await txDone(tx);
      });
    },
    putShardAtomic(entries, metaKey, metaValue) {
      return withDb(async db => {
        const tx = db.transaction([STORE_IMAGES, STORE_META], 'readwrite');
        const imgStore = tx.objectStore(STORE_IMAGES);
        for (const [key, bytes] of entries) {
          imgStore.put(bytes, key);
        }
        tx.objectStore(STORE_META).put(metaValue, metaKey);
        await txDone(tx);
      });
    },
    getMeta(key) {
      return withDb(db => {
        const tx = db.transaction(STORE_META, 'readonly');
        return requestToPromise(tx.objectStore(STORE_META).get(key));
      });
    },
    putMeta(key, value) {
      return withDb(async db => {
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put(value, key);
        await txDone(tx);
      });
    },
    clearAll() {
      return withDb(async db => {
        const tx = db.transaction([STORE_IMAGES, STORE_META], 'readwrite');
        tx.objectStore(STORE_IMAGES).clear();
        tx.objectStore(STORE_META).clear();
        await txDone(tx);
      });
    },
    async dropDatabase() {
      // Clear stores first so data is freed even if deleteDatabase is blocked by another tab.
      try {
        await this.clearAll();
      } catch {
        // Proceed to deleteDatabase attempt.
      }
      if (dbPromise) {
        try {
          const db = await dbPromise;
          db.close();
        } catch {
          // Ignore close errors.
        }
        dbPromise = null;
        openSeq += 1;
      }
      if (typeof idb?.deleteDatabase !== 'function') return;
      await withTimeout(
        new Promise(resolve => {
          const req = idb.deleteDatabase(DB_NAME);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        }),
        openTimeoutMs,
        'Timed out deleting photo database.'
      ).catch(() => {});
    }
  };
}

async function fetchWithIdleTimeout(fetchImpl, url, { signal, idleTimeoutMs, cache } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let idleTimer = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, idleTimeoutMs);
    }
  }

  function onExternalAbort() {
    controller.abort();
  }

  if (signal) {
    if (signal.aborted) {
      throw new DOMException('Sync cancelled', 'AbortError');
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  resetIdleTimer();
  try {
    const fetchOpts = { signal: controller.signal };
    if (cache) fetchOpts.cache = cache;
    const response = await fetchImpl(url, fetchOpts);
    resetIdleTimer();
    return {
      response,
      resetIdleTimer,
      cleanup() {
        if (idleTimer) clearTimeout(idleTimer);
        signal?.removeEventListener('abort', onExternalAbort);
      },
      didTimeOut: () => timedOut,
      signal: controller.signal
    };
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onExternalAbort);
    if (timedOut) {
      throw new Error(`Timed out downloading ${url}`);
    }
    throw error;
  }
}

async function readResponseBytes(response, onChunk, { signal, resetIdleTimer, didTimeOut } = {}) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    try {
      const buf = new Uint8Array(await response.arrayBuffer());
      resetIdleTimer?.();
      onChunk?.(buf.byteLength);
      return buf;
    } catch (error) {
      if (didTimeOut?.()) {
        throw new Error('Shard download stalled (idle timeout)');
      }
      throw error;
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw didTimeOut?.()
          ? new Error('Shard download stalled (idle timeout)')
          : new DOMException('Download cancelled', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer?.();
      chunks.push(value);
      total += value.byteLength;
      onChunk?.(value.byteLength);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (didTimeOut?.()) {
      throw new Error('Shard download stalled (idle timeout)');
    }
    throw error;
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export class PhotoStore {
  constructor({
    baseUrl = './data/photos',
    fetchImpl = (...args) => globalThis.fetch(...args),
    db = createIndexedDBAdapter(),
    urlApi = globalThis.URL,
    navigatorObj = globalThis.navigator,
    storage = navigatorObj?.storage,
    locks = navigatorObj?.locks,
    cryptoSubtle = globalThis.crypto?.subtle,
    prefs = globalThis.localStorage,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    indexTimeoutMs = DEFAULT_INDEX_TIMEOUT_MS,
    maxShardRetries = DEFAULT_MAX_SHARD_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.db = db;
    this.urlApi = urlApi;
    this.storage = storage;
    this.locks = locks;
    this.cryptoSubtle = cryptoSubtle;
    this.navigator = navigatorObj;
    this.prefs = prefs;
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

  isDisabled() {
    try {
      if (this.prefs && typeof this.prefs.getItem === 'function') {
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
      if (this.prefs) {
        if (next && typeof this.prefs.setItem === 'function') {
          this.prefs.setItem(PHOTOS_DISABLED_KEY, '1');
        } else if (!next && typeof this.prefs.removeItem === 'function') {
          this.prefs.removeItem(PHOTOS_DISABLED_KEY);
        }
      }
    } catch {
      // Keep in-memory fallback.
    }
  }

  async loadCachedIndex() {
    if (this.index) return this.index;
    if (this.isDisabled() || !this.db.isSupported()) return null;
    try {
      const cached = await this.db.getMeta(INDEX_META_KEY);
      if (isValidPhotoIndex(cached)) {
        this.index = cached;
        return cached;
      }
    } catch {
      // Ignore IDB errors; caller may fall back to network.
    }
    return null;
  }

  async fetchFreshIndex({ signal, timeoutMs = this.indexTimeoutMs, commitToMemory = true } = {}) {
    let req = null;
    try {
      req = await fetchWithIdleTimeout(this.fetch, `${this.baseUrl}/index.json`, {
        signal,
        idleTimeoutMs: timeoutMs,
        cache: 'no-cache'
      });
      const { response } = req;
      if (!response.ok) {
        throw new Error(`Failed to load photo index: HTTP ${response.status}`);
      }
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.toLowerCase().includes('text/html')) {
        throw new Error('Photo index returned HTML instead of JSON');
      }
      const data = await response.json();
      if (!isValidPhotoIndex(data)) {
        throw new Error('Invalid photo index format');
      }
      this.lastIndexFailAt = 0;
      if (commitToMemory && (data.shards.length > 0 || !this.index?.shards?.length)) {
        this.index = data;
      }
      return data;
    } catch (error) {
      this.lastIndexFailAt = Date.now();
      throw error;
    } finally {
      req?.cleanup();
    }
  }

  loadIndex({ allowNetwork = true, timeoutMs = this.indexTimeoutMs } = {}) {
    if (this.index) return Promise.resolve(this.index);
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const cached = await this.loadCachedIndex();
        if (cached) return cached;
        if (!allowNetwork || this.navigator?.onLine === false) return null;
        if (this.lastIndexFailAt && Date.now() - this.lastIndexFailAt < 10000) return null;
        const fresh = await this.fetchFreshIndex({ timeoutMs });
        if (fresh?.shards?.length && this.db.isSupported() && !this.isDisabled()) {
          this.db.putMeta(INDEX_META_KEY, fresh).catch(() => {});
        }
        return fresh;
      })().finally(() => {
        if (!this.index) this.indexPromise = null;
      });
    }
    return this.indexPromise;
  }

  async getStatus({ allowNetwork = false } = {}) {
    const disabled = this.isDisabled();
    const supported = this.db.isSupported();
    if (disabled) {
      return {
        supported,
        available: false,
        synced: false,
        disabled: true,
        persisted: null,
        constrainedNetwork: isConstrainedConnection(this.navigator?.connection),
        version: this.index?.version || null,
        storedVersion: null,
        matchedShardCount: 0,
        shardCount: this.index?.shards?.length || 0,
        totalBytes: this.index?.totalBytes || 0,
        totalImages: this.index?.totalImages || 0,
        taxaCount: this.index?.taxaCount || Object.keys(this.index?.media || {}).length,
        drawingsCount: this.index?.drawingsCount || countDrawings(this.index),
        downloadedAt: null
      };
    }
    let index = await this.loadCachedIndex().catch(() => null);
    if (!index && allowNetwork) {
      index = await this.loadIndex({ allowNetwork: true }).catch(() => null);
    }
    const available = Boolean(index?.shards?.length && index?.totalImages > 0);
    let stored = null;
    if (supported) {
      try {
        stored = await this.db.getMeta(META_KEY);
      } catch {
        stored = null;
      }
    }
    const shards = index?.shards || [];
    const completedShards = stored?.shards || {};
    const shardToken = s => s.sha256 || s.hash || index?.version;
    const matchedShardCount = shards.filter(
      s => completedShards[s.file] && completedShards[s.file] === shardToken(s)
    ).length;
    const synced = Boolean(
      available && stored?.complete && stored.version === index.version && matchedShardCount === shards.length
    );
    let persisted = null;
    if (this.storage?.persisted) {
      persisted = await this.storage.persisted().catch(() => null);
    }
    return {
      supported,
      available,
      synced,
      disabled: false,
      persisted,
      constrainedNetwork: isConstrainedConnection(this.navigator?.connection),
      version: index?.version || null,
      storedVersion: stored?.version || null,
      matchedShardCount,
      shardCount: shards.length,
      totalBytes: index?.totalBytes || 0,
      totalImages: index?.totalImages || 0,
      taxaCount: index?.taxaCount || Object.keys(index?.media || {}).length,
      drawingsCount: index?.drawingsCount || countDrawings(index),
      downloadedAt: stored?.downloadedAt || null
    };
  }

  cacheObjectUrl(key, url) {
    if (this.objectUrls.has(key)) {
      const existing = this.objectUrls.get(key);
      this.objectUrls.delete(key);
      if (existing && existing !== url) {
        this.urlApi?.revokeObjectURL?.(existing);
      }
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

  async readOfflineObjectUrl(key, mimeType, timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS) {
    if (this.isDisabled()) return null;
    if (this.objectUrls.has(key)) {
      const existing = this.objectUrls.get(key);
      // Touch LRU order without revoking.
      this.objectUrls.delete(key);
      this.objectUrls.set(key, existing);
      return existing;
    }
    if (!this.db.isSupported()) return null;
    if (this.pendingReads.has(key)) {
      return this.pendingReads.get(key);
    }

    const gen = this.generation;
    const readPromise = (async () => {
      try {
        const bytes = await withTimeout(
          this.db.getImage(key),
          timeoutMs,
          'IndexedDB image read timed out'
        );
        if (gen !== this.generation) return null;
        if (!bytes || bytes.byteLength === 0) return null;
        if (this.objectUrls.has(key)) return this.objectUrls.get(key);
        const blob = new Blob([bytes], { type: mimeType || 'image/webp' });
        const url = this.urlApi.createObjectURL(blob);
        if (gen !== this.generation) {
          this.urlApi?.revokeObjectURL?.(url);
          return null;
        }
        return this.cacheObjectUrl(key, url);
      } catch {
        return null;
      } finally {
        if (this.pendingReads.get(key) === readPromise) {
          this.pendingReads.delete(key);
        }
      }
    })();

    this.pendingReads.set(key, readPromise);
    return readPromise;
  }

  async _resolveMetaToSource(index, meta, { allowRemote, forceRemote, timeoutMs, constrained }) {
    const objectUrl = await this.readOfflineObjectUrl(meta.key, index.format, timeoutMs);
    if (objectUrl) {
      return {
        src: objectUrl,
        key: meta.key,
        kind: meta.kind || 'photo',
        caption: meta.caption || '',
        attribution: meta.attribution,
        offline: true,
        deferred: false,
        onlineUrl: meta.onlineUrl
      };
    }

    const isOffline = this.navigator?.onLine === false;
    if (!allowRemote || isOffline || (constrained && !forceRemote)) {
      return {
        src: null,
        key: meta.key,
        kind: meta.kind || 'photo',
        caption: meta.caption || '',
        attribution: meta.attribution,
        offline: false,
        deferred: true,
        constrained,
        onlineUrl: meta.onlineUrl
      };
    }

    return {
      src: meta.onlineUrl,
      key: meta.key,
      kind: meta.kind || 'photo',
      caption: meta.caption || '',
      attribution: meta.attribution,
      offline: false,
      deferred: false,
      onlineUrl: meta.onlineUrl
    };
  }

  async getMediaSources(taxonId, { timeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS, allowRemote = true, forceRemote = false } = {}) {
    try {
      return await withTimeout(
        this._getMediaSourcesInner(taxonId, { allowRemote, forceRemote, timeoutMs }),
        timeoutMs,
        'Photo lookup timed out'
      );
    } catch {
      return [];
    }
  }

  async _getMediaSourcesInner(taxonId, { allowRemote, forceRemote, timeoutMs }) {
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
  }

  async downloadAndVerifyShard(shard, entries, { onChunk, signal } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxShardRetries; attempt += 1) {
      if (signal?.aborted) {
        throw new DOMException('Sync cancelled', 'AbortError');
      }

      let attemptBytes = 0;
      let req = null;

      try {
        req = await fetchWithIdleTimeout(this.fetch, `${this.baseUrl}/${shard.file}`, {
          signal,
          idleTimeoutMs: this.idleTimeoutMs
        });
        const { response } = req;
        if (!response.ok) {
          const err = new Error(`Failed to download ${shard.file}: HTTP ${response.status}`);
          err.status = response.status;
          throw err;
        }
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType.toLowerCase().includes('text/html')) {
          throw new Error(`Shard ${shard.file} returned HTML instead of binary data`);
        }

        const shardBytes = await readResponseBytes(
          response,
          delta => {
            attemptBytes += delta;
            onChunk?.(delta);
          },
          req
        );

        if (shardBytes.byteLength !== shard.bytes) {
          throw new Error(
            `Shard ${shard.file} size mismatch: expected ${shard.bytes} bytes, got ${shardBytes.byteLength}`
          );
        }

        if (shard.sha256 && this.cryptoSubtle) {
          const actualHash = await sha256Hex(shardBytes, this.cryptoSubtle);
          if (actualHash !== shard.sha256) {
            throw new Error(`Shard ${shard.file} SHA-256 verification failed`);
          }
        }

        const batch = [];
        for (const [key, { offset, length }] of entries.entries()) {
          if (offset < 0 || length <= 0 || offset + length > shardBytes.byteLength) {
            throw new Error(`Shard ${shard.file} entry ${key} is out of bounds`);
          }
          const slice = shardBytes.slice(offset, offset + length);
          if (!isValidWebpBytes(slice)) {
            throw new Error(`Shard ${shard.file} entry ${key} is not a valid WebP image`);
          }
          batch.push([key, slice]);
        }

        return { batch, bytesRead: shardBytes.byteLength };
      } catch (error) {
        if (attemptBytes > 0) {
          // Roll back progress delta from failed attempt so progress stays accurate.
          onChunk?.(-attemptBytes);
        }
        if (error.name === 'AbortError' || signal?.aborted) {
          throw error;
        }
        lastError = error;
        // Don't burn retries on hard 404.
        if (error.status === 404 || attempt >= this.maxShardRetries) {
          throw lastError;
        }
        const jitter = Math.round(Math.random() * 250);
        await sleep(this.retryBaseMs * (2 ** (attempt - 1)) + jitter, signal);
      } finally {
        req?.cleanup();
      }
    }
    throw lastError;
  }

  async _runWithSyncLock(fn) {
    if (this.downloading) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'busy' };
    }
    if (this.locks?.request) {
      return this.locks.request('vicflora-photos-sync', { ifAvailable: true }, async lock => {
        if (!lock) {
          return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'locked' };
        }
        return fn();
      });
    }
    return fn();
  }

  async syncPack({ onProgress, onShardComplete, signal, force = false } = {}) {
    if (this.isDisabled()) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'disabled' };
    }
    if (!this.db.isSupported()) {
      return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'unsupported' };
    }
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
      try {
        const prevCachedIndex = await this.loadCachedIndex().catch(() => null);
        const index = await this.fetchFreshIndex({ signal, commitToMemory: false });
        const shards = index.shards || [];
        if (!shards.length) {
          return { synced: false, upToDate: true, downloadedBytes: 0 };
        }

        const stored = await this.db.getMeta(META_KEY).catch(() => null);
        const storedShards = stored?.shards || {};
        const shardToken = shard => shard.sha256 || shard.hash || index.version;
        const isShardCached = shard =>
          Boolean(storedShards[shard.file] && storedShards[shard.file] === shardToken(shard));

        const allMatched = shards.every(isShardCached);
        if (stored?.complete && stored.version === index.version && allMatched) {
          this.index = index;
          await this.db.putMeta(INDEX_META_KEY, index).catch(() => {});
          return { synced: false, upToDate: true, downloadedBytes: 0 };
        }

        this.storage?.persist?.().catch(() => {});

        // Preserve a working previous complete pack's index until the new version
        // finishes syncing, so a mid-update failure offline never hides existing photos.
        const preservePreviousIndex = Boolean(
          stored?.complete && prevCachedIndex?.shards?.length && stored.version !== index.version
        );
        if (!preservePreviousIndex) {
          this.index = index;
          try {
            await this.db.putMeta(INDEX_META_KEY, index);
          } catch (error) {
            if (isQuotaError(error)) {
              return { synced: false, upToDate: false, downloadedBytes: 0, quotaExceeded: true, skippedReason: 'quota' };
            }
            throw error;
          }
        }

        const completedShards = {};
        for (const shard of shards) {
          if (isShardCached(shard)) completedShards[shard.file] = shardToken(shard);
        }

        const entriesByShard = groupEntriesByShard(index);
        const totalBytes = index.totalBytes || shards.reduce((sum, s) => sum + (s.bytes || 0), 0);
        let loadedBytes = shards
          .filter(s => Boolean(completedShards[s.file]))
          .reduce((sum, s) => sum + (s.bytes || 0), 0);
        let downloadedBytes = 0;

        for (let i = 0; i < shards.length; i += 1) {
          const shard = shards[i];
          if (completedShards[shard.file]) continue;

          if (signal?.aborted) {
            throw new DOMException('Sync cancelled', 'AbortError');
          }

          onProgress?.({
            loadedBytes,
            totalBytes,
            shardIndex: i,
            shardCount: shards.length,
            completedCount: Object.keys(completedShards).length,
            phase: 'downloading'
          });

          const { batch, bytesRead } = await this.downloadAndVerifyShard(shard, entriesByShard[i], {
            signal,
            onChunk: delta => {
              loadedBytes = Math.max(0, loadedBytes + delta);
              onProgress?.({
                loadedBytes: Math.min(loadedBytes, totalBytes),
                totalBytes,
                shardIndex: i,
                shardCount: shards.length,
                completedCount: Object.keys(completedShards).length,
                phase: 'downloading'
              });
            }
          });
          downloadedBytes += bytesRead;

          if (signal?.aborted || this.isDisabled()) {
            throw new DOMException('Sync cancelled', 'AbortError');
          }

          onProgress?.({
            loadedBytes: Math.min(loadedBytes, totalBytes),
            totalBytes,
            shardIndex: i,
            shardCount: shards.length,
            completedCount: Object.keys(completedShards).length,
            phase: 'saving'
          });

          completedShards[shard.file] = shardToken(shard);
          const partialMeta = preservePreviousIndex
            ? {
                ...stored,
                shards: { ...storedShards, ...completedShards }
              }
            : {
                version: index.version,
                complete: false,
                shards: { ...completedShards },
                totalBytes,
                totalImages: index.totalImages || 0
              };
          try {
            await this.db.putShardAtomic(batch, META_KEY, partialMeta);
          } catch (error) {
            delete completedShards[shard.file];
            if (isQuotaError(error)) {
              return {
                synced: false,
                upToDate: false,
                downloadedBytes,
                quotaExceeded: true,
                skippedReason: 'quota'
              };
            }
            throw error;
          }

          onShardComplete?.({
            shardIndex: i,
            shard,
            imageKeys: batch.map(([key]) => key)
          });
        }

        if (signal?.aborted || this.isDisabled()) {
          throw new DOMException('Sync cancelled', 'AbortError');
        }

        const meta = {
          version: index.version,
          complete: true,
          shards: completedShards,
          totalBytes,
          totalImages: index.totalImages || 0,
          downloadedAt: new Date().toISOString()
        };
        try {
          await this.db.putMeta(INDEX_META_KEY, index);
          await this.db.putMeta(META_KEY, meta);
        } catch (error) {
          if (isQuotaError(error)) {
            return { synced: false, upToDate: false, downloadedBytes, quotaExceeded: true, skippedReason: 'quota' };
          }
          throw error;
        }
        this.index = index;

        // Garbage-collect obsolete image keys ONLY after full sync completes.
        if (typeof this.db.getAllImageKeys === 'function' && typeof this.db.deleteImages === 'function') {
          try {
            const activeKeys = getActiveImageKeys(index);
            const allKeys = await this.db.getAllImageKeys();
            const obsolete = allKeys.filter(key => !activeKeys.has(key));
            if (obsolete.length) {
              await this.db.deleteImages(obsolete);
              for (const key of obsolete) {
                const url = this.objectUrls.get(key);
                if (url) {
                  this.objectUrls.delete(key);
                  this.urlApi?.revokeObjectURL?.(url);
                }
              }
            }
          } catch {
            // Non-fatal; old keys will be collected on a future sync.
          }
        }

        onProgress?.({
          loadedBytes: totalBytes,
          totalBytes,
          shardIndex: shards.length,
          shardCount: shards.length,
          completedCount: shards.length,
          phase: 'done'
        });
        return { synced: true, upToDate: true, downloadedBytes, meta };
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
    if (this.db.isSupported()) {
      if (typeof this.db.dropDatabase === 'function') {
        await this.db.dropDatabase();
      } else {
        await this.db.clearAll();
      }
    }
  }
}
