// BirdWatchAI Community Feed — Service Worker
// Bumped to v8 to discard caches written by the buggy fallbacks below, which
// could leave a client on a mix of fresh and stale scripts.
const CACHE        = 'bwai-v8';
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
                // ignoreSearch: the cached copy is keyed on the bare URL, but
                // real navigations carry query strings (?feeder=…, ?id=…,
                // ?lifelist=…). Without it, a network hiccup on any of those
                // matched nothing and this resolved to undefined — and
                // respondWith(undefined) is a hard network error, not a miss.
                // Symptom: "FetchEvent … resulted in a network error response"
                // plus SyntaxErrors as scripts come back empty.
                .catch(() => caches.match(e.request, { ignoreSearch: true })
                    .then(hit => hit || Response.error()))
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
                // Never resolve to undefined: respondWith(undefined) is a hard
                // network error, so a script that merely missed the cache came
                // back EMPTY and the page died with
                // "SyntaxError: Unexpected end of input".
                .catch(() => caches.match(e.request)
                    .then(hit => hit || Response.error()))
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
            // No catch here meant any third-party failure — an ad blocker
            // refusing unpkg or Google Fonts, a flaky connection — surfaced as
            // an unhandled rejection inside the worker ("TypeError: Failed to
            // fetch" at this line) and took the whole FetchEvent down with it.
            }).catch(() => Response.error());
        })
    );
});
