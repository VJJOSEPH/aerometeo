/**
 * AeroMeteo Service Worker (sw.js)
 * Provides offline resilience and fast Stale-While-Revalidate caching for
 * static app shell files, CDN libraries, GeoJSON maps, and Open-Meteo APIs.
 */

const CACHE_VERSION = 'aerometeo-v2.4.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Core local app shell assets to precache during install
const APP_SHELL_ASSETS = [
    './',
    './index.html',
    './app.js',
    './data.json',
    './manifest.json'
];

// External APIs and map datasets eligible for runtime Stale-While-Revalidate caching
const RUNTIME_CACHE_HOSTS = [
    'api.open-meteo.com',
    'air-quality-api.open-meteo.com',
    'marine-api.open-meteo.com',
    'raw.githubusercontent.com',
    'cdn.tailwindcss.com',
    'd3js.org',
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

// Install: Precache core application shell and activate immediately
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => cache.addAll(APP_SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate: Clean up outdated cache buckets from previous versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys
                    .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
                    .map((key) => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: Cache-first for app shell; Stale-While-Revalidate for weather & map data
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only intercept GET requests
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // 1. Same-origin app shell & JSON config: Network-first with offline cache fallback
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.ok) {
                        const clone = networkResponse.clone();
                        caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
                    }
                    return networkResponse;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
        );
        return;
    }

    // 2. Open-Meteo APIs, GeoJSON, and CDN scripts: Stale-While-Revalidate for instant speed
    if (RUNTIME_CACHE_HOSTS.some((host) => url.hostname.includes(host))) {
        event.respondWith(
            caches.open(RUNTIME_CACHE).then(async (cache) => {
                const cachedResponse = await cache.match(request);

                const networkFetch = fetch(request)
                    .then((networkResponse) => {
                        if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
                            cache.put(request, networkResponse.clone());
                        }
                        return networkResponse;
                    })
                    .catch(() => cachedResponse);

                // Return cached response immediately if present; otherwise await network
                return cachedResponse || networkFetch;
            })
        );
    }
});

// Allow the web app to trigger immediate SW activation or manual cache purge
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data === 'CLEAR_WEATHER_CACHE') {
        caches.delete(RUNTIME_CACHE);
    }
});