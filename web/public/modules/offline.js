const PERMANENT_REGISTER_ERRORS = new Set(['NotSupportedError']);
const DEFAULT_RETRY_DELAYS_MS = [3000, 6000, 12000, 24000, 48000, 60000];
const UPDATE_THROTTLE_MS = 1000;

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
        if (inFlight === attempt) {
          inFlight = null;
        }
      }
    })();

    inFlight = attempt;
    return attempt;
  }

  return {
    run,
    isCompleted: () => completed
  };
}

export function createOfflineManager({
  serviceWorkerUrl = './service-worker.js',
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
  let started = false;
  let registration = null;
  let registerInFlight = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let refreshing = false;
  let persistRequested = false;
  let lastUpdateCheckAt = -Infinity;
  let hadController = Boolean(sw?.controller);
  const watchedWorkers = new WeakSet();
  const watchedRegistrations = new WeakSet();

  const state = {
    status: sw ? 'checking' : 'unsupported',
    cached: null,
    total: null,
    hasActiveWorker: Boolean(sw?.controller),
    error: null
  };

  function isOffline() {
    return nav?.onLine === false;
  }

  function isVisible() {
    return doc?.visibilityState !== 'hidden';
  }

  function snapshot() {
    return { ...state };
  }

  function emit() {
    onStateChange?.(snapshot());
  }

  function clearRetryTimer() {
    if (retryTimer != null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  function requestPersistentStorage() {
    if (persistRequested || typeof nav?.storage?.persist !== 'function') return;
    persistRequested = true;
    try {
      Promise.resolve(nav.storage.persist()).catch(() => {});
    } catch {
      // Persistent storage is best-effort.
    }
  }

  function markReady() {
    clearRetryTimer();
    retryAttempt = 0;
    const alreadyReady = state.hasActiveWorker && state.status === 'ready';
    state.hasActiveWorker = true;
    state.status = 'ready';
    state.error = null;
    requestPersistentStorage();
    if (!alreadyReady) {
      emit();
    }
  }

  function markUnsupported(errorMessage = null) {
    clearRetryTimer();
    const alreadyUnsupported = state.status === 'unsupported' && state.error === errorMessage;
    state.status = 'unsupported';
    state.error = errorMessage;
    if (!alreadyUnsupported) {
      emit();
    }
  }

  function markIncomplete(errorMessage = null, { scheduleRetry = true } = {}) {
    if (state.hasActiveWorker) return;
    state.status = isOffline() ? 'offline-incomplete' : 'failed';
    state.error = errorMessage;
    emit();

    if (scheduleRetry && !isOffline() && isVisible() && retryDelaysMs.length > 0) {
      const delay = retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
      retryAttempt += 1;
      clearRetryTimer();
      retryTimer = setTimer(() => {
        retryTimer = null;
        if (!isOffline() && isVisible() && !state.hasActiveWorker) {
          ensureRegistered();
        }
      }, delay);
    }
  }

  function watchWorker(worker) {
    if (!worker || watchedWorkers.has(worker)) return;
    watchedWorkers.add(worker);

    const handleState = () => {
      if (worker.state === 'activated') {
        markReady();
        return;
      }
      if (worker.state === 'installing' || worker.state === 'installed' || worker.state === 'activating') {
        if (!state.hasActiveWorker && state.status !== 'installing') {
          state.status = 'installing';
          state.error = null;
          emit();
        }
        return;
      }
      if (worker.state === 'redundant') {
        const reg = registration;
        if (reg?.active) {
          markReady();
          return;
        }
        const replacement =
          (reg?.installing && reg.installing !== worker && reg.installing) ||
          (reg?.waiting && reg.waiting !== worker && reg.waiting) ||
          null;
        if (replacement) {
          watchWorker(replacement);
          return;
        }
        if (reg && !reg.active && !reg.waiting && !reg.installing) {
          registration = null;
        }
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
        if (reg.installing) {
          watchWorker(reg.installing);
        }
      });
    }

    if (reg.active) {
      markReady();
    }
    if (reg.waiting) {
      watchWorker(reg.waiting);
    }
    if (reg.installing) {
      watchWorker(reg.installing);
    }
  }

  async function ensureRegistered() {
    if (!sw) {
      markUnsupported();
      return null;
    }
    if (state.status === 'unsupported') return null;
    if (registerInFlight) return registerInFlight;

    if (!state.hasActiveWorker && state.status !== 'installing') {
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
        // Chromium also throws SecurityError for transient SW fetch failures
        // (redirects, bad MIME type, cert errors), so don't permanently disable
        // recovery — just skip timer-based retries and allow reconnect/retryNow.
        const scheduleRetry = error?.name !== 'SecurityError';
        markIncomplete(error?.message || 'Service worker registration failed.', { scheduleRetry });
        return null;
      } finally {
        registerInFlight = null;
      }
    })();

    return registerInFlight;
  }

  function handleReconnect() {
    if (state.status === 'unsupported') return;
    retryAttempt = 0;
    clearRetryTimer();
    if (!state.hasActiveWorker) {
      ensureRegistered();
    } else {
      checkForUpdate();
    }
  }

  function handleForeground() {
    if (state.status === 'unsupported') return;
    if (isOffline()) return;
    if (!state.hasActiveWorker) {
      retryAttempt = 0;
      clearRetryTimer();
      ensureRegistered();
    } else if (registration) {
      checkForUpdate();
    } else {
      ensureRegistered();
    }
  }

  function handleWorkerMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'sw-cache-progress') {
      if (Number.isFinite(data.cached) && Number.isFinite(data.total)) {
        state.cached = data.cached;
        state.total = data.total;
      }
      if (!state.hasActiveWorker) {
        state.status = 'installing';
        state.error = null;
        emit();
      }
    } else if (data.type === 'sw-cache-ready') {
      markReady();
    }
  }

  function start() {
    if (started) return;
    started = true;

    if (!sw) {
      markUnsupported();
      return;
    }

    if (sw.controller) {
      hadController = true;
      markReady();
    }

    sw.addEventListener?.('controllerchange', () => {
      if (!hadController) {
        hadController = true;
        markReady();
        return;
      }
      if (refreshing) return;
      refreshing = true;
      if (onReload) onReload();
      else win?.location?.reload?.();
    });

    sw.addEventListener?.('message', handleWorkerMessage);
    win?.addEventListener?.('online', handleReconnect);
    win?.addEventListener?.('pageshow', handleForeground);
    doc?.addEventListener?.('visibilitychange', () => {
      if (doc.visibilityState === 'visible') {
        handleForeground();
      } else if (doc.visibilityState === 'hidden') {
        clearRetryTimer();
      }
    });

    ensureRegistered();
  }

  function retryNow() {
    if (state.status === 'unsupported') return Promise.resolve(null);
    retryAttempt = 0;
    clearRetryTimer();
    return ensureRegistered();
  }

  return {
    start,
    retryNow,
    getState: snapshot
  };
}
