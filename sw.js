// Service worker: app shell and wllama assets are cached for offline use.
// The model file itself is stored by wllama in OPFS, not here.
const VERSION = 'v6';
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
      await Promise.allSettled(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
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

  const isHeavy = /\.(wasm|png)$/.test(url.pathname);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // big static files: cache first. app shell (html/js/json): network first, so updates apply at once
      if (isHeavy) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
      }
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), isHeavy ? 60000 : 3000);
        const res = await fetch(req, { cache: 'no-cache', signal: ctl.signal });
        clearTimeout(timer);
        if (res && res.ok && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
