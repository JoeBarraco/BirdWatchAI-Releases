// BirdWatchAI Community Feed — Service Worker
const CACHE        = 'bwai-v7';
const FEED_CACHE   = 'bwai-feed-v1';   // separate cache for API responses
const PRECACHE = [
    'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600;700&family=Source+Sans+3:wght@400;500;600&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE && k !== FEED_CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = e.request.url;

    // HTML: always network-first, fall back to cache for offline
    if (e.request.mode === 'navigate' || url.endsWith('.html')) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    // Cache a copy of the HTML for offline use
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Same-origin JS/CSS: network-first so deploys are picked up without
    // needing a cache version bump. Falls back to the cached copy when
    // offline. (Cache-first here is what stranded users on old JS that
    // didn't know about new HTML elements like the Feeders tab.)
    if (e.request.method === 'GET' &&
        new URL(url).origin === self.location.origin &&
        (url.endsWith('.js') || url.endsWith('.css'))) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE).then(c => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Supabase community_detections: network-first, cache last response for offline
    if (url.includes('supabase.co') && url.includes('community_detections')) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    const clone = res.clone();
                    caches.open(FEED_CACHE).then(c => c.put(e.request, clone));
                    return res;
                })
                .catch(() =>
                    caches.match(e.request, { cacheName: FEED_CACHE })
                        .then(cached => cached || new Response(JSON.stringify([]), {
                            headers: { 'Content-Type': 'application/json' }
                        }))
                )
        );
        return;
    }

    // Other Supabase / geocoding: network-first, empty fallback
    if (url.includes('supabase.co') || url.includes('zippopotam') || url.includes('nominatim')) {
        e.respondWith(
            fetch(e.request).catch(() => new Response(JSON.stringify([]), {
                headers: { 'Content-Type': 'application/json' }
            }))
        );
        return;
    }

    // Static third-party assets (fonts, Leaflet from unpkg): cache-first.
    // These are version-pinned in the URL so cache-first is safe.
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res.ok && e.request.method === 'GET') {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
