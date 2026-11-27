// Bump this (and .app-version in index.html) whenever app files change so the new set is installed atomically.
const CACHE_NAME = 'vicflora-offline-v20';
// Ordered small-to-large so resumable precaching commits the shell first, then each data bundle.
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './modules/offline.js',
  './modules/dichotomous.js',
  './modules/multiaccess.js',
  './modules/species.js',
  './modules/glossary.js',
  './modules/photos.js',
  './modules/bioregions.js',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './data/bioregions.json',
  './data/glossary.json',
  './data/species-index.json',
  './data/dichotomous-keys.json',
  './data/multi-keys.json',
  './data/descriptions.json'
];

const NON_HTML_EXT_RE = /\.(?:js|mjs|json|css|png|svg|ico|webp)$/i;

function isValidAssetResponse(urlOrPath, response) {
  if (!response || response.status !== 200) return false;
  if (response.redirected) return false;
  if (response.url) {
    try {
      const resolved = new URL(response.url, self.location.href);
      if (resolved.origin !== self.location.origin) return false;
    } catch {
      return false;
    }
  }
  if (NON_HTML_EXT_RE.test(urlOrPath)) {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) return false;
  }
  return true;
}

async function broadcastToClients(message) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage(message);
    }
  } catch {
    // Client messaging is best-effort; never fail SW lifecycle over it.
  }
}

async function precacheAssets() {
  const cache = await caches.open(CACHE_NAME);
  const missing = [];
  let cached = 0;

  // CACHE_NAME is versioned per deploy, so any entry already stored here was
  // validated for this exact version and can be reused on retry.
  for (const asset of ASSETS) {
    const existing = await cache.match(asset);
    if (existing && isValidAssetResponse(asset, existing)) {
      cached += 1;
    } else {
      missing.push(asset);
    }
  }

  await broadcastToClients({
    type: 'sw-cache-progress',
    cached,
    total: ASSETS.length,
    version: CACHE_NAME
  });

  for (const asset of missing) {
    // Revalidate with the server (cheap 304 for files the page just downloaded)
    // rather than bypassing the HTTP cache with 'reload'.
    const response = await fetch(new Request(asset, { cache: 'no-cache' }));
    if (!isValidAssetResponse(asset, response)) {
      throw new Error(`Invalid response while caching ${asset}: HTTP ${response?.status ?? 'unknown'}`);
    }
    await cache.put(asset, response);
    cached += 1;
    await broadcastToClients({
      type: 'sw-cache-progress',
      cached,
      total: ASSETS.length,
      version: CACHE_NAME
    });
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheAssets().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys.map(key => (key === CACHE_NAME ? null : caches.delete(key)))
        )
      )
      .then(() => self.clients.claim())
      .then(() => broadcastToClients({ type: 'sw-cache-ready', version: CACHE_NAME }))
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Photo shards and index are managed independently in IndexedDB by photos.js
  // so app shell updates don't re-download photos, photo updates aren't pinned by
  // CacheStorage, and shards are never stored twice on the device.
  if (url.pathname.includes('/data/photos/')) {
    return;
  }

  // Cache-first for the atomically precached versioned bundle so weak signal
  // never blocks the app and files from different deploys are never mixed.
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached =
        (await cache.match(request)) ||
        (request.mode === 'navigate' ? await cache.match(request, { ignoreSearch: true }) : null);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        if (isValidAssetResponse(url.pathname, response)) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        if (request.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw error;
      }
    })
  );
});
