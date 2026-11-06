// Service worker: app shell and wllama assets are cached for offline use.
// The model file itself is stored by wllama in OPFS, not here.
const VERSION = 'v2';
const CACHE = `plamo-translate-${VERSION}`;
const CORE = [
  './',
  './index.html',
  './app.js',
  './pfml3.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/wllama/index.js',
  './vendor/wllama/wllama.wasm',
  './vendor/compat/wllama.js',
  './vendor/compat/wllama.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // one failed file must not block the whole install
      await Promise.allSettled(CORE.map((url) => cache.add(url)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('plamo-translate-') && k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // leave cross-origin requests (Hugging Face model download) alone
  if (url.origin !== self.location.origin) return;
  // Range requests are not cached
  if (req.headers.has('range')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
