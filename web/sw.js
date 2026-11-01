// Service worker: aplikacja otwiera się także bez internetu (dane z ostatniego wczytania są w IndexedDB).
// Klucz domu z adresu (?dom=…) nie trafia do serwera strony: przy otwieraniu aplikacji pobieramy ją bez parametrów,
// a w pamięci podręcznej zapisujemy tylko poprawne odpowiedzi.
const CACHE = 'obiady-v21';
const SHELL = ['./', 'app.js', 'dane.js', 'theme.js', 'logic.js', 'receipt.js', 'config.js', 'manifest.webmanifest',
  'vendor/supabase/supabase.mjs', 'vendor/fonts/PlusJakartaSans.woff2', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
const SCOPE = new URL('./', self.location).pathname;

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

const save = (key, r) => { if (r.ok && (r.type === 'basic' || r.type === 'default')) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; };
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return; // Supabase zawsze z sieci
  if (req.mode === 'navigate' && (u.pathname === SCOPE || u.pathname === SCOPE + 'index.html')) {
    // strona aplikacji: zawsze ta sama, bez ?dom=… (GitHub Pages trzyma pliki 10 minut, więc „no-cache”)
    e.respondWith(fetch(SCOPE, { cache: 'no-cache' })
      .then(r => save(SCOPE, r.redirected ? new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers }) : r))
      .catch(() => caches.match(SCOPE).then(r => r || Response.error())));
    return;
  }
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(r => save(req, r))
    .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || Response.error())));
});
