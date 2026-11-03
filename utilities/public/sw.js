// Keeps the app shell on the phone so meter readers can open it with no signal.
// API calls are never cached: bills and balances must always come fresh from the server.
const CACHE = 'utilities-shell-v6';
const SHELL = ['/', '/assets/app.css', '/assets/js/main.js', '/assets/js/api.js', '/assets/js/dom.js',
  '/assets/js/views/signin.js', '/assets/js/views/resident.js', '/assets/js/views/reader.js', '/assets/js/views/staff.js', '/assets/js/views/security.js', '/assets/js/webauthn.js', '/favicon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/webhooks/')) return;
  // Network first so updates arrive; fall back to the saved copy when offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (u.pathname.startsWith('/assets/') || SHELL.includes(u.pathname))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});
