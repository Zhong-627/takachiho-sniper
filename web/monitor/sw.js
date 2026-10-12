const CACHE_PREFIX = 'takachiho-monitor-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const SHELL_ASSETS = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];
const shellPaths = new Set(SHELL_ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Private API responses, SSE, POST bodies, and credentials are never cached.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!shellPaths.has(url.pathname) || url.search) return;
  event.respondWith(fetch(request).then(async (response) => {
    // A tunnel can return an empty 502/503 while the local service is restarting.
    // HTTP errors do not reject fetch, so keep the usable shell on screen.
    if (response.status >= 500) {
      const cached = await caches.match(request);
      if (cached) return cached;
    }
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    return Response.error();
  }));
});
