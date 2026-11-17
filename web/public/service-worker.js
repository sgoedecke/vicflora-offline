// Bump this whenever app files change so the new set is installed atomically.
const CACHE_NAME = 'vicflora-offline-v9';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './modules/dichotomous.js',
  './modules/multiaccess.js',
  './modules/species.js',
  './modules/glossary.js',
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
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => (key === CACHE_NAME ? null : caches.delete(key)))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Stale-while-revalidate: serve from cache immediately (so weak signal never
  // blocks the app) and refresh the cache in the background for next time.
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      const network = fetch(request).then(response => {
        if (response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      });

      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }

      try {
        return await network;
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
