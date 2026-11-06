// Ledger's app shell, so the installed app opens with weak signal: the page,
// its scripts and styles, the brand and the icons. Network first: the cache
// answers only when the network fails. Nothing under /api/ is ever cached,
// so no figure or entry sits on the device. The version comes in the
// registration address (/sw.js?v=...), so a new release keeps a new cache
// and drops the old one. Registered from app.js.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `tss-ledger-shell-${VERSION}`;
const SHELL = ['/', '/app.js', '/util.js', '/importer.js', '/pile.js', '/styles.css', '/tss-theme.js', '/tss-nav.js', '/tss-nav.css', '/manifest.webmanifest',
  '/brand/ledger.png', '/brand/tss-wordmark.webp', '/brand/tss-wordmark-light.webp', '/brand/wally.webp', '/brand/wally-ledger.svg', '/brand/rook-e-robot.webp', '/brand/splash.js', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

function shouldCache(url) {
  let u; try { u = new URL(url, self.location.origin); } catch { return false; }
  if (u.origin !== self.location.origin || u.pathname.startsWith('/api/') || u.pathname === '/sw.js') return false;
  return SHELL.includes(u.pathname);
}
// A page load (any address: Ledger is one page) gets the index; a shell file gets itself.
function fallbackKey(request) {
  if (request.mode === 'navigate') return new URL(request.url).pathname.startsWith('/api/') ? null : '/';
  return shouldCache(request.url) ? new URL(request.url).pathname : null;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tss-ledger-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const key = fallbackKey(req);
  if (!key) return;
  e.respondWith(fetch(req).catch(async () => (await (await caches.open(CACHE)).match(key)) || Response.error()));
});

// The rules above, for the tests (test/offline.test.mjs), which run this file without a browser.
self.shellRules = { VERSION, CACHE, SHELL, shouldCache, fallbackKey };
