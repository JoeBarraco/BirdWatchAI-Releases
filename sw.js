// BirdWatchAI Landing Page — Service Worker
//
// Bumped to v5 to discard entries written by the previous worker, whose
// revalidation never completed (see the JS/CSS handler below) — a client could
// otherwise sit on a cache no deploy would ever displace.
//
// The hardening in docs/sw.js applies here too and had not been carried over:
// every `caches.match()` fallback must be guarded against resolving to
// undefined, because respondWith(undefined) is a hard network error rather than
// a cache miss, and every fire-and-forget fetch needs a catch or it takes the
// whole FetchEvent down with it.
const CACHE   = 'bwai-landing-v5';
const PRECACHE = [
    'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Source+Sans+3:wght@300;400;500;600;700&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = e.request.url;

    // HTML: network-first, fall back to cache for offline
    if (e.request.mode === 'navigate' || url.endsWith('.html')) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    if (res.ok) {
                        const clone = res.clone();
                        e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {}));
                    }
                    return res;
                })
                // ignoreSearch: the cached copy is keyed on the bare URL, but
                // real navigations carry query strings — ?unsubscribed=1 from
                // the unsubscribe redirect, and whatever marketing params a
                // campaign link brings. Without it, a network hiccup on any of
                // those matched nothing and this resolved to undefined, and
                // respondWith(undefined) is a hard network error, not a miss.
                .catch(() => caches.match(e.request, { ignoreSearch: true })
                    .then(hit => hit || Response.error()))
        );
        return;
    }

    // Supabase / external API: network-only
    if (url.includes('supabase.co') || url.includes('zippopotam') || url.includes('nominatim')) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Same-origin JS/CSS: stale-while-revalidate. Safe for this page because
    // index.html requests its own assets with a version query
    // (js/main.js?v=…, css/style.css?v=…), so a deploy that bumps ?v= is a
    // fresh cache key and misses straight through to the network. The
    // revalidation below is what keeps un-bumped assets from going stale
    // forever.
    const sameOrigin = new URL(url).origin === self.location.origin;
    const isScriptOrStyle = /\.(?:js|css)(?:\?|$)/.test(url);
    if (e.request.method === 'GET' && sameOrigin && isScriptOrStyle) {
        e.respondWith(
            caches.open(CACHE).then(cache =>
                cache.match(e.request).then(cached => {
                    const network = fetch(e.request).then(res => {
                        if (!res.ok) return res;
                        return cache.put(e.request, res.clone()).then(() => res);
                    });
                    if (cached) {
                        // The revalidate half has to be kept alive explicitly.
                        // Returning `cached` settles respondWith immediately,
                        // and the worker is eligible for termination as soon as
                        // it does — so the previous `return cached || network`
                        // dropped the in-flight fetch and its cache.put on the
                        // floor. The stale half worked and the revalidate half
                        // silently never did, which made this cache permanent:
                        // no deploy could displace an entry once written.
                        e.waitUntil(network.catch(() => {}));
                        return cached;
                    }
                    // Nothing cached, so the network IS the response. It must
                    // never resolve to undefined: the old `.catch(() => cached)`
                    // returned undefined on exactly this path, and
                    // respondWith(undefined) is a hard network error — a script
                    // that merely missed the cache came back EMPTY and the page
                    // died with "SyntaxError: Unexpected end of input".
                    return network.catch(() => Response.error());
                })
            )
        );
        return;
    }

    // Other static assets (fonts, images, third-party libs): cache-first.
    // These are version-pinned in the URL, so cache-first is safe.
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res.ok && e.request.method === 'GET') {
                    const clone = res.clone();
                    e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {}));
                }
                return res;
            // Without this catch, any third-party failure — an ad blocker
            // refusing unpkg or Google Fonts, a flaky connection — surfaced as
            // an unhandled rejection inside the worker and took the whole
            // FetchEvent down with it.
            }).catch(() => Response.error());
        })
    );
});
