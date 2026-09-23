// Qube Way — Service Worker (offline support)
// Network-first so new deploys show up immediately; cache is the offline fallback.
const CACHE_NAME = 'qubeway-v2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './game.js',
    './puzzle.js',
    './lib/three.module.min.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response.status === 200 && new URL(event.request.url).origin === self.location.origin) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request).then((cached) =>
                cached || (event.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
});
