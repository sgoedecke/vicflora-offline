// Bump this (and .app-version in index.html) whenever app files change so the new set is installed atomically.
const CACHE_NAME = 'vicflora-offline-v17';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './modules/dichotomous.js',
  './modules/multiaccess.js',
  './modules/species.js',
  './modules/glossary.js',
  './modules/photos.js',
  './manifest.json',
  './favicon.svg',
  './data/dichotomous-keys.json',
  './data/multi-keys.json',
  './data/descriptions.json',
  './data/glossary.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
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
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        if (response.status === 200) {
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
