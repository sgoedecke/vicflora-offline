if (!self.__VICFLORA_MANIFEST__ && typeof importScripts === 'function') {
  importScripts('./data/sw-manifest.js');
}

const MANIFEST = self.__VICFLORA_MANIFEST__ || { shellHash: 'dev', dataHash: 'dev', shell: [], data: [] };
const SHELL_CACHE = `vicflora-shell-${MANIFEST.shellHash}`;
const DATA_CACHE = 'vicflora-data';
const PHOTOS_CACHE = 'vicflora-photos';
const PERSISTENT_CACHES = new Set([DATA_CACHE, PHOTOS_CACHE]);
const SHELL_ASSETS = MANIFEST.shell || [];

const NON_HTML_EXT_RE = /\.(?:js|mjs|json|css|png|svg|ico|webp)$/i;
const MANIFEST_PATHNAME = new URL('./data/manifest.json', self.location.href).pathname;
const PHOTOS_PATH_PREFIX = new URL('./data/photos/', self.location.href).pathname;
const DATA_BY_PATHNAME = new Map(
  (MANIFEST.data || []).map(entry => [new URL(entry.path, self.location.href).pathname, entry])
);

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

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);

  for (const asset of SHELL_ASSETS) {
    const assetUrl = new URL(asset, self.location.href).href;
    const existing = await cache.match(assetUrl);
    if (existing && isValidAssetResponse(asset, existing)) continue;
    const response = await fetch(new Request(assetUrl, { cache: 'no-cache' }));
    if (!isValidAssetResponse(asset, response)) {
      throw new Error(`Invalid response while caching ${asset}: HTTP ${response?.status ?? 'unknown'}`);
    }
    await cache.put(assetUrl, response);
  }
}

async function handleDataFetch(request, entry) {
  const cache = await caches.open(DATA_CACHE);
  const hasQuery = request.url.includes('?');
  const targetUrl = hasQuery ? request.url : new URL(entry.url, self.location.href).href;

  const exact = await cache.match(targetUrl);
  if (exact) return exact;

  try {
    return await fetch(request);
  } catch (error) {
    if (!hasQuery) {
      // Offline mid-update fallback for unversioned data requests.
      const fallback = await cache.match(new URL(entry.path, self.location.href).href, {
        ignoreSearch: true
      });
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys.map(key => (key === SHELL_CACHE || PERSISTENT_CACHES.has(key) ? null : caches.delete(key)))
        )
      )
      .then(() => self.clients.claim())
      .then(() =>
        broadcastToClients({
          type: 'sw-cache-ready',
          shellHash: MANIFEST.shellHash,
          dataHash: MANIFEST.dataHash
        })
      )
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Photo index and shards are managed directly in CacheStorage ('vicflora-photos') by photos.js.
  if (url.pathname.startsWith(PHOTOS_PATH_PREFIX)) {
    return;
  }

  // Serve the active manifest directly from the SW so it is always offline and in sync with the SW.
  if (url.pathname === MANIFEST_PATHNAME) {
    event.respondWith(
      new Response(JSON.stringify(MANIFEST), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      })
    );
    return;
  }

  const dataEntry = DATA_BY_PATHNAME.get(url.pathname);
  if (dataEntry) {
    event.respondWith(handleDataFetch(request, dataEntry));
    return;
  }

  event.respondWith(
    caches.open(SHELL_CACHE).then(async cache => {
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
