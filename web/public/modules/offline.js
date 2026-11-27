export const DATA_CACHE_NAME = 'vicflora-data';
export const PHOTOS_CACHE_NAME = 'vicflora-photos';

const PERMANENT_REGISTER_ERRORS = new Set(['NotSupportedError']);
const DEFAULT_RETRY_DELAYS_MS = [3000, 6000, 12000, 24000, 48000, 60000];
const UPDATE_THROTTLE_MS = 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1500;

export function resolveUrl(url, baseUrl = globalThis.location?.href) {
  if (!baseUrl) return String(url);
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return String(url);
  }
}

export function isQuotaError(error) {
  if (!error) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
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

export async function fetchWithTimeout(fetchImpl, url, { signal, timeoutMs = DEFAULT_IDLE_TIMEOUT_MS, cache } = {}) {
  if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
  };
  const onAbort = () => controller.abort();
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  resetTimer();
  try {
    const opts = cache ? { signal: controller.signal, cache } : { signal: controller.signal };
    const response = await fetchImpl(url, opts);
    resetTimer();
    return { response, resetTimer, cleanup, didTimeOut: () => timedOut, signal: controller.signal };
  } catch (error) {
    cleanup();
    if (timedOut) throw new Error(`Timed out downloading ${url}`);
    throw error;
  }
}

async function readResponseBytes(response, onChunk, { signal, resetTimer, didTimeOut }) {
  if (!response.body?.getReader) {
    try {
      const buf = new Uint8Array(await response.arrayBuffer());
      resetTimer();
      onChunk?.(buf.byteLength);
      return buf;
    } catch (error) {
      if (didTimeOut()) throw new Error('Download stalled (idle timeout)');
      throw error;
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw didTimeOut()
          ? new Error('Download stalled (idle timeout)')
          : new DOMException('Download cancelled', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      resetTimer();
      chunks.push(value);
      total += value.byteLength;
      onChunk?.(value.byteLength);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (didTimeOut()) throw new Error('Download stalled (idle timeout)');
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

export async function fetchVerifiedBytes(
  url,
  {
    fetchImpl = (...args) => globalThis.fetch(...args),
    expectedBytes = null,
    expectedSha256 = null,
    cryptoSubtle = globalThis.crypto?.subtle,
    signal,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    onChunk,
    cache
  } = {}
) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
    let attemptBytes = 0;
    let req = null;
    try {
      req = await fetchWithTimeout(fetchImpl, url, { signal, timeoutMs: idleTimeoutMs, cache });
      const { response } = req;
      if (!response || response.status !== 200) {
        const err = new Error(`Failed to download ${url}: HTTP ${response?.status ?? 'unknown'}`);
        err.status = response?.status;
        throw err;
      }
      if (response.redirected) throw new Error(`Unexpected redirect while downloading ${url}`);
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.toLowerCase().includes('text/html')) {
        throw new Error(`Received HTML instead of data for ${url}`);
      }
      const bytes = await readResponseBytes(response, delta => {
        attemptBytes += delta;
        onChunk?.(delta);
      }, req);
      if (Number.isFinite(expectedBytes) && bytes.byteLength !== expectedBytes) {
        throw new Error(`Size mismatch for ${url}: expected ${expectedBytes} bytes, got ${bytes.byteLength}`);
      }
      if (expectedSha256 && cryptoSubtle && (await sha256Hex(bytes, cryptoSubtle)) !== expectedSha256) {
        throw new Error(`SHA-256 verification failed for ${url}`);
      }
      return { bytes, contentType };
    } catch (error) {
      if (attemptBytes > 0) onChunk?.(-attemptBytes);
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      lastError = error;
      if (error?.status === 404 || attempt >= maxRetries) throw lastError;
      await sleep(retryBaseMs * (2 ** (attempt - 1)) + Math.round(Math.random() * 250), signal);
    } finally {
      req?.cleanup();
    }
  }
  throw lastError;
}

export async function pruneCache(cache, keepUrls) {
  let deleted = 0;
  for (const req of await cache.keys()) {
    if (!keepUrls.has(req.url)) {
      await cache.delete(req);
      deleted += 1;
    }
  }
  return deleted;
}

export async function syncCachePack({
  cacheName,
  items,
  keepUrls = [],
  cachesApi = globalThis.caches,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cryptoSubtle = globalThis.crypto?.subtle,
  baseUrl = globalThis.location?.href,
  signal,
  onProgress,
  onItemCached,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  gc = true,
  inFlightMap = null
}) {
  if (!cachesApi) return { synced: false, upToDate: false, downloadedBytes: 0, skippedReason: 'unsupported' };

  const cache = await cachesApi.open(cacheName);
  const resolvedItems = items.map(item => ({ ...item, resolvedUrl: resolveUrl(item.url, baseUrl) }));
  const activeUrls = new Set([
    ...resolvedItems.map(item => item.resolvedUrl),
    ...keepUrls.map(url => resolveUrl(url, baseUrl))
  ]);
  const existingUrls = new Set((await cache.keys()).map(req => req.url));
  const totalBytes = resolvedItems.reduce((sum, item) => sum + (item.bytes || 0), 0);
  let completedCount = 0;
  let loadedBytes = 0;
  for (const item of resolvedItems) {
    if (existingUrls.has(item.resolvedUrl)) {
      completedCount += 1;
      loadedBytes += item.bytes || 0;
    }
  }

  if (completedCount === resolvedItems.length) {
    if (gc && !signal?.aborted) await pruneCache(cache, activeUrls).catch(() => {});
    return { synced: false, upToDate: true, downloadedBytes: 0, cachedCount: completedCount, totalCount: resolvedItems.length };
  }

  const emitProgress = (itemIndex, phase) => {
    onProgress?.({
      loadedBytes: totalBytes > 0 ? Math.min(loadedBytes, totalBytes) : loadedBytes,
      totalBytes,
      itemIndex,
      completedCount,
      totalCount: resolvedItems.length,
      phase
    });
  };

  let downloadedBytes = 0;
  for (let i = 0; i < resolvedItems.length; i += 1) {
    const item = resolvedItems[i];
    if (existingUrls.has(item.resolvedUrl)) continue;
    if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
    emitProgress(i, 'downloading');

    if (inFlightMap?.has(item.resolvedUrl)) {
      await inFlightMap.get(item.resolvedUrl);
      if (await cache.match(item.resolvedUrl)) {
        existingUrls.add(item.resolvedUrl);
        completedCount += 1;
        loadedBytes = Math.min(totalBytes, loadedBytes + (item.bytes || 0));
        onItemCached?.({ item, itemIndex: i, resolvedUrl: item.resolvedUrl });
        continue;
      }
    }

    const { bytes, contentType } = await fetchVerifiedBytes(item.url, {
      fetchImpl,
      expectedBytes: item.bytes,
      expectedSha256: item.sha256,
      cryptoSubtle,
      signal,
      idleTimeoutMs,
      maxRetries,
      retryBaseMs,
      onChunk: delta => {
        loadedBytes = Math.max(0, loadedBytes + delta);
        emitProgress(i, 'downloading');
      }
    });
    downloadedBytes += bytes.byteLength;
    if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');

    try {
      await cache.put(
        item.resolvedUrl,
        new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': item.contentType || contentType || 'application/octet-stream',
            'Content-Length': String(bytes.byteLength)
          }
        })
      );
    } catch (error) {
      if (isQuotaError(error)) {
        return { synced: false, upToDate: false, downloadedBytes, quotaExceeded: true, skippedReason: 'quota' };
      }
      throw error;
    }

    existingUrls.add(item.resolvedUrl);
    completedCount += 1;
    onItemCached?.({ item, itemIndex: i, resolvedUrl: item.resolvedUrl });
  }

  if (signal?.aborted) throw new DOMException('Sync cancelled', 'AbortError');
  if (gc) await pruneCache(cache, activeUrls).catch(() => {});
  loadedBytes = totalBytes;
  emitProgress(resolvedItems.length, 'done');

  return { synced: true, upToDate: true, downloadedBytes, cachedCount: resolvedItems.length, totalCount: resolvedItems.length };
}

export function createDataStore({
  manifestUrl = './data/manifest.json',
  cacheName = DATA_CACHE_NAME,
  cachesApi = globalThis.caches,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cryptoSubtle = globalThis.crypto?.subtle,
  baseUrl = globalThis.location?.href,
  navigatorObj = globalThis.navigator,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_MS
} = {}) {
  let manifest = null;
  let manifestPromise = null;
  const inFlight = new Map();

  async function loadManifest({ forceRefresh = false } = {}) {
    if (manifest && !forceRefresh) return manifest;
    if (!manifestPromise || forceRefresh) {
      manifestPromise = (async () => {
        const res = await fetchImpl(manifestUrl, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Failed to load manifest: HTTP ${res.status}`);
        const data = await res.json();
        if (!data || !Array.isArray(data.data)) throw new Error('Invalid manifest format');
        manifest = data;
        return data;
      })().finally(() => {
        manifestPromise = null;
      });
    }
    return manifestPromise;
  }

  async function getStatus() {
    const m = await loadManifest().catch(() => null);
    const items = m?.data || [];
    const totalBytes = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
    if (!m || !cachesApi) {
      return { ready: false, cachedCount: 0, totalCount: items.length, cachedBytes: 0, totalBytes };
    }
    const cache = await cachesApi.open(cacheName);
    const keys = new Set((await cache.keys()).map(req => req.url));
    let cachedCount = 0;
    let cachedBytes = 0;
    for (const item of items) {
      if (keys.has(resolveUrl(item.url, baseUrl))) {
        cachedCount += 1;
        cachedBytes += item.bytes || 0;
      }
    }
    return { ready: items.length > 0 && cachedCount === items.length, cachedCount, totalCount: items.length, cachedBytes, totalBytes };
  }

  async function readResponse(id) {
    const m = await loadManifest();
    const entry = m.data.find(item => item.id === id);
    if (!entry) throw new Error(`Unknown data bundle: ${id}`);

    const resolvedUrl = resolveUrl(entry.url, baseUrl);
    const cache = cachesApi ? await cachesApi.open(cacheName) : null;
    const cached = cache ? await cache.match(resolvedUrl) : null;
    if (cached) return cached;

    let task = inFlight.get(resolvedUrl);
    if (!task) {
      task = (async () => {
        const { bytes } = await fetchVerifiedBytes(entry.url, {
          fetchImpl,
          expectedBytes: entry.bytes,
          expectedSha256: entry.sha256,
          cryptoSubtle,
          maxRetries: navigatorObj?.onLine === false ? 1 : maxRetries,
          retryBaseMs
        });
        const response = new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.byteLength) }
        });
        if (cache) await cache.put(resolvedUrl, response.clone()).catch(() => {});
        return response;
      })().finally(() => {
        if (inFlight.get(resolvedUrl) === task) inFlight.delete(resolvedUrl);
      });
      inFlight.set(resolvedUrl, task);
    }

    try {
      return (await task).clone();
    } catch (error) {
      const fallback = cache ? await cache.match(resolveUrl(entry.path, baseUrl), { ignoreSearch: true }) : null;
      if (fallback) return fallback;
      throw error;
    }
  }

  return {
    isSupported: () => Boolean(cachesApi),
    loadManifest,
    getManifest: () => manifest,
    getStatus,
    readResponse,
    readJson: async id => (await readResponse(id)).json(),
    syncAll: async ({ signal, onProgress, onItemCached } = {}) => {
      const m = await loadManifest();
      return syncCachePack({
        cacheName,
        items: (m.data || []).map(item => ({ ...item, contentType: 'application/json; charset=utf-8' })),
        cachesApi,
        fetchImpl,
        cryptoSubtle,
        baseUrl,
        signal,
        onProgress,
        onItemCached,
        inFlightMap: inFlight,
        gc: true
      });
    }
  };
}

export function createRetryableLoader(loadFn) {
  let completed = false;
  let inFlight = null;
  let retryPending = false;

  function run({ retryIfInFlight = false } = {}) {
    if (completed) return Promise.resolve(true);
    if (inFlight) {
      if (retryIfInFlight) retryPending = true;
      return inFlight;
    }
    const attempt = (async () => {
      try {
        await loadFn();
        retryPending = false;
        completed = true;
        return true;
      } catch (error) {
        if (retryPending) {
          retryPending = false;
          if (inFlight === attempt) inFlight = null;
          return run();
        }
        throw error;
      } finally {
        if (inFlight === attempt) inFlight = null;
      }
    })();
    inFlight = attempt;
    return attempt;
  }

  return { run, isCompleted: () => completed, isInFlight: () => inFlight !== null };
}

export function createOfflineManager({
  serviceWorkerUrl = './service-worker.js',
  dataStore = null,
  navigator: nav = globalThis.navigator,
  window: win = globalThis.window,
  document: doc = globalThis.document,
  onStateChange = null,
  onReload = null,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  now = () => Date.now()
} = {}) {
  const sw = nav?.serviceWorker;
  const hasCacheSupport = dataStore ? dataStore.isSupported() : true;
  let started = false;
  let registration = null;
  let registerInFlight = null;
  let dataSyncInFlight = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let refreshing = false;
  let persistRequested = false;
  let lastUpdateCheckAt = -Infinity;
  let hadController = Boolean(sw?.controller);
  const watchedWorkers = new WeakSet();
  const watchedRegistrations = new WeakSet();

  const state = {
    status: sw && hasCacheSupport ? 'checking' : 'unsupported',
    cached: null,
    total: null,
    loadedBytes: null,
    totalBytes: null,
    hasActiveWorker: Boolean(sw?.controller),
    dataReady: !dataStore,
    error: null
  };

  let readyResolved = false;
  let resolveReady;
  const readyPromise = new Promise(resolve => {
    resolveReady = value => {
      if (readyResolved) return;
      readyResolved = true;
      resolve(value);
    };
  });

  const isOffline = () => nav?.onLine === false;
  const isVisible = () => doc?.visibilityState !== 'hidden';
  const snapshot = () => ({ ...state });
  const emit = () => onStateChange?.(snapshot());
  const clearRetryTimer = () => {
    if (retryTimer != null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  function requestPersistentStorage() {
    if (persistRequested || typeof nav?.storage?.persist !== 'function') return;
    persistRequested = true;
    try {
      Promise.resolve(nav.storage.persist()).catch(() => {});
    } catch {}
  }

  function maybeMarkReady() {
    if (!state.hasActiveWorker || !state.dataReady) return false;
    clearRetryTimer();
    retryAttempt = 0;
    const alreadyReady = state.status === 'ready';
    state.status = 'ready';
    state.error = null;
    resolveReady(true);
    requestPersistentStorage();
    if (!alreadyReady) emit();
    return true;
  }

  function markWorkerActive() {
    state.hasActiveWorker = true;
    if (!maybeMarkReady()) ensureDataSynced();
  }

  function markUnsupported(errorMessage = null) {
    clearRetryTimer();
    const changed = state.status !== 'unsupported' || state.error !== errorMessage;
    state.status = 'unsupported';
    state.error = errorMessage;
    resolveReady(false);
    if (changed) emit();
  }

  function scheduleRetryIfNeeded() {
    if (isOffline() || !isVisible() || !retryDelaysMs.length || (state.hasActiveWorker && state.dataReady)) return;
    const delay = retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
    retryAttempt += 1;
    clearRetryTimer();
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!isOffline() && isVisible() && !(state.hasActiveWorker && state.dataReady)) ensureOfflineReady();
    }, delay);
  }

  function markIncomplete(errorMessage = null, { scheduleRetry = true } = {}) {
    if (state.hasActiveWorker && state.dataReady) return;
    state.status = isOffline() ? 'offline-incomplete' : 'failed';
    state.error = errorMessage;
    emit();
    if (scheduleRetry) scheduleRetryIfNeeded();
  }

  function watchWorker(worker) {
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);

    const handleState = () => {
      if (worker.state === 'activated') return markWorkerActive();
      if (worker.state === 'installing' || worker.state === 'installed' || worker.state === 'activating') {
        if (state.status !== 'ready' && state.status !== 'installing') {
          state.status = 'installing';
          state.error = null;
          emit();
        }
        return;
      }
      if (worker.state === 'redundant') {
        const reg = registration;
        if (reg?.active) return markWorkerActive();
        const replacement =
          (reg?.installing && reg.installing !== worker && reg.installing) ||
          (reg?.waiting && reg.waiting !== worker && reg.waiting) ||
          null;
        if (replacement) return watchWorker(replacement);
        if (reg && !reg.active && !reg.waiting && !reg.installing) registration = null;
        markIncomplete('Offline caching was interrupted.');
      }
    };

    worker.addEventListener?.('statechange', handleState);
    handleState();
  }

  function checkForUpdate() {
    if (!registration?.update) return;
    const ts = now();
    if (ts - lastUpdateCheckAt < UPDATE_THROTTLE_MS) return;
    lastUpdateCheckAt = ts;
    registration.update().catch(() => {});
  }

  function attachRegistration(reg) {
    if (!reg) return;
    registration = reg;
    if (!watchedRegistrations.has(reg)) {
      watchedRegistrations.add(reg);
      reg.addEventListener?.('updatefound', () => {
        if (reg.installing) watchWorker(reg.installing);
      });
    }
    if (reg.active) markWorkerActive();
    if (reg.waiting) watchWorker(reg.waiting);
    if (reg.installing) watchWorker(reg.installing);
  }

  async function ensureRegistered() {
    if (!sw || !hasCacheSupport) {
      markUnsupported();
      return null;
    }
    if (state.status === 'unsupported') return null;
    if (registerInFlight) return registerInFlight;
    if (state.status !== 'ready' && state.status !== 'installing') {
      state.status = isOffline() ? 'offline-incomplete' : 'checking';
      state.error = null;
      emit();
    }

    registerInFlight = (async () => {
      try {
        const reg = await sw.register(serviceWorkerUrl);
        attachRegistration(reg);
        if (!reg.active && !reg.waiting && !reg.installing) {
          markIncomplete('Service worker did not start installing.');
        }
        return reg;
      } catch (error) {
        if (PERMANENT_REGISTER_ERRORS.has(error?.name)) {
          markUnsupported(error?.message || 'Service workers are unavailable.');
          return null;
        }
        markIncomplete(error?.message || 'Service worker registration failed.', {
          scheduleRetry: error?.name !== 'SecurityError'
        });
        return null;
      } finally {
        registerInFlight = null;
      }
    })();
    return registerInFlight;
  }

  async function ensureDataSynced() {
    if (!dataStore || state.status === 'unsupported') return;
    if (dataSyncInFlight) return dataSyncInFlight;

    dataSyncInFlight = (async () => {
      try {
        const current = await dataStore.getStatus();
        state.cached = current.cachedCount;
        state.total = current.totalCount;
        state.loadedBytes = current.cachedBytes;
        state.totalBytes = current.totalBytes;

        if (current.ready) {
          state.dataReady = true;
          maybeMarkReady();
          return;
        }
        if (isOffline()) {
          state.dataReady = false;
          markIncomplete('Offline before core data finished downloading.', { scheduleRetry: false });
          return;
        }

        state.dataReady = false;
        if (state.status !== 'installing') {
          state.status = 'installing';
          state.error = null;
          emit();
        }

        const result = await dataStore.syncAll({
          onProgress: progress => {
            state.cached = progress.completedCount;
            state.total = progress.totalCount;
            state.loadedBytes = progress.loadedBytes;
            state.totalBytes = progress.totalBytes;
            if (progress.phase !== 'done') {
              state.status = 'installing';
              state.error = null;
              emit();
            }
          }
        });

        if (result.upToDate || result.synced) {
          state.dataReady = true;
          state.cached = result.totalCount;
          state.total = result.totalCount;
          maybeMarkReady();
        } else if (result.quotaExceeded) {
          markIncomplete('Not enough free storage for offline keys.', { scheduleRetry: false });
        } else {
          markIncomplete('Core data download was interrupted.');
        }
      } catch (error) {
        markIncomplete(error?.message || 'Core data download failed.');
      } finally {
        dataSyncInFlight = null;
      }
    })();
    return dataSyncInFlight;
  }

  function ensureOfflineReady() {
    const regPromise = ensureRegistered();
    if (dataStore && !state.dataReady) ensureDataSynced();
    return regPromise;
  }

  function handleReconnect() {
    if (state.status === 'unsupported') return;
    retryAttempt = 0;
    clearRetryTimer();
    if (!state.hasActiveWorker) ensureOfflineReady();
    else {
      checkForUpdate();
      if (!state.dataReady) ensureDataSynced();
    }
  }

  function handleForeground() {
    if (state.status === 'unsupported' || isOffline()) return;
    if (!state.hasActiveWorker || !state.dataReady) {
      retryAttempt = 0;
      clearRetryTimer();
      ensureOfflineReady();
    } else if (registration) checkForUpdate();
    else ensureRegistered();
  }

  function start() {
    if (started) return;
    started = true;
    if (!sw || !hasCacheSupport) return markUnsupported();

    if (sw.controller) {
      hadController = true;
      state.hasActiveWorker = true;
      if (!dataStore) maybeMarkReady();
    }

    sw.addEventListener?.('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        return markWorkerActive();
      }
      if (refreshing) return;
      refreshing = true;
      if (onReload) onReload();
      else win?.location?.reload?.();
    });

    sw.addEventListener?.('message', event => {
      if (event?.data?.type === 'sw-cache-ready') markWorkerActive();
    });
    win?.addEventListener?.('online', handleReconnect);
    win?.addEventListener?.('pageshow', handleForeground);
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState === 'visible') handleForeground();
      else if (doc.visibilityState === 'hidden') clearRetryTimer();
    });

    ensureOfflineReady();
  }

  return {
    start,
    retryNow: () => {
      if (state.status === 'unsupported') return Promise.resolve(null);
      retryAttempt = 0;
      clearRetryTimer();
      return ensureOfflineReady();
    },
    getState: snapshot,
    waitUntilReady: () => readyPromise
  };
}
