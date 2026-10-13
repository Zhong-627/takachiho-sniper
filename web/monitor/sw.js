const CACHE_PREFIX = 'takachiho-monitor-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v7`;
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

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Malformed push still shows a useful reminder. */ }
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 120) : '高千穗 · 搶位通知';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 400) : '請開啟控制台查看最新進度，並在 Mac 完成確認與付款。';
  event.waitUntil(self.registration.showNotification(title, {
    body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 160) : 'takachiho-reservation',
    data: { url: '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const origin = self.location.origin;
    const existing = clients.find((client) => new URL(client.url).origin === origin);
    if (existing) {
      if ('navigate' in existing) await existing.navigate(`${origin}/`);
      return existing.focus();
    }
    return self.clients.openWindow(`${origin}/`);
  }));
});
