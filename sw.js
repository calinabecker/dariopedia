// Dariopedia service worker: app shell precache + image cache for offline use.
const SHELL = 'dariopedia-shell-v9';
const IMG = 'dariopedia-img';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'voice.js',
  'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('dariopedia-shell-') && k !== SHELL).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Wikimedia images: cache first, then network (and store).
  if (url.hostname === 'upload.wikimedia.org') {
    e.respondWith(caches.open(IMG).then(async c => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req.url, { mode: 'no-cors' });
        c.put(req.url, res.clone()).catch(() => {});
        return res;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // El paquete de datos va a IndexedDB; no duplicarlo en la caché.
  if (url.pathname.includes('/paquete/')) return;

  // App shell: cache first, refresh in background.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || c.match('index.html');
    }));
  }
});
