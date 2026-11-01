// Prosty service worker: aplikacja otwiera się także bez internetu (dane z ostatniego wczytania).
const CACHE = 'obiady-v15';
const SHELL = ['./', 'index.html', 'app.js', 'theme.js', 'logic.js', 'receipt.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // dane z Supabase zawsze z sieci
  // cache: 'no-cache' – zawsze pytamy serwer o nowszą wersję (GitHub Pages trzyma pliki w pamięci podręcznej 10 minut)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
