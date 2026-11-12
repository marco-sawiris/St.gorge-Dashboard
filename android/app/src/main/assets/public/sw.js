// Service Worker for St.Gorge Church Dashboard PWA
// STRICT SECURITY & PRIVACY POLICY:
// 1. Only allow pre-verified static build asset paths relative to repository base.
// 2. Absolutely NO caching for API responses, Google Sheets data, Apps Script, or student records.
// 3. Dynamic subpath extraction for GitHub Pages repository compatibility.
// 4. Scoped cache cleanup: only clean caches created by this specific application prefix.

const APP_CACHE_PREFIX = 'stgorge-app-shell-';
const CURRENT_CACHE_VERSION = 'v7';
const CACHE_NAME = `${APP_CACHE_PREFIX}${CURRENT_CACHE_VERSION}`;

// Dynamically extract repository base path (e.g. '/' or '/st-george-service/')
const getBasePath = () => {
  const swUrl = new URL(self.location.href);
  const pathParts = swUrl.pathname.split('/');
  pathParts.pop(); // Remove sw.js
  const base = pathParts.join('/');
  return base.endsWith('/') ? base : base + '/';
};

const BASE_PATH = getBasePath();

// Exact, explicit static App Shell assets only
const PRECACHE_ALLOWLIST = [
  BASE_PATH,
  BASE_PATH + 'index.html',
  BASE_PATH + 'manifest.json'
];

// 1. Install event: synchronous event.waitUntil() registration
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ALLOWLIST).catch((err) => {
        console.warn('PWA AppShell cache addAll warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate event: synchronous event.waitUntil() registration
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch event: synchronous event.respondWith() registration
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);

  // Same-origin and repository subpath enforcement
  if (requestUrl.origin !== self.location.origin || !requestUrl.pathname.startsWith(BASE_PATH)) {
    return;
  }

  // Absolute exclusion for all API, Google Sheets, Apps Script, auth endpoints, dynamic data, or data files
  if (
    requestUrl.pathname.includes('/api/') ||
    requestUrl.pathname.includes('/auth/') ||
    requestUrl.pathname.includes('macros/s/') ||
    requestUrl.pathname.includes('gviz') ||
    requestUrl.search.includes('sheet=') ||
    (requestUrl.pathname.endsWith('.json') && requestUrl.pathname !== BASE_PATH + 'manifest.json')
  ) {
    return;
  }

  // Strict allowlist for Vite static build chunks and App Shell assets
  const isExactAppShellEntry =
    requestUrl.pathname === BASE_PATH ||
    requestUrl.pathname === BASE_PATH + 'index.html' ||
    requestUrl.pathname === BASE_PATH + 'manifest.json';

  const isViteBuildAsset =
    requestUrl.pathname.startsWith(BASE_PATH + 'assets/') &&
    /\.(?:js|css|woff2?|ttf|png|jpe?g|svg|ico|webp)(?:\?.*)?$/i.test(requestUrl.pathname);

  if (!isExactAppShellEntry && !isViteBuildAsset) {
    return;
  }

  // Synchronously register cache update lifecycle with event.waitUntil()
  let resolveCacheUpdate;
  const cacheUpdatePromise = new Promise((resolve) => {
    resolveCacheUpdate = resolve;
  });
  event.waitUntil(cacheUpdatePromise);

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);

      const networkFetch = fetch(event.request)
        .then(async (networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            try {
              await cache.put(event.request, responseToCache);
            } catch (putErr) {
              console.warn('SW cache.put error:', putErr);
            }
          }
          return networkResponse;
        })
        .catch(async (fetchErr) => {
          if (event.request.mode === 'navigate') {
            const fallback = await cache.match(BASE_PATH + 'index.html');
            if (fallback) return fallback;
          }
          if (cachedResponse) {
            return cachedResponse;
          }
          throw fetchErr;
        })
        .finally(() => {
          resolveCacheUpdate();
        });

      return cachedResponse || networkFetch;
    }).catch(async (openErr) => {
      resolveCacheUpdate();
      if (event.request.mode === 'navigate') {
        const cache = await caches.open(CACHE_NAME);
        const fallback = await cache.match(BASE_PATH + 'index.html');
        if (fallback) return fallback;
      }
      return fetch(event.request);
    })
  );
});
