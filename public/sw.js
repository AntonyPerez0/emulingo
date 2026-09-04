const CACHE = 'emulingo-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  const cacheable = url.startsWith(self.location.origin) ||
    url.includes('tessdata') ||
    url.includes('emulatorjs.org') ||
    url.includes('jsdelivr.net') ||
    url.includes('gstatic.com');
  if (!cacheable) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const hit = await cache.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
