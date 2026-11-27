import { createNavigatorFromData } from './modules/dichotomous.js';
import { MultiAccessSession, listMultiKeys } from './modules/multiaccess.js';
import {
  findInfraspecificTaxa,
  findSoleInfraspecificProfile,
  loadSpeciesIndex,
  taxonUrlFromId
} from './modules/species.js';
import { Glossary } from './modules/glossary.js';
import { PhotoStore, formatBytes } from './modules/photos.js';
import { createDataStore, createOfflineManager, createRetryableLoader } from './modules/offline.js';
import { createBioregionMap, ensureBioregionsLoaded } from './modules/bioregions.js';
import { parseRoute, formatRoute } from './modules/router.js';
import { createSearchIndex, searchUnified } from './modules/search.js';

const statusEl = document.querySelector('#status');
const aboutLink = document.querySelector('#about-link');
const views = {
  home: document.querySelector('#view-home'),
  key: document.querySelector('#view-dichotomous'),
  multi: document.querySelector('#view-multi'),
  taxon: document.querySelector('#view-species'),
  glossary: document.querySelector('#view-glossary'),
  about: document.querySelector('#view-about')
};

const searchElements = {
  shell: document.querySelector('#unified-search-shell'),
  input: document.querySelector('#unified-search'),
  clear: document.querySelector('#unified-search-clear'),
  results: document.querySelector('#unified-search-results')
};

const homeElements = {
  content: document.querySelector('#home-content'),
  multiList: document.querySelector('#home-multi-list')
};

const dichElements = {
  header: document.querySelector('#dichotomous-header'),
  options: document.querySelector('#dichotomous-options'),
  result: document.querySelector('#dichotomous-result'),
  bracketed: document.querySelector('#dichotomous-bracketed'),
  modeButtons: document.querySelectorAll('[data-dich-mode]'),
  back: document.querySelector('#dichotomous-back'),
  restart: document.querySelector('#dichotomous-restart')
};

const multiElements = {
  select: document.querySelector('#multi-key-select'),
  summary: document.querySelector('#multi-summary'),
  characters: document.querySelector('#multi-characters'),
  states: document.querySelector('#multi-states'),
  selections: document.querySelector('#multi-selections'),
  remaining: document.querySelector('#multi-remaining'),
  reset: document.querySelector('#multi-reset'),
  undo: document.querySelector('#multi-undo')
};

const speciesElements = {
  detail: document.querySelector('#species-detail'),
  rankBadge: document.querySelector('#species-rank-badge')
};

const glossaryElements = {
  detail: document.querySelector('#glossary-detail')
};

const offlineCoreStatusEl = document.querySelector('#offline-core-status');
const offlineControlsEl = document.querySelector('#offline-controls');
const appVersionEl = document.querySelector('#app-version');
const installAppBtn = document.querySelector('#install-app-btn');
const photosStatusEl = document.querySelector('#photos-status');
let deferredInstallPrompt = null;
let coreControlsHtml = '';
let photoControlsHtml = '';

const dataStore = createDataStore();
const photoStore = new PhotoStore();
let photoStatus = null;
let photoSyncProgress = null;
let photoSyncLastError = null;
let photoSyncQuotaExceeded = false;
let photoSyncSkippedReason = null;
let photoSyncClearing = false;
let activePhotoSyncController = null;
let activePhotoSyncPromise = null;
let activeUpdateCheckPromise = null;
let updateCheckState = { phase: 'idle', message: null };
let lastStatusUpdateAt = 0;
let lastAutoSyncAttemptAt = 0;
let lastPhotoCheckAt = 0;
let appBooted = false;
let dichControlsBound = false;
let multiControlsBound = false;
let statusOwnedByOffline = false;
let descriptionRenderSeq = 0;
let routeRenderSeq = 0;

let unifiedSearchIndex = null;
let multiKeyMetaList = [];
let dichKeyMetaById = new Map();

let dichNavigator = null;
let globalDichKeys = {};
let dichResult = null;
const lastStepByKey = new Map();

let multiKeyList = [];
const multiSessions = new Map();
let multiSession = null;
let multiState = {
  currentCharacterId: null,
  currentKey: null,
  currentKeyInfo: null
};

let descriptions = {};
let taxonIndex = new Map();
let currentSpeciesId = null;
let glossary = null;
const glossaryPopover = document.querySelector('#gloss-popover');

let currentRoute = { view: 'home' };
let previousRoute = null;
let hasInAppHistory = false;
let floatingSearchOpen = false;
let activeSearchIndex = -1;

const READY_MESSAGE = 'Ready to use offline. Add to Home Screen for easy access.';
const READY_INSTALLED_MESSAGE = 'Ready to use offline.';

function isRunningStandalone() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
      navigator.standalone === true
  );
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

function routesEqual(a, b) {
  return Boolean(a && b && formatRoute(a) === formatRoute(b));
}

function updateVersionBadge(manifest) {
  if (appVersionEl && manifest?.shellHash) {
    appVersionEl.textContent = `v${manifest.shellHash.slice(0, 7)}`;
  }
}

function setStatus(message, { managedByOffline = false } = {}) {
  statusOwnedByOffline = managedByOffline;
  if (statusEl) {
    statusEl.textContent = message || '';
  }
}

function getOfflineStatusMessage() {
  const offline = offlineManager.getState();
  if (offline.status === 'ready') {
    return isRunningStandalone() ? READY_INSTALLED_MESSAGE : READY_MESSAGE;
  }
  if (offline.status === 'unsupported') {
    return 'Keys loaded. Offline caching is unavailable in this browser.';
  }
  if (offline.status === 'offline-incomplete') {
    return 'Offline setup incomplete — reconnect to finish downloading keys for offline use.';
  }
  if (offline.status === 'failed') {
    return 'Offline download was interrupted — retrying automatically when connected…';
  }
  if (Number.isFinite(offline.loadedBytes) && Number.isFinite(offline.totalBytes) && offline.totalBytes > 0) {
    return `Downloading keys for offline use (${formatBytes(offline.loadedBytes)} / ${formatBytes(offline.totalBytes)})…`;
  }
  if (Number.isFinite(offline.cached) && Number.isFinite(offline.total) && offline.total > 0) {
    return `Downloading keys for offline use (${offline.cached}/${offline.total})…`;
  }
  return 'Downloading keys for offline use…';
}

function setOfflineStatus() {
  setStatus(getOfflineStatusMessage(), { managedByOffline: true });
}

function renderOfflineControls() {
  if (!offlineControlsEl) return;
  offlineControlsEl.innerHTML = `${coreControlsHtml}${photoControlsHtml}`;
}

function setCoreControls(html) {
  coreControlsHtml = html || '';
  renderOfflineControls();
}

function renderOfflineCoreStatus() {
  if (!offlineCoreStatusEl) return;
  const offline = offlineManager.getState();
  if (offline.status === 'ready') {
    if (offline.updating) {
      offlineCoreStatusEl.textContent = 'Downloading app & keys update… The app will reload once finished.';
      setCoreControls('<button type="button" class="secondary" disabled>Updating…</button>');
      return;
    }
    if (updateCheckState.phase === 'checking') {
      offlineCoreStatusEl.textContent = 'Checking for updates…';
      setCoreControls('<button type="button" class="secondary" disabled>Checking…</button>');
      return;
    }
    if (updateCheckState.phase === 'checking-photos') {
      offlineCoreStatusEl.textContent =
        photoSyncProgress && photoSyncProgress.phase !== 'done'
          ? 'App & keys are up to date. Downloading updated photos…'
          : 'App & keys are up to date. Checking photos…';
      setCoreControls('<button type="button" class="secondary" disabled>Checking…</button>');
      return;
    }
    offlineCoreStatusEl.textContent =
      updateCheckState.phase === 'done' && updateCheckState.message
        ? updateCheckState.message
        : 'Offline keys & descriptions ready.';
    setCoreControls('<button type="button" class="secondary" data-check-updates="true">Check for updates</button>');
    return;
  }
  if (offline.status === 'unsupported') {
    offlineCoreStatusEl.textContent =
      'Offline caching is unavailable in this browser (e.g. private browsing or an in-app browser). Open in Safari or Chrome to use offline.';
    setCoreControls('');
    return;
  }
  if (offline.status === 'installing' || offline.status === 'checking') {
    const progress =
      Number.isFinite(offline.loadedBytes) && Number.isFinite(offline.totalBytes) && offline.totalBytes > 0
        ? ` (${formatBytes(offline.loadedBytes)} / ${formatBytes(offline.totalBytes)})`
        : (Number.isFinite(offline.cached) && Number.isFinite(offline.total) && offline.total > 0
          ? ` (${offline.cached}/${offline.total})`
          : '');
    offlineCoreStatusEl.textContent = `Downloading keys & descriptions for offline use${progress}… Keep this app open with reception until finished.`;
    setCoreControls('');
    return;
  }
  offlineCoreStatusEl.textContent =
    offline.status === 'offline-incomplete'
      ? 'Offline keys & descriptions have not finished downloading yet. Reconnect to finish.'
      : 'Offline download was interrupted before finishing.';
  setCoreControls('<button type="button" class="secondary" data-offline-retry="true">Retry offline download</button>');
}

function isWaitingForCoreOffline() {
  const status = offlineManager.getState().status;
  return status !== 'ready' && status !== 'unsupported';
}

let lastOfflineStatus = null;
const offlineManager = createOfflineManager({
  dataStore,
  onStateChange(state) {
    const prevStatus = lastOfflineStatus;
    lastOfflineStatus = state.status;
    renderOfflineCoreStatus();
    renderPhotosStatus();
    if (appBooted && statusOwnedByOffline) {
      setOfflineStatus();
    }
    const wasSettled = prevStatus === 'ready' || prevStatus === 'unsupported';
    const isSettled = state.status === 'ready' || state.status === 'unsupported';
    if (state.status === 'ready') {
      retryMissingViewData({ retryIfInFlight: true });
    }
    if (appBooted && !wasSettled && isSettled && !photoStore.isDisabled()) {
      syncPhotosInBackground({ immediate: true });
    }
  }
});
lastOfflineStatus = offlineManager.getState().status;

function initInstallPrompt() {
  if (!installAppBtn) return;

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installAppBtn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installAppBtn.hidden = true;
    if (appBooted && statusOwnedByOffline) {
      setOfflineStatus();
    }
  });

  installAppBtn.addEventListener('click', async () => {
    const promptEvent = deferredInstallPrompt;
    if (!promptEvent) return;
    deferredInstallPrompt = null;
    installAppBtn.hidden = true;
    try {
      await promptEvent.prompt();
      await promptEvent.userChoice;
    } catch {
      // User dismissed or browser cancelled the install prompt.
    }
  });
}

function formatMeasurement(value) {
  if (!Number.isFinite(value)) return '';
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 1
  });
}

// ---------------------------------------------------------------------------
// Data loaders (all backed by Cache Storage via dataStore)
// ---------------------------------------------------------------------------

async function loadGlossary() {
  try {
    const terms = await dataStore.readJson('glossary');
    glossary = new Glossary(terms);
    return terms;
  } catch (error) {
    console.warn('Could not load glossary:', error);
    return [];
  }
}

async function loadCoreData() {
  setStatus('Loading search index…');
  dataStore.loadManifest().then(updateVersionBadge).catch(() => {});
  const [searchIndexBundle, speciesIndexBundle, glossaryTerms] = await Promise.all([
    dataStore.readJson('searchIndex'),
    dataStore.readJson('speciesIndex'),
    loadGlossary()
  ]);

  taxonIndex = loadSpeciesIndex(speciesIndexBundle);
  unifiedSearchIndex = createSearchIndex(searchIndexBundle, taxonIndex, glossaryTerms);
  multiKeyMetaList = unifiedSearchIndex.multiAccessKeys;
  dichKeyMetaById = unifiedSearchIndex.dichKeyById;

  renderHomeQuickStart();
  renderUnifiedSearch();
  setOfflineStatus();
}

const dichLoader = createRetryableLoader(async () => {
  setStatus('Loading dichotomous keys…');
  const bundle = await dataStore.readJson('dichotomous');
  globalDichKeys = bundle.keys || {};
  setOfflineStatus();
});

function ensureDichotomousLoaded({ retryIfInFlight = false } = {}) {
  return dichLoader.run({ retryIfInFlight }).catch(error => {
    console.error(error);
    const msg =
      navigator.onLine === false
        ? 'Offline — dichotomous keys have not finished downloading yet. Reconnect to load.'
        : error.message;
    setStatus(msg);
    throw error;
  });
}

const multiLoader = createRetryableLoader(async () => {
  setStatus('Loading multi-access keys…');
  multiElements.summary.textContent = 'Loading multi-access keys…';
  const multiBundle = await dataStore.readJson('multi');
  multiKeyList = listMultiKeys(multiBundle.keys || {});
  if (multiKeyList.length) {
    populateMultiSelect(multiKeyList);
    bindMultiControls();
  } else {
    multiElements.summary.textContent = '';
  }
  setOfflineStatus();
});

function ensureMultiLoaded({ retryIfInFlight = false } = {}) {
  return multiLoader.run({ retryIfInFlight }).catch(error => {
    console.error(error);
    const msg =
      navigator.onLine === false
        ? 'Offline — multi-access keys have not finished downloading yet. Reconnect to load.'
        : error.message;
    multiElements.summary.textContent = msg;
    setStatus(msg);
    throw error;
  });
}

const descriptionsLoader = createRetryableLoader(async () => {
  const bundle = await dataStore.readJson('descriptions');
  descriptions = bundle.taxa || {};
});

function ensureDescriptionsLoaded({ retryIfInFlight = false } = {}) {
  return descriptionsLoader.run({ retryIfInFlight }).catch(error => {
    console.warn('Could not load descriptions:', error);
  });
}

// ---------------------------------------------------------------------------
// Hash router
// ---------------------------------------------------------------------------

function navigateTo(route, { replace = false } = {}) {
  const nextHash = formatRoute(route);
  const currentHash = window.location.hash || '#/';
  if (replace) {
    window.history.replaceState(null, '', nextHash);
    applyHashChange({ recordHistory: false });
    return;
  }
  if (currentHash === nextHash) {
    renderRoute(parseRoute(nextHash));
    return;
  }
  window.location.hash = nextHash;
}

function setActiveView(viewName) {
  Object.entries(views).forEach(([name, section]) => {
    if (!section) return;
    section.classList.toggle('visible', name === viewName);
  });
  if (aboutLink) {
    aboutLink.classList.toggle('active', viewName === 'about');
  }
}

function applyHashChange({ recordHistory = true } = {}) {
  hideGlossaryTerm();
  const nextRoute = parseRoute(window.location.hash);
  if (recordHistory && !routesEqual(currentRoute, nextRoute)) {
    previousRoute = currentRoute;
    hasInAppHistory = true;
  }
  currentRoute = nextRoute;
  if (currentRoute.view !== 'home') {
    floatingSearchOpen = false;
  }
  renderUnifiedSearch();
  renderRoute(currentRoute);
}

async function renderRoute(route) {
  const seq = ++routeRenderSeq;
  setActiveView(route.view);

  if (route.view === 'home') {
    renderUnifiedSearch();
    return;
  }
  if (route.view === 'about') {
    if (updateCheckState.phase === 'done') {
      updateCheckState = { phase: 'idle', message: null };
    }
    renderOfflineCoreStatus();
    refreshPhotoStatus();
    return;
  }
  if (route.view === 'key') {
    await renderDichotomousRoute(route, seq);
    return;
  }
  if (route.view === 'multi') {
    await renderMultiRoute(route, seq);
    return;
  }
  if (route.view === 'taxon') {
    await renderTaxonRoute(route, seq);
    return;
  }
  if (route.view === 'glossary') {
    await renderGlossaryRoute(route, seq);
  }
}

// ---------------------------------------------------------------------------
// Unified instant search UI & Home quick-start
// ---------------------------------------------------------------------------

function renderHomeQuickStart() {
  if (!homeElements.multiList) return;
  if (!multiKeyMetaList.length) {
    homeElements.multiList.innerHTML = '<p class="muted">No multi-access keys bundled.</p>';
    return;
  }
  homeElements.multiList.innerHTML = multiKeyMetaList
    .map(
      entry => `
        <a class="quick-key-card" href="${escapeHtml(formatRoute({ view: 'multi', keyId: entry.id }))}">
          <strong>${escapeHtml(entry.title)}</strong>
        </a>
      `
    )
    .join('');
}

function formatRankBadge(rank) {
  if (!rank) return 'Taxon';
  const normalized = String(rank).toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function renderSearchGroup(title, itemsHtml) {
  return `
    <div class="search-group">
      <div class="search-group-header"><span>${escapeHtml(title)}</span></div>
      <ul class="search-group-list" role="presentation">${itemsHtml}</ul>
    </div>
  `;
}

function updateActiveSearchHighlight() {
  const links = Array.from(searchElements.results.querySelectorAll('.search-result-item'));
  if (!links.length) {
    activeSearchIndex = -1;
    return;
  }
  if (activeSearchIndex >= links.length) activeSearchIndex = 0;
  if (activeSearchIndex < -1) activeSearchIndex = links.length - 1;
  links.forEach((el, idx) => {
    const active = idx === activeSearchIndex;
    el.classList.toggle('is-active', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}

function renderUnifiedSearch() {
  const query = searchElements.input.value;
  const trimmed = query.trim();
  const onHome = currentRoute.view === 'home';

  searchElements.clear.hidden = query.length === 0;

  const shouldShow = trimmed.length >= 2 && (onHome || floatingSearchOpen);
  if (homeElements.content) {
    homeElements.content.hidden = onHome && trimmed.length >= 2;
  }

  searchElements.results.classList.toggle('is-inline', onHome);
  searchElements.results.classList.toggle('is-floating', !onHome);

  if (!shouldShow) {
    searchElements.results.hidden = true;
    searchElements.results.innerHTML = '';
    searchElements.input.setAttribute('aria-expanded', 'false');
    activeSearchIndex = -1;
    return;
  }

  searchElements.results.hidden = false;
  searchElements.input.setAttribute('aria-expanded', 'true');

  if (!unifiedSearchIndex) {
    searchElements.results.innerHTML = '<p class="search-empty">Loading search index…</p>';
    return;
  }

  const { multiAccessKeys, dichotomousKeys, taxa, glossaryTerms } = searchUnified(
    unifiedSearchIndex,
    trimmed,
    {
      multiLimit: 5,
      dichLimit: 8,
      taxonLimit: 20,
      glossaryLimit: 8
    }
  );

  const groups = [];

  if (multiAccessKeys.length) {
    const items = multiAccessKeys
      .map(
        entry => `
          <li>
            <a class="search-result-item" role="option" href="${escapeHtml(formatRoute({ view: 'multi', keyId: entry.id }))}">
              <span class="search-result-main">
                <span class="search-result-title">${escapeHtml(entry.title)}</span>
              </span>
              <span class="search-result-badges">
                <span class="result-badge result-badge--multi">Multi-access</span>
              </span>
            </a>
          </li>
        `
      )
      .join('');
    groups.push(renderSearchGroup(`Multi-Access Keys (${multiAccessKeys.length})`, items));
  }

  if (dichotomousKeys.length) {
    const items = dichotomousKeys
      .map(entry => {
        const showScope =
          entry.scope && entry.scope.toLowerCase() !== (entry.title || '').toLowerCase();
        return `
          <li>
            <a class="search-result-item" role="option" href="${escapeHtml(formatRoute({ view: 'key', keyId: entry.id }))}">
              <span class="search-result-main">
                <span class="search-result-title">${escapeHtml(entry.title)}</span>
                ${showScope ? `<span class="search-result-sub">${escapeHtml(entry.scope)}</span>` : ''}
              </span>
              <span class="search-result-badges">
                <span class="result-badge result-badge--dich">Key ${escapeHtml(entry.id)}</span>
              </span>
            </a>
          </li>
        `;
      })
      .join('');
    groups.push(renderSearchGroup(`Dichotomous Keys (${dichotomousKeys.length})`, items));
  }

  if (taxa.length) {
    const items = taxa
      .map(
        entry => `
          <li>
            <a class="search-result-item" role="option" href="${escapeHtml(formatRoute({ view: 'taxon', taxonId: entry.id }))}">
              <span class="search-result-main">
                <span class="search-result-title scientific_name">${escapeHtml(entry.name)}</span>
                ${entry.vernacular ? `<span class="search-result-sub">${escapeHtml(entry.vernacular)}</span>` : ''}
              </span>
              <span class="search-result-badges">
                ${entry.toKey ? '<span class="result-badge result-badge--has-key">Has key</span>' : ''}
                <span class="result-badge result-badge--taxon">${escapeHtml(formatRankBadge(entry.rank))}</span>
              </span>
            </a>
          </li>
        `
      )
      .join('');
    groups.push(renderSearchGroup(`Taxa & Species (${taxa.length})`, items));
  }

  if (glossaryTerms.length) {
    const items = glossaryTerms
      .map(
        entry => `
          <li>
            <a class="search-result-item" role="option" href="${escapeHtml(formatRoute({ view: 'glossary', term: entry.name }))}">
              <span class="search-result-main">
                <span class="search-result-title">${escapeHtml(entry.name)}</span>
                ${entry.preview ? `<span class="search-result-sub">${escapeHtml(entry.preview)}</span>` : ''}
              </span>
              <span class="search-result-badges">
                <span class="result-badge result-badge--glossary">Glossary</span>
              </span>
            </a>
          </li>
        `
      )
      .join('');
    groups.push(renderSearchGroup(`Glossary (${glossaryTerms.length})`, items));
  }

  if (!groups.length) {
    searchElements.results.innerHTML =
      `<p class="search-empty">No keys or taxa matching “${escapeHtml(trimmed)}”.</p>`;
    activeSearchIndex = -1;
    return;
  }

  searchElements.results.innerHTML = groups.join('');
  activeSearchIndex = -1;
}

function clearUnifiedSearch({ focus = false } = {}) {
  searchElements.input.value = '';
  floatingSearchOpen = false;
  activeSearchIndex = -1;
  renderUnifiedSearch();
  if (focus) searchElements.input.focus();
}

function initUnifiedSearch() {
  searchElements.input.addEventListener('input', () => {
    if (currentRoute.view !== 'home') {
      floatingSearchOpen = searchElements.input.value.trim().length >= 2;
    }
    renderUnifiedSearch();
  });

  searchElements.input.addEventListener('focus', () => {
    if (currentRoute.view !== 'home' && searchElements.input.value.trim().length >= 2) {
      floatingSearchOpen = true;
      renderUnifiedSearch();
    }
  });

  searchElements.input.addEventListener('keydown', event => {
    const links = Array.from(searchElements.results.querySelectorAll('.search-result-item'));
    if (event.key === 'ArrowDown' && links.length) {
      event.preventDefault();
      activeSearchIndex = activeSearchIndex < links.length - 1 ? activeSearchIndex + 1 : 0;
      updateActiveSearchHighlight();
      return;
    }
    if (event.key === 'ArrowUp' && links.length) {
      event.preventDefault();
      activeSearchIndex = activeSearchIndex > 0 ? activeSearchIndex - 1 : links.length - 1;
      updateActiveSearchHighlight();
      return;
    }
    if (event.key === 'Enter' && !searchElements.results.hidden && links.length) {
      event.preventDefault();
      const target = links[activeSearchIndex >= 0 ? activeSearchIndex : 0];
      if (target) {
        floatingSearchOpen = false;
        searchElements.input.blur();
        const href = target.getAttribute('href');
        if (href) navigateTo(parseRoute(href));
      }
      return;
    }
    if (event.key === 'Escape') {
      if (currentRoute.view !== 'home' && floatingSearchOpen) {
        event.preventDefault();
        floatingSearchOpen = false;
        renderUnifiedSearch();
        searchElements.input.blur();
      } else if (currentRoute.view === 'home' && searchElements.input.value) {
        event.preventDefault();
        clearUnifiedSearch({ focus: true });
      }
    }
  });

  searchElements.clear.addEventListener('click', () => {
    clearUnifiedSearch({ focus: true });
  });

  searchElements.results.addEventListener('click', event => {
    const link = event.target.closest('.search-result-item');
    if (link) {
      floatingSearchOpen = false;
      searchElements.input.blur();
    }
  });

  document.addEventListener('click', event => {
    if (floatingSearchOpen && searchElements.shell && !searchElements.shell.contains(event.target)) {
      floatingSearchOpen = false;
      renderUnifiedSearch();
    }
    const clearTrigger = event.target.closest('[data-clear-search="true"]');
    if (clearTrigger) {
      clearUnifiedSearch();
    }
  });
}

// ---------------------------------------------------------------------------
// Dichotomous key view
// ---------------------------------------------------------------------------

function itemLabel(item, via) {
  if (!item) return '';
  const name = item.name || '';
  const viaName = via ? ` → ${via.name || ''}` : '';
  const key = item.toKey || via?.toKey;
  return `${name}${viaName}${key ? ` (see key ${key})` : ''}`;
}

async function renderDichotomousRoute(route, seq) {
  const meta = dichKeyMetaById.get(route.keyId);
  if (!dichLoader.isCompleted()) {
    dichElements.header.innerHTML = `<strong>${escapeHtml(meta?.title || `Key ${route.keyId}`)}</strong>`;
    dichElements.options.hidden = false;
    dichElements.bracketed.hidden = true;
    dichElements.options.innerHTML = '<p class="muted">Loading dichotomous key…</p>';
    dichElements.result.classList.remove('visible');
    dichElements.result.innerHTML = '';
  }

  try {
    await ensureDichotomousLoaded();
  } catch {
    if (seq !== routeRenderSeq) return;
    dichElements.options.innerHTML =
      '<p>Could not load dichotomous keys. <button type="button" class="secondary" data-offline-retry="true">Retry</button></p>';
    return;
  }
  if (seq !== routeRenderSeq) return;

  if (!globalDichKeys[route.keyId]) {
    dichNavigator = null;
    dichElements.header.innerHTML = `<strong>Key ${escapeHtml(route.keyId)} not found</strong>`;
    dichElements.options.hidden = false;
    dichElements.bracketed.hidden = true;
    dichElements.options.innerHTML =
      '<p>That key ID is not in the bundled dataset. <a href="#/">Return home</a> or try searching above.</p>';
    dichElements.result.classList.remove('visible');
    dichElements.result.innerHTML = '';
    return;
  }

  try {
    if (!dichNavigator || dichNavigator.currentKeyId !== route.keyId) {
      dichNavigator = createNavigatorFromData(globalDichKeys, route.keyId);
    }

    if (route.mode !== 'bracketed') {
      const targetLeadId = route.leadId || dichNavigator.rootNodeId;
      const ok = dichNavigator.goToLead(targetLeadId);
      if (!ok) {
        dichNavigator.reset();
      }
      if (dichNavigator.currentNodeId !== dichNavigator.rootNodeId) {
        lastStepByKey.set(route.keyId, dichNavigator.currentNodeId);
      } else {
        lastStepByKey.delete(route.keyId);
      }
    } else {
      const remembered = lastStepByKey.get(route.keyId);
      if (remembered) {
        dichNavigator.goToLead(remembered);
      } else {
        dichNavigator.reset();
      }
    }
  } catch (error) {
    setStatus(error.message);
    return;
  }

  bindDichotomousControls();
  renderDichotomous(route.mode);
}

function renderDichotomous(mode) {
  if (!dichNavigator) return;
  dichResult = null;
  const header = dichNavigator.getHeader();
  dichElements.header.innerHTML = `<strong>${escapeHtml(header.keyTitle)}</strong>`;

  dichElements.modeButtons.forEach(button => {
    const isCurrent =
      (button.dataset.dichMode === 'bracketed' && mode === 'bracketed') ||
      (button.dataset.dichMode === 'interactive' && mode !== 'bracketed');
    button.setAttribute('aria-pressed', String(isCurrent));
  });

  dichElements.options.innerHTML = '';
  dichElements.result.classList.remove('visible');
  dichElements.result.innerHTML = '';

  const bracketed = mode === 'bracketed';
  dichElements.options.hidden = bracketed;
  dichElements.bracketed.hidden = !bracketed;
  if (bracketed) {
    renderBracketed();
    return;
  }
  dichElements.bracketed.innerHTML = '';

  const options = dichNavigator.getOptions();
  if (options.length === 0) {
    dichElements.options.innerHTML = '<p>No leads available. Use back or restart.</p>';
    return;
  }

  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    button.innerHTML = `
      <strong>${index + 1}. ${option.lead.text}</strong>
      ${option.item ? `<br/><span>${escapeHtml(itemLabel(option.item, option.via))}</span>` : ''}
    `;
    button.addEventListener('click', () => handleDichotomousChoice(index));
    annotateGlossary(button.querySelector('strong'));
    dichElements.options.appendChild(button);
  });
}

const LEAD_MARKS = ['', '′', '″', '‴'];

function renderBracketed() {
  const { couplets, numberByNode, currentNodeId, pathNodeIds } = dichNavigator.getBracketed();
  const onPath = new Set(pathNodeIds);
  const list = dichElements.bracketed;
  list.innerHTML = '';

  couplets.forEach(couplet => {
    const li = document.createElement('li');
    li.className = 'couplet';
    li.id = `couplet-${couplet.number}`;
    li.classList.toggle('on-path', onPath.has(couplet.nodeId));
    li.classList.toggle('current', couplet.nodeId === currentNodeId && couplets.length > 1);

    couplet.leads.forEach((lead, index) => {
      const row = document.createElement('div');
      row.className = 'lead';

      const label = document.createElement('span');
      label.className = 'lead-number';
      label.textContent = `${couplet.number}${LEAD_MARKS[index] ?? String.fromCharCode(97 + index)}`;
      if (index === 0 && couplet.parentNumber) {
        const from = document.createElement('button');
        from.type = 'button';
        from.className = 'link from';
        from.dataset.goto = couplet.parentNumber;
        from.setAttribute('aria-label', `Back to couplet ${couplet.parentNumber}`);
        from.textContent = `(${couplet.parentNumber})`;
        label.append(' ', from);
      }

      const text = document.createElement('span');
      text.className = 'lead-text';
      text.innerHTML = lead.text;
      annotateGlossary(text);

      const dest = document.createElement('span');
      dest.className = 'lead-dest';
      if (lead.goto) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link';
        button.dataset.goto = lead.goto;
        button.textContent = `→ ${lead.goto}`;
        dest.append(button);
      } else if (lead.item) {
        const keyTarget = lead.item.toKey || lead.via?.toKey;
        const taxonId = lead.via?.taxonId || lead.item.taxonId;
        const labelText = lead.via
          ? `${lead.item.name} → ${lead.via.name}`
          : lead.item.name || '';

        if (keyTarget) {
          const link = document.createElement('a');
          link.className = 'taxon link';
          link.href = formatRoute({ view: 'key', keyId: String(keyTarget), mode: 'bracketed' });
          link.title = `Open key ${keyTarget}`;
          link.textContent = `${labelText} ›`;
          dest.append(link);
        } else if (taxonId) {
          const link = document.createElement('a');
          link.className = 'taxon link';
          link.href = formatRoute({ view: 'taxon', taxonId });
          link.title = `Open profile for ${labelText}`;
          link.textContent = labelText;
          dest.append(link);
        } else {
          const name = document.createElement('span');
          name.className = 'taxon';
          name.textContent = labelText;
          dest.append(name);
        }
      }

      row.append(label, text, dest);
      li.append(row);
    });
    list.append(li);
  });

  const current = numberByNode.get(currentNodeId);
  if (current > 1) {
    scrollToCouplet(current, { flash: false, smooth: false });
  }
}

function scrollToCouplet(number, { flash = true, smooth = true } = {}) {
  const target = document.getElementById(`couplet-${number}`);
  if (!target) return;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  if (flash) {
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }
}

function showResult(item, via = null) {
  dichResult = { item, via };
  dichElements.result.classList.add('visible');
  const taxonId = via?.taxonId || item.taxonId;
  const nextKey = item.toKey || via?.toKey;
  const lines = [];

  if (nextKey) {
    const href = formatRoute({ view: 'key', keyId: String(nextKey) });
    lines.push(
      `<h3><a class="link" href="${escapeHtml(href)}">${escapeHtml(item.name || 'Result')}</a></h3>`
    );
  } else if (taxonId) {
    const href = formatRoute({ view: 'taxon', taxonId });
    lines.push(
      `<h3><a class="link scientific_name" href="${escapeHtml(href)}">${escapeHtml(item.name || 'Result')}</a></h3>`
    );
  } else {
    lines.push(`<h3>${escapeHtml(item.name || 'Result')}</h3>`);
  }

  if (via) {
    lines.push(`<p>Represented in Victoria by <strong>${escapeHtml(via.name || '')}</strong>.</p>`);
  }
  lines.push('<div class="taxon-description"></div>');

  if (nextKey) {
    const href = formatRoute({ view: 'key', keyId: String(nextKey) });
    lines.push(
      `<p><a class="btn-link btn-secondary" href="${escapeHtml(href)}">Continue in key ${escapeHtml(nextKey)} →</a></p>`
    );
  }
  if (taxonId) {
    const href = formatRoute({ view: 'taxon', taxonId });
    lines.push(`<p><a href="${escapeHtml(href)}">Open full taxon profile →</a></p>`);
  }
  const itemUrl = item.taxonId ? taxonUrlFromId(item.taxonId) : item.url;
  const viaUrl = via?.taxonId ? taxonUrlFromId(via.taxonId) : via?.url;
  if (itemUrl) {
    lines.push(`<p><a href="${escapeHtml(itemUrl)}" target="_blank" rel="noopener">Open VicFlora entry</a></p>`);
  }
  if (viaUrl) {
    lines.push(
      `<p><a href="${escapeHtml(viaUrl)}" target="_blank" rel="noopener">Open VicFlora entry for ${escapeHtml(via.name || '')}</a></p>`
    );
  }

  dichElements.result.innerHTML = lines.join('');
  fillDescription(dichElements.result.querySelector('.taxon-description'), taxonId);
}

function handleDichotomousChoice(index) {
  if (!dichNavigator) return;
  const options = dichNavigator.getOptions();
  const chosen = options[index];
  if (!chosen) return;

  const { lead, item, via } = chosen;
  const linkedKeyId = item?.toKey || via?.toKey;
  if (linkedKeyId && globalDichKeys[String(linkedKeyId)]) {
    navigateTo({ view: 'key', keyId: String(linkedKeyId), mode: 'interactive', leadId: null });
    return;
  }
  if (item) {
    showResult(item, via);
    return;
  }

  const leadId = String(lead.id);
  navigateTo({ view: 'key', keyId: dichNavigator.currentKeyId, mode: 'interactive', leadId });
}

function bindDichotomousControls() {
  if (dichControlsBound) return;
  dichControlsBound = true;

  dichElements.back.addEventListener('click', () => {
    if (!dichNavigator || currentRoute.view !== 'key') return;
    if (currentRoute.mode === 'bracketed') {
      if (hasInAppHistory) {
        window.history.back();
      } else {
        navigateTo({ view: 'home' });
      }
      return;
    }

    const parentLeadId = dichNavigator.getParentLeadId();
    if (parentLeadId) {
      const isRoot = parentLeadId === dichNavigator.rootNodeId;
      const targetRoute = {
        view: 'key',
        keyId: currentRoute.keyId,
        mode: 'interactive',
        leadId: isRoot ? null : String(parentLeadId)
      };
      if (previousRoute && routesEqual(previousRoute, targetRoute)) {
        window.history.back();
      } else {
        navigateTo(targetRoute);
      }
      return;
    }

    if (hasInAppHistory) {
      window.history.back();
    } else {
      setStatus('Already at the start of this key.');
    }
  });

  dichElements.modeButtons.forEach(button => {
    button.addEventListener('click', () => {
      if (currentRoute.view !== 'key') return;
      const targetMode = button.dataset.dichMode === 'bracketed' ? 'bracketed' : 'interactive';
      if (targetMode === currentRoute.mode) return;
      const leadId =
        targetMode === 'interactive' ? lastStepByKey.get(currentRoute.keyId) || null : null;
      navigateTo(
        { view: 'key', keyId: currentRoute.keyId, mode: targetMode, leadId },
        { replace: true }
      );
    });
  });

  dichElements.bracketed.addEventListener('click', event => {
    const target = event.target.closest('button[data-goto]');
    if (target) {
      scrollToCouplet(target.dataset.goto);
    }
  });

  dichElements.restart.addEventListener('click', () => {
    if (currentRoute.view !== 'key') return;
    lastStepByKey.delete(currentRoute.keyId);
    dichResult = null;
    if (currentRoute.leadId) {
      navigateTo({ view: 'key', keyId: currentRoute.keyId, mode: currentRoute.mode, leadId: null });
    } else if (dichNavigator) {
      dichNavigator.reset();
      renderDichotomous(currentRoute.mode);
    }
  });
}

// ---------------------------------------------------------------------------
// Multi-access key view
// ---------------------------------------------------------------------------

function populateMultiSelect(list) {
  multiElements.select.innerHTML = '';
  list.forEach(entry => {
    const option = document.createElement('option');
    option.value = entry.id;
    const label = entry.title || entry.id;
    option.textContent = `${label} (${entry.entities} taxa)`;
    multiElements.select.appendChild(option);
  });
  return list;
}

function resolveMultiKeyInfo(requestedId) {
  if (!multiKeyList.length) return null;
  if (!requestedId) return multiKeyList[0];
  return (
    multiKeyList.find(entry => entry.id === requestedId) ||
    multiKeyList.find(entry => `key-${entry.id}-complete.json` === requestedId) ||
    null
  );
}

async function renderMultiRoute(route, seq) {
  try {
    await ensureMultiLoaded();
  } catch {
    return;
  }
  if (seq !== routeRenderSeq) return;

  const keyInfo = resolveMultiKeyInfo(route.keyId);
  if (!keyInfo) {
    multiElements.summary.innerHTML = `<strong>Multi-access key not found.</strong> <a href="#/">Return home</a>`;
    multiElements.characters.innerHTML = '';
    multiElements.states.innerHTML = '';
    multiElements.selections.innerHTML = '';
    multiElements.remaining.innerHTML = '';
    return;
  }

  if (!route.keyId || route.keyId !== keyInfo.id) {
    navigateTo({ view: 'multi', keyId: keyInfo.id }, { replace: true });
    return;
  }

  let cached = multiSessions.get(keyInfo.id);
  if (!cached) {
    cached = {
      session: new MultiAccessSession(keyInfo.data),
      currentCharacterId: null
    };
    multiSessions.set(keyInfo.id, cached);
  }

  multiSession = cached.session;
  multiState.currentKey = keyInfo.id;
  multiState.currentKeyInfo = keyInfo;
  multiState.currentCharacterId = cached.currentCharacterId;
  multiElements.select.value = keyInfo.id;
  renderMultiAll(multiSession);
}

function renderMultiSummary(session, keyInfo) {
  const totalTaxa = session.possibleTaxa.size + session.eliminatedTaxa.size;
  const remaining = session.possibleTaxa.size;
  const progress = totalTaxa ? Math.round(((totalTaxa - remaining) / totalTaxa) * 100) : 0;
  multiElements.summary.innerHTML = `
    <strong>${escapeHtml(keyInfo.title)}</strong><br/>
    ${keyInfo.entities} taxa · ${keyInfo.characters} characters<br/>
    Remaining: ${remaining} (${progress}% filtered)
  `;
}

function renderMultiCharacters(session) {
  const characters = session.getRelevantCharacters();
  multiElements.characters.innerHTML = '';

  characters.forEach(char => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = session.getCharacterDisplayName(char.id);
    if (char.type === 2) {
      button.dataset.type = 'numeric';
    }
    button.addEventListener('click', () => {
      multiState.currentCharacterId = char.id;
      const cached = multiSessions.get(multiState.currentKey);
      if (cached) cached.currentCharacterId = char.id;
      renderMultiStates(session, char.id);
    });
    multiElements.characters.appendChild(button);
  });

  if (characters.length === 0) {
    multiElements.characters.innerHTML = '<p>No more useful characters. Review remaining taxa.</p>';
  }
}

function renderMultiStates(session, characterId) {
  const states = session.getStatesByCharacter(characterId);
  multiElements.states.innerHTML = '';
  const baseCharacter = session.getCharacterById(characterId);
  const characterName = session.getCharacterDisplayName(characterId);
  const statesCard = multiElements.states.closest('.card');

  if (baseCharacter?.type === 2) {
    const selection = session.getSelection(characterId);
    const range = session.getMeasurementRange(characterId);

    const container = document.createElement('div');
    container.className = 'numeric-character';

    if (range) {
      const rangeInfo = document.createElement('p');
      rangeInfo.className = 'numeric-range';
      rangeInfo.textContent = `Observed range: ${formatMeasurement(range.min)} – ${formatMeasurement(range.max)} (${range.count} taxa scored)`;
      container.appendChild(rangeInfo);
    }

    const form = document.createElement('form');
    form.className = 'numeric-form';

    const label = document.createElement('label');
    label.textContent = 'Enter value:';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.placeholder = 'Enter measurement';
    if (selection?.type === 'numeric' && Number.isFinite(selection.value)) {
      input.value = selection.value;
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Apply';

    label.appendChild(input);
    form.append(label, submit);
    container.appendChild(form);

    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = parseFloat(input.value);
      if (!Number.isFinite(value)) {
        setStatus(`Enter a numeric value for ${characterName}.`);
        input.focus();
        return;
      }
      const result = session.applyNumericSelection(characterId, value);
      setStatus(`Selected ${characterName}: ${formatMeasurement(value)}. Eliminated ${result.eliminated} taxa.`);
      renderMultiAll(session);
    });

    multiElements.states.appendChild(container);
    statesCard?.classList.add('active');

    if (range) {
      input.min = String(range.min);
      input.max = String(range.max);
    }

    requestAnimationFrame(() => {
      input.focus({ preventScroll: false });
    });
    return;
  }

  if (!states.length) {
    multiElements.states.innerHTML = '<p>No states to choose for this character.</p>';
    statesCard?.classList.remove('active');
    return;
  }

  states.forEach(state => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.name || `State ${state.id}`;
    button.addEventListener('click', () => {
      const result = session.chooseState(characterId, state.id);
      setStatus(`Selected ${characterName}: ${state.name || state.id}. Eliminated ${result.eliminated} taxa.`);
      renderMultiAll(session);
    });
    multiElements.states.appendChild(button);
  });

  statesCard?.classList.add('active');

  requestAnimationFrame(() => {
    const topOffset = statesCard?.getBoundingClientRect().top ?? 0;
    if (Math.abs(topOffset) > 20) {
      statesCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const firstButton = multiElements.states.querySelector('button');
    if (firstButton) {
      firstButton.focus({ preventScroll: true });
    }
  });
}

function renderMultiSelections(session) {
  const selections = session.selections();
  multiElements.selections.innerHTML = '';
  if (!selections.length) {
    multiElements.selections.innerHTML = '<li>No selections yet.</li>';
    return;
  }
  selections.forEach(selection => {
    const li = document.createElement('li');
    if (selection.type === 'numeric') {
      li.textContent = `${selection.characterName}: ${formatMeasurement(selection.value)}`;
    } else {
      li.textContent = `${selection.characterName}: ${selection.stateName}`;
    }
    multiElements.selections.appendChild(li);
  });
}

function renderMultiRemaining(session) {
  const { total, sample } = session.remainingTaxa();
  multiElements.remaining.innerHTML = '';

  const summary = document.createElement('p');
  const count = document.createElement('strong');
  count.textContent = String(total);
  summary.append(count, ' taxa remaining.');
  multiElements.remaining.appendChild(summary);

  if (!sample.length) {
    return;
  }

  const list = document.createElement('ol');
  sample.forEach(taxon => {
    const item = document.createElement('li');
    const taxonId = taxon.taxonId;
    if (taxonId && taxonIndex.has(taxonId)) {
      const link = document.createElement('a');
      link.className = 'link scientific_name';
      link.href = formatRoute({ view: 'taxon', taxonId });
      link.textContent = taxon.name;
      item.appendChild(link);
    } else if (taxonId) {
      const link = document.createElement('a');
      link.href = taxon.url || taxonUrlFromId(taxonId);
      link.textContent = taxon.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.appendChild(link);
    } else if (taxon.url) {
      const link = document.createElement('a');
      link.href = taxon.url;
      link.textContent = taxon.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.appendChild(link);
    } else {
      item.textContent = taxon.name;
    }
    list.appendChild(item);
  });
  multiElements.remaining.appendChild(list);
}

function renderMultiAll(session) {
  if (!session || !multiState.currentKey) return;
  renderMultiSummary(session, multiState.currentKeyInfo);
  renderMultiCharacters(session);
  if (multiState.currentCharacterId) {
    renderMultiStates(session, multiState.currentCharacterId);
  }
  if (!multiState.currentCharacterId) {
    multiElements.states.closest('.card')?.classList.remove('active');
  }
  renderMultiSelections(session);
  renderMultiRemaining(session);
}

function bindMultiControls() {
  if (multiControlsBound) return;
  multiControlsBound = true;

  multiElements.select.addEventListener('change', event => {
    const id = event.target.value;
    if (!id) return;
    navigateTo({ view: 'multi', keyId: id });
  });

  multiElements.reset.addEventListener('click', () => {
    if (!multiSession) return;
    multiSession.reset();
    multiState.currentCharacterId = null;
    const cached = multiSessions.get(multiState.currentKey);
    if (cached) cached.currentCharacterId = null;
    renderMultiAll(multiSession);
  });

  multiElements.undo.addEventListener('click', () => {
    if (!multiSession) return;
    const undone = multiSession.undoLastSelection?.();
    if (!undone) {
      setStatus('No selections to undo.');
      return;
    }
    multiState.currentCharacterId = undone.characterId;
    const cached = multiSessions.get(multiState.currentKey);
    if (cached) cached.currentCharacterId = undone.characterId;

    const characterName = multiSession.getCharacterDisplayName
      ? multiSession.getCharacterDisplayName(undone.characterId)
      : (multiSession.getCharacterById?.(undone.characterId)?.name || undone.characterId);

    let removedLabel;
    if (undone.selection?.type === 'numeric') {
      removedLabel = formatMeasurement(undone.selection.value);
    } else {
      const state = multiSession.getStatesByCharacter(undone.characterId).find(s => s.id === undone.selection?.value);
      removedLabel = state?.name || undone.selection?.value;
    }

    renderMultiAll(multiSession);
    setStatus(`Removed ${characterName}: ${removedLabel}.`);
  });
}

// ---------------------------------------------------------------------------
// Descriptions, photos, bioregions & taxon profile view
// ---------------------------------------------------------------------------

const INFRASPECIFIC_RANK_LABELS = {
  SUBSPECIES: 'subspecies',
  VARIETY: 'variety',
  FORM: 'form'
};

function extractNotesHtml(html) {
  if (!html) return '';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return Array.from(wrapper.querySelectorAll('.notes'))
    .map(node => node.innerHTML)
    .join('');
}

const photoLightboxEl = document.querySelector('#photo-lightbox');
const lightboxState = {
  items: [],
  index: 0,
  displayName: '',
  returnFocusEl: null
};

function mediaKindLabel(kind) {
  return kind === 'drawing' ? 'Illustration' : 'Photo';
}

function fitLightboxImage() {
  if (!photoLightboxEl || photoLightboxEl.hidden) return;
  const stage = photoLightboxEl.querySelector('.photo-lightbox-stage');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  if (!stage || !img || !img.naturalWidth || !img.naturalHeight) return;

  const style = window.getComputedStyle(stage);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const availW = Math.max(1, stage.clientWidth - padX);
  const availH = Math.max(1, stage.clientHeight - padY);

  const scale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
  img.style.width = `${Math.max(1, Math.floor(img.naturalWidth * scale))}px`;
  img.style.height = `${Math.max(1, Math.floor(img.naturalHeight * scale))}px`;
}

function renderLightboxItem() {
  if (!photoLightboxEl || !lightboxState.items.length) return;
  const item = lightboxState.items[lightboxState.index];
  if (!item) return;

  const speciesEl = photoLightboxEl.querySelector('.photo-lightbox-species');
  const switchEl = photoLightboxEl.querySelector('.photo-lightbox-switch');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  const captionEl = photoLightboxEl.querySelector('.photo-lightbox-caption');
  const creditEl = photoLightboxEl.querySelector('.photo-lightbox-credit');

  const label = mediaKindLabel(item.kind);
  speciesEl.textContent = lightboxState.displayName || '';

  if (lightboxState.items.length > 1) {
    switchEl.hidden = false;
    switchEl.innerHTML = '';
    lightboxState.items.forEach((entry, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = mediaKindLabel(entry.kind);
      btn.className = idx === lightboxState.index ? 'active' : '';
      btn.setAttribute('aria-pressed', idx === lightboxState.index ? 'true' : 'false');
      btn.addEventListener('click', event => {
        event.stopPropagation();
        if (lightboxState.index !== idx) {
          lightboxState.index = idx;
          renderLightboxItem();
        }
      });
      switchEl.append(btn);
    });
  } else {
    switchEl.hidden = true;
    switchEl.innerHTML = '';
  }

  img.classList.remove('is-loaded');
  img.style.width = '';
  img.style.height = '';
  img.classList.toggle('is-drawing', item.kind === 'drawing');
  img.alt = `${lightboxState.displayName || 'Species'} ${label.toLowerCase()}`;
  img.src = item.src;

  if (item.caption) {
    captionEl.textContent = item.caption;
    captionEl.hidden = false;
  } else {
    captionEl.textContent = '';
    captionEl.hidden = true;
  }
  creditEl.textContent = `${label}: ${item.attribution}`;

  if (img.complete && img.naturalWidth) {
    img.classList.add('is-loaded');
    requestAnimationFrame(fitLightboxImage);
  }
}

function openPhotoLightbox(items, startIndex, displayName, triggerEl) {
  if (!photoLightboxEl || !items.length) return;
  hideGlossaryTerm();
  lightboxState.items = items;
  lightboxState.index = Math.max(0, Math.min(startIndex, items.length - 1));
  lightboxState.displayName = displayName || '';
  lightboxState.returnFocusEl = triggerEl || document.activeElement;

  photoLightboxEl.hidden = false;
  document.body.classList.add('lightbox-open');
  renderLightboxItem();
  photoLightboxEl.querySelector('.photo-lightbox-close')?.focus();
}

function closePhotoLightbox() {
  if (!photoLightboxEl || photoLightboxEl.hidden) return;
  photoLightboxEl.hidden = true;
  document.body.classList.remove('lightbox-open');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  if (img) {
    img.removeAttribute('src');
    img.style.width = '';
    img.style.height = '';
  }
  const focusTarget = lightboxState.returnFocusEl;
  lightboxState.items = [];
  lightboxState.returnFocusEl = null;
  if (focusTarget && focusTarget.isConnected && typeof focusTarget.focus === 'function') {
    focusTarget.focus();
  }
}

function initPhotoLightbox() {
  if (!photoLightboxEl) return;
  const closeBtn = photoLightboxEl.querySelector('.photo-lightbox-close');
  const stage = photoLightboxEl.querySelector('.photo-lightbox-stage');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');

  closeBtn?.addEventListener('click', closePhotoLightbox);
  stage?.addEventListener('click', closePhotoLightbox);
  img?.addEventListener('load', () => {
    img.classList.add('is-loaded');
    fitLightboxImage();
  });

  window.addEventListener('resize', fitLightboxImage);
  document.addEventListener('keydown', event => {
    if (photoLightboxEl.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePhotoLightbox();
    } else if (event.key === 'ArrowRight' && lightboxState.items.length > 1) {
      event.preventDefault();
      lightboxState.index = (lightboxState.index + 1) % lightboxState.items.length;
      renderLightboxItem();
    } else if (event.key === 'ArrowLeft' && lightboxState.items.length > 1) {
      event.preventDefault();
      lightboxState.index = (lightboxState.index - 1 + lightboxState.items.length) % lightboxState.items.length;
      renderLightboxItem();
    }
  });
}

function createPhotoFigure(source, displayName, onOpenFullscreen) {
  if (!source) return null;
  const label = mediaKindLabel(source.kind);
  const figure = document.createElement('figure');
  figure.className = source.kind === 'drawing' ? 'taxon-photo taxon-photo--drawing' : 'taxon-photo';
  figure.dataset.photoKey = source.key || '';
  figure.dataset.photoShard = source.shard != null ? String(source.shard) : '';
  figure.dataset.photoKind = source.kind || 'photo';
  figure.dataset.photoOffline = source.offline ? 'true' : 'false';

  if (source.deferred) {
    if (source.constrained && source.onlineUrl && navigator.onLine !== false) {
      const note = document.createElement('p');
      note.className = 'taxon-photo-offline-note';
      note.innerHTML = `${label} paused on low-data connection. <button type="button" class="link" data-load-remote-photo="true">Load</button>`;
      figure.append(note);
      return figure;
    }
    const note = document.createElement('p');
    note.className = 'taxon-photo-offline-note';
    note.textContent = `${label} available once synced offline.`;
    figure.append(note);
    return figure;
  }

  if (!source.src) return null;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'taxon-photo-trigger';
  trigger.setAttribute('aria-label', `View ${displayName || 'species'} ${label.toLowerCase()} full screen`);

  const img = document.createElement('img');
  img.src = source.src;
  img.alt = `${displayName || 'Species'} ${label.toLowerCase()}`;
  img.loading = 'lazy';
  img.decoding = 'async';

  const markLoaded = () => {
    figure.classList.remove('is-loading');
    figure.classList.add('is-loaded');
  };
  if (img.complete && img.naturalWidth > 0) {
    markLoaded();
  } else {
    figure.classList.add('is-loading');
    img.addEventListener('load', markLoaded, { once: true });
  }

  trigger.append(img);
  trigger.addEventListener('click', () => onOpenFullscreen(source, trigger));

  const caption = document.createElement('figcaption');
  caption.className = 'taxon-photo-credit';
  caption.textContent = `${label}: ${source.attribution}`;

  img.addEventListener('error', () => {
    source.failed = true;
    figure.classList.remove('is-loading');
    if (!source.offline) {
      const msg = navigator.onLine === false ? `${label} unavailable offline.` : `Could not load ${label.toLowerCase()}.`;
      figure.innerHTML = `<p class="taxon-photo-offline-note">${msg}</p>`;
    } else {
      figure.remove();
    }
  });

  figure.append(trigger);
  if (source.caption) {
    const legend = document.createElement('p');
    legend.className = 'taxon-photo-caption';
    legend.textContent = source.caption;
    figure.append(legend);
  }
  figure.append(caption);
  return figure;
}

async function resolveTaxonMedia(primaryId, fallbackId, options) {
  let sources = await photoStore.getMediaSources(primaryId, options).catch(() => []);
  if (!sources.length && fallbackId) {
    sources = await photoStore.getMediaSources(fallbackId, options).catch(() => []);
  }
  return sources;
}

function createMediaGallery(sources, displayName) {
  const wrapper = document.createElement('div');
  wrapper.className = sources.length > 1 ? 'taxon-media taxon-media--pair' : 'taxon-media';

  const openFromGallery = (clickedSource, triggerEl) => {
    const viewable = sources.filter(s => s.src && !s.deferred && !s.failed);
    const idx = Math.max(0, viewable.findIndex(s => s.key === clickedSource.key && s.kind === clickedSource.kind));
    openPhotoLightbox(viewable, idx, displayName, triggerEl);
  };

  for (const source of sources) {
    const figure = createPhotoFigure(source, displayName, openFromGallery);
    if (figure) wrapper.append(figure);
  }
  return wrapper.childElementCount ? wrapper : null;
}

async function attachTaxonPhoto(container, token, { allowRemote = true, forceRemote = false } = {}) {
  const primaryId = container.dataset.photoPrimaryId;
  const fallbackId = container.dataset.photoFallbackId || null;
  const displayName = container.dataset.photoDisplayName || 'Species photo';
  if (!primaryId) return;

  const sources = await resolveTaxonMedia(primaryId, fallbackId, { allowRemote, forceRemote });
  if (!container.isConnected || container.dataset.renderToken !== token) return;

  const existing = container.querySelector('.taxon-media');
  if (!sources.length) {
    container.dataset.photoState = photoStore.index ? 'none' : 'pending';
    return;
  }

  const allOffline = sources.every(s => s.offline);
  const anyDeferred = sources.some(s => s.deferred);
  container.dataset.photoState = allOffline ? 'offline' : (anyDeferred ? 'deferred' : 'remote');

  // Don't replace an already-rendered offline gallery with the exact same keys.
  if (existing) {
    const existingFigs = Array.from(existing.querySelectorAll('.taxon-photo'));
    const sameOffline =
      existingFigs.length === sources.length &&
      existingFigs.every(
        (fig, i) => fig.dataset.photoOffline === 'true' && fig.dataset.photoKey === (sources[i].key || '')
      );
    if (sameOffline) return;
  }

  const gallery = createMediaGallery(sources, displayName);
  if (!gallery) return;

  if (existing) {
    existing.replaceWith(gallery);
  } else {
    // Only replace the "No description bundled" placeholder when an actual image is rendered.
    const hasRenderedImage = sources.some(s => s.src && !s.deferred);
    const placeholderOnly =
      hasRenderedImage &&
      container.children.length === 1 &&
      container.firstElementChild?.classList.contains('muted');
    if (placeholderOnly) container.innerHTML = '';
    const vernEl = container.querySelector('.vernacular');
    if (vernEl) vernEl.after(gallery);
    else container.prepend(gallery);
  }
}

async function attachBioregionMap(container, taxonBioregions, token) {
  if (!container) return;
  const distEl = container.querySelector('.distribution-habitat');
  const hasProseRegions = Boolean(distEl?.querySelector('.region'));
  if (!taxonBioregions && !hasProseRegions) return;

  const data = await ensureBioregionsLoaded(() => dataStore.readResponse('bioregions'));
  if (!data || !container.isConnected || container.dataset.renderToken !== token) return;
  if (container.querySelector('.bioregion-map-card')) return;

  const mapCard = createBioregionMap(data, taxonBioregions, { proseContainer: distEl });
  if (!mapCard) return;

  if (distEl) {
    distEl.classList.add('has-bioregion-map');
    distEl.replaceChildren(mapCard);
  } else {
    const placeholderOnly =
      container.children.length === 1 &&
      container.firstElementChild?.classList.contains('muted');
    if (placeholderOnly) container.innerHTML = '';

    const section = document.createElement('div');
    section.className = 'distribution-habitat has-bioregion-map';
    section.append(mapCard);

    const infraEl = container.querySelector('.infraspecific-taxa');
    if (infraEl) infraEl.before(section);
    else container.append(section);
  }
}

async function fillDescription(container, taxonId) {
  if (!container || !taxonId) return;
  const token = String(++descriptionRenderSeq);
  container.dataset.renderToken = token;

  await ensureDescriptionsLoaded();
  if (!container.isConnected || container.dataset.renderToken !== token) return;

  const entry = taxonIndex.get(taxonId);
  const taxon = descriptions[taxonId];
  const soleChild = findSoleInfraspecificProfile(taxonIndex, taxonId, descriptions);
  const primaryPhotoId = soleChild ? soleChild.entry.id : taxonId;
  const fallbackPhotoId = soleChild ? taxonId : '';
  const displayName = soleChild
    ? soleChild.entry.name
    : (entry?.name || 'Species photo');

  container.dataset.photoPrimaryId = primaryPhotoId;
  container.dataset.photoFallbackId = fallbackPhotoId;
  container.dataset.photoDisplayName = displayName;

  if (soleChild) {
    const vernacular = entry?.vernacular || soleChild.entry.vernacular;
    const rankLabel = INFRASPECIFIC_RANK_LABELS[soleChild.entry.rank] || 'infraspecific taxon';
    const parentNotes = extractNotesHtml(taxon?.html);
    const childHref = formatRoute({ view: 'taxon', taxonId: soleChild.entry.id });
    container.innerHTML = `
      ${vernacular ? `<p class="vernacular">${escapeHtml(vernacular)}</p>` : ''}
      <p class="sole-infraspecific-note">Only 1 ${rankLabel} in Victoria — showing <a class="link scientific_name" href="${escapeHtml(childHref)}">${escapeHtml(soleChild.entry.name)}</a></p>
      ${soleChild.taxon.html}
      ${parentNotes ? `<div class="species-notes">${parentNotes}</div>` : ''}
    `;
    for (const link of container.querySelectorAll('a[data-taxon]')) {
      if (!taxonIndex.has(link.dataset.taxon)) {
        link.removeAttribute('data-taxon');
      } else {
        link.setAttribute('href', formatRoute({ view: 'taxon', taxonId: link.dataset.taxon }));
      }
    }
    annotateGlossary(container);
    attachBioregionMap(container, soleChild.taxon.bioregions || taxon?.bioregions || null, token);
    attachTaxonPhoto(container, token);
    return;
  }

  const children = findInfraspecificTaxa(taxonIndex, taxonId);
  const vernacular = entry?.vernacular;
  if (taxon?.html || children.length) {
    container.innerHTML = taxon?.html
      ? `
        ${vernacular ? `<p class="vernacular">${escapeHtml(vernacular)}</p>` : ''}
        ${taxon.html}
      `
      : (vernacular ? `<p class="vernacular">${escapeHtml(vernacular)}</p>` : '');
    for (const link of container.querySelectorAll('a[data-taxon]')) {
      if (!taxonIndex.has(link.dataset.taxon)) {
        link.removeAttribute('data-taxon');
      } else {
        link.setAttribute('href', formatRoute({ view: 'taxon', taxonId: link.dataset.taxon }));
      }
    }
    annotateGlossary(container);
    if (children.length) {
      const section = document.createElement('div');
      section.className = 'infraspecific-taxa';
      const list = document.createElement('ul');
      list.className = 'key-links';
      list.innerHTML = children
        .map(child => {
          const href = formatRoute({ view: 'taxon', taxonId: child.id });
          return `<li><a class="link scientific_name" href="${escapeHtml(href)}">${escapeHtml(child.name)}</a></li>`;
        })
        .join('');
      section.appendChild(list);
      container.appendChild(section);
    }
  } else {
    container.innerHTML = '<p class="muted">No description bundled for this taxon.</p>';
  }

  attachBioregionMap(container, taxon?.bioregions || null, token);
  attachTaxonPhoto(container, token);
}

function getKeyTitle(keyId) {
  const id = String(keyId);
  return dichKeyMetaById.get(id)?.title || globalDichKeys[id]?.title || `Key ${id}`;
}

async function renderTaxonRoute(route, seq) {
  const taxonId = route.taxonId;
  refreshPhotoStatus();

  if (!taxonIndex.size && !appBooted) {
    speciesElements.detail.innerHTML = '<p class="muted">Loading taxon profile…</p>';
    await bootData().catch(() => {});
    if (seq !== routeRenderSeq) return;
  }

  const entry = taxonIndex.get(taxonId);
  if (!entry) {
    currentSpeciesId = null;
    if (speciesElements.rankBadge) speciesElements.rankBadge.textContent = 'Taxon';
    speciesElements.detail.innerHTML = `
      <h3>Taxon not found</h3>
      <p class="muted">No bundled taxon matches <code>${escapeHtml(taxonId)}</code>.</p>
      <p><a href="#/">Return home</a> or search above.</p>
    `;
    return;
  }

  currentSpeciesId = taxonId;
  if (speciesElements.rankBadge) {
    speciesElements.rankBadge.textContent = formatRankBadge(entry.rank);
  }
  const detail = speciesElements.detail;

  const keyLinks = (entry.keys || [])
    .map(keyId => {
      const href = formatRoute({ view: 'key', keyId: String(keyId) });
      return `<li><a class="link" href="${escapeHtml(href)}">${escapeHtml(getKeyTitle(keyId))}</a></li>`;
    })
    .join('');

  const ownKey = entry.toKey
    ? `<p><a class="btn-link btn-secondary" href="${escapeHtml(formatRoute({ view: 'key', keyId: String(entry.toKey) }))}">Open key to ${escapeHtml(getKeyTitle(entry.toKey))} →</a></p>`
    : '';
  const appearsIn = keyLinks
    ? `<h4>Appears in</h4><ul class="key-links">${keyLinks}</ul>`
    : '';

  detail.innerHTML = `
    <h3 class="scientific_name">${escapeHtml(entry.name)}</h3>
    <div class="taxon-description">
      ${entry.vernacular ? `<p class="vernacular">${escapeHtml(entry.vernacular)}</p>` : ''}
      <p class="muted">Loading description…</p>
    </div>
    ${ownKey}
    ${appearsIn}
    <p><a href="${escapeHtml(taxonUrlFromId(taxonId))}" target="_blank" rel="noopener">Open VicFlora entry</a></p>
  `;
  fillDescription(detail.querySelector('.taxon-description'), taxonId);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// ---------------------------------------------------------------------------
// Glossary popover
// ---------------------------------------------------------------------------

function annotateGlossary(root) {
  glossary?.annotate(root);
}

const RELATIONSHIP_LABELS = {
  'isOpposedTo': 'Opposite',
  'isRelatedTo(cf.)': 'Compare',
  'hasExactSynonym': 'Synonym',
  'hasPartiallyOverlappingSynonym': 'Similar',
  'hasApproximatelyEqualSynonym': 'Similar',
  'hasVariation': 'Variant',
  'isVariationOf': 'Variant of',
  'hasPlural': 'Plural',
  'isPluralOf': 'Singular',
  'hasAbbreviation': 'Abbreviation',
  'isAbbreviationOf': 'Abbreviation of',
  'hasAdjective': 'Adjective',
  'isAdjectiveOf': 'Noun'
};

function linkifyGlossaryDefinition(container, { mode = 'route' } = {}) {
  if (!container || !glossary) return;
  container.querySelectorAll('a.glossary-link').forEach(link => {
    const text = link.textContent.trim();
    const target = glossary.lookup(text);
    if (!target) {
      link.replaceWith(document.createTextNode(text));
      return;
    }
    if (mode === 'popover') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.dataset.gloss = target.name;
      btn.textContent = text;
      link.replaceWith(btn);
    } else {
      link.className = 'link';
      link.href = formatRoute({ view: 'glossary', term: target.name });
    }
  });
}

async function renderGlossaryRoute(route, seq) {
  if (!glossaryElements.detail) return;
  const requested = route.term || '';

  if (!glossary && !appBooted) {
    glossaryElements.detail.innerHTML = '<p class="muted">Loading glossary…</p>';
    await bootData().catch(() => {});
    if (seq !== routeRenderSeq) return;
  }

  const term = glossary?.lookup(requested);
  if (!term) {
    glossaryElements.detail.innerHTML = `
      <h2>Glossary term not found</h2>
      <p class="muted">No glossary entry matches <code>${escapeHtml(requested)}</code>.</p>
      <p><a href="#/">Return home</a> or search above.</p>
    `;
    return;
  }

  const relatedItems = (term.related || [])
    .filter(([, name]) => name !== term.definedBy)
    .map(([type, name]) => {
      const label = RELATIONSHIP_LABELS[type] || 'See';
      const target = glossary.lookup(name);
      const link = target
        ? `<a class="link" href="${escapeHtml(formatRoute({ view: 'glossary', term: target.name }))}">${escapeHtml(name)}</a>`
        : escapeHtml(name);
      return `<li><span>${label}:</span> ${link}</li>`;
    })
    .join('');

  const variantNote = term.definedBy
    ? `<p class="muted">Variant of <a class="link" href="${escapeHtml(formatRoute({ view: 'glossary', term: term.definedBy }))}"><strong>${escapeHtml(term.definedBy)}</strong></a></p>`
    : '';

  glossaryElements.detail.innerHTML = `
    <h2>${escapeHtml(term.name)}</h2>
    ${variantNote}
    <div class="gloss-definition">${term.definition || '<p class="muted">No definition available.</p>'}</div>
    ${relatedItems ? `<h3>Related terms</h3><ul class="gloss-related">${relatedItems}</ul>` : ''}
  `;
  linkifyGlossaryDefinition(glossaryElements.detail.querySelector('.gloss-definition'), {
    mode: 'route'
  });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showGlossaryTerm(word) {
  const term = glossary?.lookup(word);
  if (!term) return;
  const related = term.related
    .filter(([, name]) => name !== term.definedBy)
    .map(([type, name]) => {
      const label = RELATIONSHIP_LABELS[type] || 'See';
      const link = glossary.lookup(name)
        ? `<button type="button" class="link" data-gloss="${escapeHtml(name)}">${escapeHtml(name)}</button>`
        : escapeHtml(name);
      return `<li><span>${label}:</span> ${link}</li>`;
    })
    .join('');
  glossaryPopover.innerHTML = `
    <button type="button" class="gloss-close" aria-label="Close">×</button>
    <h3>${escapeHtml(term.name)}</h3>
    ${term.definedBy ? `<p class="muted">Variant of <strong>${escapeHtml(term.definedBy)}</strong></p>` : ''}
    <div class="gloss-definition">${term.definition || '<p class="muted">No definition.</p>'}</div>
    ${related ? `<ul class="gloss-related">${related}</ul>` : ''}
  `;
  linkifyGlossaryDefinition(glossaryPopover.querySelector('.gloss-definition'), {
    mode: 'popover'
  });
  glossaryPopover.hidden = false;
}

function hideGlossaryTerm() {
  glossaryPopover.hidden = true;
}

// Capture phase so tapping a term inside a lead button shows the definition
// instead of choosing the lead.
function initGlossary() {
  document.addEventListener(
    'click',
    event => {
      const term = event.target.closest('[data-gloss]');
      if (term) {
        event.preventDefault();
        event.stopPropagation();
        showGlossaryTerm(term.dataset.gloss);
        return;
      }
      if (!glossaryPopover.hidden && (!glossaryPopover.contains(event.target) || event.target.closest('.gloss-close'))) {
        hideGlossaryTerm();
      }
    },
    true
  );
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideGlossaryTerm();
  });
}

function initSpeciesLinks() {
  document.addEventListener('click', event => {
    const taxonLink = event.target.closest('[data-taxon]');
    if (!taxonLink) return;
    const id = taxonLink.dataset.taxon;
    if (id && taxonIndex.has(id)) {
      event.preventDefault();
      navigateTo({ view: 'taxon', taxonId: id });
    } else if (taxonLink.dataset.fallbackUrl) {
      event.preventDefault();
      window.open(taxonLink.dataset.fallbackUrl, '_blank', 'noopener,noreferrer');
    }
  });
}

// ---------------------------------------------------------------------------
// Offline photo storage & manual update check
// ---------------------------------------------------------------------------

function setPhotosControls(html) {
  photoControlsHtml = html || '';
  renderOfflineControls();
}

function renderPhotosStatus() {
  if (!photosStatusEl) return;
  if (photoSyncClearing) {
    photosStatusEl.textContent = 'Removing offline species photos & drawings…';
    setPhotosControls('<button type="button" class="secondary" disabled>Removing…</button>');
    return;
  }
  if (photoStore.isDisabled()) {
    photosStatusEl.textContent =
      'Offline species photos & drawings are off (0 MB stored). Photos still load online when you have a connection.';
    setPhotosControls(
      photoStatus?.supported === false
        ? ''
        : '<button type="button" class="secondary" data-photo-enable-sync="true">Download offline images</button>'
    );
    return;
  }
  if (photoSyncProgress && photoSyncProgress.phase !== 'done') {
    const { loadedBytes, totalBytes } = photoSyncProgress;
    photosStatusEl.textContent = `Syncing offline species photos & drawings (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})…`;
    setPhotosControls(
      '<button type="button" class="danger-subtle" data-photo-drop="true">Stop &amp; drop offline images</button>'
    );
    return;
  }
  if (photoSyncQuotaExceeded) {
    photosStatusEl.textContent = 'Offline species photos paused: not enough free storage on this device.';
    setPhotosControls(
      '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
    return;
  }
  if (photoStatus?.supported !== false && !photoStatus?.synced && isWaitingForCoreOffline()) {
    photosStatusEl.textContent = 'Waiting for offline keys to finish before syncing photos…';
    setPhotosControls(
      '<button type="button" class="secondary" disabled>Sync now</button>' +
        '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
    return;
  }
  if (!photoStatus?.available) {
    if (photoSyncSkippedReason === 'constrained-network' || photoStatus?.constrainedNetwork) {
      photosStatusEl.textContent = 'Offline species photos paused on low-data connection.';
      setPhotosControls(
        '<button type="button" class="secondary" data-photo-force-sync="true">Sync now</button>' +
          '<button type="button" class="danger-subtle" data-photo-drop="true">Don’t store offline images</button>'
      );
      return;
    }
    photosStatusEl.textContent = photoStatus?.supported === false
      ? 'Species photos load online when connected.'
      : 'Offline species photos & drawings have not synced yet.';
    setPhotosControls(
      photoStatus?.supported === false
        ? ''
        : '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
    return;
  }
  const sizeLabel = formatBytes(photoStatus.totalBytes);
  const countLabel = photoStatus.taxaCount.toLocaleString();
  const drawingDetail = photoStatus.drawingsCount
    ? `, ${photoStatus.drawingsCount.toLocaleString()} with drawings`
    : '';
  const mediaLabel = photoStatus.drawingsCount ? 'photos & drawings' : 'photos';
  if (photoStatus.synced) {
    photosStatusEl.textContent = `Offline species ${mediaLabel} ready: ${countLabel} taxa (${sizeLabel}${drawingDetail}) stored separately from app updates.`;
    setPhotosControls(
      '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
  } else if (!photoStatus.supported) {
    photosStatusEl.textContent = `Species ${mediaLabel} (${countLabel} taxa) load online when connected.`;
    setPhotosControls('');
  } else if (photoSyncSkippedReason === 'constrained-network' || photoStatus.constrainedNetwork) {
    photosStatusEl.textContent = `Offline species ${mediaLabel} paused on low-data connection (${photoStatus.matchedShardCount}/${photoStatus.shardCount} packs synced, ${sizeLabel} total).`;
    setPhotosControls(
      '<button type="button" class="secondary" data-photo-force-sync="true">Sync now</button>' +
        '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
  } else {
    const retryNote = photoSyncLastError ? ' Will resume automatically when signal improves.' : '';
    photosStatusEl.textContent = `Offline species ${mediaLabel}: ${photoStatus.matchedShardCount}/${photoStatus.shardCount} packs synced (${sizeLabel} total).${retryNote}`;
    setPhotosControls(
      '<button type="button" class="secondary" data-photo-force-sync="true">Sync now</button>' +
        '<button type="button" class="danger-subtle" data-photo-drop="true">Drop offline images &amp; don’t resync them</button>'
    );
  }
}

async function refreshPhotoStatus() {
  try {
    photoStatus = await photoStore.getStatus();
  } catch (error) {
    console.warn('Could not inspect photo status:', error);
  }
  renderPhotosStatus();
}

function refreshVisiblePhotos(shardIndex = null, { force = false } = {}) {
  const containers = [
    currentRoute.view === 'taxon' ? speciesElements.detail.querySelector('.taxon-description') : null,
    currentRoute.view === 'key' && dichElements.result.classList.contains('visible')
      ? dichElements.result.querySelector('.taxon-description')
      : null
  ].filter(Boolean);

  for (const container of containers) {
    const token = container.dataset.renderToken;
    if (!token || !container.dataset.photoPrimaryId) continue;
    if (!force) {
      if (container.dataset.photoState === 'none' || container.dataset.photoState === 'offline') continue;
      const figs = Array.from(container.querySelectorAll('.taxon-photo'));
      if (figs.length && figs.every(fig => fig.dataset.photoOffline === 'true')) continue;
      if (shardIndex != null && figs.length) {
        const targetShard = String(shardIndex);
        const hasMatchingShard = figs.some(
          fig => fig.dataset.photoOffline !== 'true' && fig.dataset.photoShard === targetShard
        );
        if (!hasMatchingShard) continue;
      }
    }
    attachTaxonPhoto(container, token);
  }
}

function updatePhotoProgressStatus(text) {
  // Never stomp on key errors, incomplete core caching, or user action messages.
  const current = statusEl?.textContent || '';
  if (
    !(statusOwnedByOffline && offlineManager.getState().status === 'ready') &&
    !current.startsWith('Caching offline photos')
  ) {
    return;
  }
  setStatus(text);
}

async function syncPhotosInBackground({ force = false, immediate = false } = {}) {
  if (photoStore.isDisabled()) return { status: 'disabled' };
  if (photoSyncClearing) return { status: 'busy' };
  if (isWaitingForCoreOffline()) {
    renderPhotosStatus();
    return { status: 'waiting-core' };
  }
  if (activePhotoSyncPromise) return activePhotoSyncPromise;
  const now = Date.now();
  if (!force && !immediate && now - lastAutoSyncAttemptAt < 5000) {
    return { status: 'throttled' };
  }
  lastAutoSyncAttemptAt = now;

  const controller = new AbortController();
  activePhotoSyncController = controller;
  const run = (async () => {
    try {
      if (controller.signal.aborted || photoStore.isDisabled()) {
        return { status: 'aborted' };
      }

      photoSyncLastError = null;
      photoSyncSkippedReason = null;

      const result = await photoStore.syncPack({
        force,
        signal: controller.signal,
        onProgress: progress => {
          photoSyncProgress = progress;
          const ts = Date.now();
          if (progress.phase === 'done' || ts - lastStatusUpdateAt >= 500) {
            lastStatusUpdateAt = ts;
            renderPhotosStatus();
            if (updateCheckState.phase === 'checking-photos') {
              renderOfflineCoreStatus();
            }
            if (progress.phase !== 'done') {
              updatePhotoProgressStatus(
                `Caching offline photos (${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)})…`
              );
            }
          }
        },
        onShardComplete: ({ shardIndex }) => {
          refreshVisiblePhotos(shardIndex);
        }
      });

      photoSyncProgress = null;
      photoSyncQuotaExceeded = Boolean(result.quotaExceeded);
      photoSyncSkippedReason = result.skippedReason || null;
      if (result.upToDate || result.synced) {
        lastPhotoCheckAt = Date.now();
      }
      await refreshPhotoStatus();
      if (result.synced) {
        refreshVisiblePhotos();
      }
      if (statusEl?.textContent.startsWith('Caching offline photos')) {
        setOfflineStatus();
      }
      if (result.quotaExceeded) return { status: 'quota' };
      if (result.synced) return { status: 'updated', downloadedBytes: result.downloadedBytes };
      if (result.upToDate) return { status: 'up-to-date' };
      if (result.skippedReason) return { status: 'skipped', reason: result.skippedReason };
      return { status: 'up-to-date' };
    } catch (error) {
      photoSyncProgress = null;
      const aborted = error?.name === 'AbortError' || photoStore.isDisabled();
      if (!aborted) {
        photoSyncLastError = error.message || 'Network interrupted';
        console.warn('Background photo sync paused:', error);
      }
      await refreshPhotoStatus();
      if (statusEl?.textContent.startsWith('Caching offline photos')) {
        setOfflineStatus();
      }
      return aborted
        ? { status: 'aborted' }
        : { status: 'error', error: error.message || 'Network interrupted' };
    } finally {
      if (activePhotoSyncController === controller) {
        activePhotoSyncController = null;
      }
      if (activePhotoSyncPromise === run) {
        activePhotoSyncPromise = null;
      }
    }
  })();
  activePhotoSyncPromise = run;
  return run;
}

async function checkForUpdates() {
  if (activeUpdateCheckPromise) return activeUpdateCheckPromise;

  const run = (async () => {
    if (navigator.onLine === false) {
      updateCheckState = {
        phase: 'done',
        message: 'You’re offline — connect to the internet to check for updates.'
      };
      renderOfflineCoreStatus();
      return;
    }

    updateCheckState = { phase: 'checking', message: null };
    renderOfflineCoreStatus();

    const swResult = await offlineManager.checkForUpdate();

    if (swResult.status === 'updated') {
      updateCheckState = {
        phase: 'done',
        message: 'Update downloaded — reloading…'
      };
      renderOfflineCoreStatus();
      return;
    }

    if (swResult.status === 'offline') {
      updateCheckState = {
        phase: 'done',
        message: 'You’re offline — connect to the internet to check for updates.'
      };
      renderOfflineCoreStatus();
      return;
    }

    if (swResult.status === 'unsupported') {
      updateCheckState = { phase: 'idle', message: null };
      renderOfflineCoreStatus();
      return;
    }

    if (swResult.status === 'error') {
      updateCheckState = {
        phase: 'done',
        message: 'Could not check for app updates — check your connection and try again.'
      };
      renderOfflineCoreStatus();
      return;
    }

    if (photoStore.isDisabled() || photoStatus?.supported === false) {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date.'
      };
      renderOfflineCoreStatus();
      return;
    }

    updateCheckState = { phase: 'checking-photos', message: null };
    renderOfflineCoreStatus();

    const photoResult = await syncPhotosInBackground({ force: true, immediate: true });

    if (photoResult?.status === 'updated') {
      updateCheckState = {
        phase: 'done',
        message: 'Updated offline photos — everything is up to date.'
      };
    } else if (photoResult?.status === 'up-to-date') {
      updateCheckState = {
        phase: 'done',
        message: 'Everything is up to date (keys & photos).'
      };
    } else if (photoResult?.status === 'quota') {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date, but photos could not update (not enough storage).'
      };
    } else if (
      photoResult?.status === 'disabled' ||
      photoResult?.status === 'aborted' ||
      (photoResult?.status === 'skipped' && photoResult.reason === 'unsupported')
    ) {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date.'
      };
    } else if (photoResult?.status === 'skipped' && photoResult.reason === 'locked') {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date. Photos are syncing in another tab.'
      };
    } else if (photoResult?.status === 'skipped' && photoResult.reason === 'offline') {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date, but you went offline before photos could be checked.'
      };
    } else {
      updateCheckState = {
        phase: 'done',
        message: 'App & keys are up to date, but could not check photos — try again later.'
      };
    }
    renderOfflineCoreStatus();
  })();

  activeUpdateCheckPromise = run;
  try {
    return await run;
  } finally {
    if (activeUpdateCheckPromise === run) {
      activeUpdateCheckPromise = null;
    }
  }
}

async function dropOfflinePhotos() {
  if (photoSyncClearing) return;
  photoStore.setDisabled(true);
  photoSyncClearing = true;
  photoSyncQuotaExceeded = false;
  photoSyncLastError = null;
  photoSyncSkippedReason = 'disabled';
  renderPhotosStatus();

  try {
    activePhotoSyncController?.abort();
    if (activePhotoSyncPromise) {
      await activePhotoSyncPromise.catch(() => {});
    }
    await photoStore.clearPack();
  } catch (error) {
    console.warn('Failed to clear offline photo storage:', error);
  } finally {
    photoSyncProgress = null;
    photoSyncClearing = false;
    if (statusEl?.textContent.startsWith('Caching offline photos')) {
      setOfflineStatus();
    }
    await refreshPhotoStatus();
    refreshVisiblePhotos(null, { force: true });
  }
}

async function enableAndSyncOfflinePhotos() {
  if (photoSyncClearing) return;
  photoStore.setDisabled(false);
  photoSyncSkippedReason = null;
  photoSyncQuotaExceeded = false;
  photoSyncLastError = null;
  await refreshPhotoStatus();
  syncPhotosInBackground({ force: true, immediate: true });
}

const PHOTO_UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

function shouldCheckPhotosOnResume() {
  if (!appBooted || photoStore.isDisabled()) return false;
  if (!photoStatus?.synced) return true;
  return Date.now() - lastPhotoCheckAt >= PHOTO_UPDATE_RECHECK_MS;
}

function initPhotos() {
  window.addEventListener('online', () => {
    if (appBooted && !photoStore.isDisabled()) syncPhotosInBackground({ immediate: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && shouldCheckPhotosOnResume()) {
      syncPhotosInBackground();
    }
  });
  window.addEventListener('pageshow', () => {
    if (shouldCheckPhotosOnResume()) {
      syncPhotosInBackground();
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-offline-retry]')) {
      offlineManager.retryNow();
      retryMissingViewData({ retryIfInFlight: true });
      return;
    }
    if (event.target.closest('[data-check-updates]')) {
      checkForUpdates();
      return;
    }
    if (event.target.closest('[data-photo-drop]')) {
      dropOfflinePhotos();
      return;
    }
    if (event.target.closest('[data-photo-enable-sync]')) {
      enableAndSyncOfflinePhotos();
      return;
    }
    if (event.target.closest('[data-photo-force-sync]')) {
      syncPhotosInBackground({ force: true });
      return;
    }
    const loadBtn = event.target.closest('[data-load-remote-photo]');
    if (loadBtn) {
      const container = loadBtn.closest('.taxon-description');
      if (container?.dataset.renderToken) {
        attachTaxonPhoto(container, container.dataset.renderToken, { allowRemote: true, forceRemote: true });
      }
    }
  });
  initPhotoLightbox();
  refreshPhotoStatus();
}

// ---------------------------------------------------------------------------
// Boot & offline recovery
// ---------------------------------------------------------------------------

const bootLoader = createRetryableLoader(async () => {
  await loadCoreData();
  appBooted = true;
  setOfflineStatus();
  syncPhotosInBackground({ immediate: true });
});

function bootData({ retryIfInFlight = false } = {}) {
  return bootLoader.run({ retryIfInFlight }).catch(error => {
    console.error(error);
    const offlineMsg =
      navigator.onLine === false
        ? 'Offline — keys have not finished downloading yet. Reconnect to load automatically.'
        : `Could not load search index (${error.message}).`;
    setStatus(offlineMsg);
    if (homeElements.multiList && !multiKeyMetaList.length) {
      homeElements.multiList.innerHTML =
        `<p>${escapeHtml(offlineMsg)} <button type="button" class="secondary" data-offline-retry="true">Retry</button></p>`;
    }
  });
}

function retryMissingViewData({ retryIfInFlight = false } = {}) {
  if (!appBooted) {
    bootData({ retryIfInFlight });
  }
  if (currentRoute.view === 'key' && !dichLoader.isCompleted()) {
    renderRoute(currentRoute);
  }
  if (currentRoute.view === 'multi' && !multiLoader.isCompleted()) {
    renderRoute(currentRoute);
  }
  if (currentRoute.view === 'taxon' && currentSpeciesId && !descriptionsLoader.isCompleted()) {
    renderRoute(currentRoute);
  }
}

function init() {
  initUnifiedSearch();
  initInstallPrompt();
  initSpeciesLinks();
  initPhotos();
  initGlossary();
  offlineManager.start();
  renderOfflineCoreStatus();

  window.addEventListener('hashchange', () => applyHashChange({ recordHistory: true }));
  window.addEventListener('online', () => {
    retryMissingViewData({ retryIfInFlight: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) {
      retryMissingViewData({ retryIfInFlight: true });
    }
  });

  applyHashChange({ recordHistory: false });
  bootData();
}

init();
