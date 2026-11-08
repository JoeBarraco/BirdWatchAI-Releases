// BirdWatchAI Community Feed — detection feed
//
// All feed work happens in the main process now. It used to live in the
// renderer, which meant an N-monitor setup ran N independent copies: N REST
// queries on launch, N more every five minutes, and N downloads of each photo.
// One fetch, broadcast to every window, is both lighter on the community
// backend and the only place a cache or an access token sensibly lives.
//
// Three things happen here that did not before:
//
//   * Photo-age fallback. "Today" with no detections today used to leave a
//     blank screensaver. Now an empty window falls back to the most recent
//     window of the same size that does have photos, and reports which one.
//
//   * Private communities. Queries carry the signed-in member's JWT, so RLS
//     widens them to every feeder that member can see. Private photos arrive
//     as private://bucket/path markers and are exchanged for signed URLs.
//
//   * Caching. Photos are resolved against the on-disk cache first, and the
//     last good feed is written to disk so a launch with no network still has
//     something to show.

const fs   = require('fs');
const path = require('path');
const { SUPABASE_URL } = require('./supabase');
const auth  = require('./auth');
const cache = require('./imagecache');

const PRIVATE_PREFIX  = 'private://';
const SIGNED_URL_TTL  = 7200;   // seconds; matches the community site
const ROW_LIMIT       = 500;

let FEED_PATH = null;

function init(userDataDir) {
    FEED_PATH = path.join(userDataDir, 'feed-cache.json');
}

// ── Period windows ─────────────────────────────────────────
//
// Weeks start Monday, matching the community site's "This Week".

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d) {
    const s = startOfDay(d);
    const dow = (s.getDay() + 6) % 7;   // 0 = Monday
    s.setDate(s.getDate() - dow);
    return s;
}

// The window of `period` size that contains `date`, as a half-open range.
function windowFor(period, date) {
    const d = new Date(date);
    switch (period) {
        case 'today': {
            const start = startOfDay(d);
            const end   = new Date(start); end.setDate(end.getDate() + 1);
            return { start, end, label: labelDay(start) };
        }
        case 'week': {
            const start = startOfWeek(d);
            const end   = new Date(start); end.setDate(end.getDate() + 7);
            return { start, end, label: `week of ${labelDay(start, true)}` };
        }
        case 'month': {
            const start = new Date(d.getFullYear(), d.getMonth(), 1);
            const end   = new Date(d.getFullYear(), d.getMonth() + 1, 1);
            return { start, end, label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
        }
        case 'year': {
            const start = new Date(d.getFullYear(), 0, 1);
            const end   = new Date(d.getFullYear() + 1, 0, 1);
            return { start, end, label: String(d.getFullYear()) };
        }
        default:
            return null;   // 'all'
    }
}

function labelDay(d, short) {
    return d.toLocaleDateString(undefined, short
        ? { month: 'long', day: 'numeric' }
        : { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── Queries ────────────────────────────────────────────────

const SELECT = 'id,species,image_url,detected_at,feeders(display_name)';

// Resolve the saved feeder display names to ids. Filtering server-side on uuid
// keeps the fallback query honest: with a client-side name filter, a 500-row
// page could easily contain nothing from the selected feeder and look like
// "no photos" when there are plenty. Returns null for "no server-side filter".
async function resolveFeederIds(names) {
    if (!names || !names.length) return null;
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?select=id,display_name`,
            { headers: await auth.headers() }
        );
        if (!res.ok) return null;
        const rows = await res.json();
        const wanted = new Set(names);
        const ids = rows.filter(r => wanted.has(r.display_name)).map(r => r.id);
        // None matched — the feeders were renamed or removed. Showing
        // everything beats showing nothing.
        return ids.length ? ids : null;
    } catch {
        return null;
    }
}

async function queryDetections({ since, until, feederIds }) {
    let url = `${SUPABASE_URL}/rest/v1/community_detections` +
        `?select=${SELECT}` +
        `&image_url=not.is.null` +
        `&order=detected_at.desc` +
        `&limit=${ROW_LIMIT}`;

    if (since) url += `&detected_at=gte.${encodeURIComponent(since.toISOString())}`;
    if (until) url += `&detected_at=lt.${encodeURIComponent(until.toISOString())}`;
    if (feederIds) url += `&feeder_id=in.(${feederIds.join(',')})`;

    const res = await fetch(url, { headers: await auth.headers() });
    if (!res.ok) throw new Error(`Feed query failed (HTTP ${res.status})`);
    return res.json();
}

// ── Private media ──────────────────────────────────────────
//
// A private feeder's photos live in a non-public bucket, so the row carries a
// private://bucket/path marker rather than a URL. Members mint a short-lived
// signed URL; Supabase evaluates storage RLS at signing time, so holding a
// session is the whole of the permission check.
//
// Only markers we have not already cached need signing — a private photo
// already on disk is served from there, signed URL or not.
async function signPrivate(rows) {
    const needed = new Map();   // bucket -> [{ marker, path }]

    for (const r of rows) {
        const marker = r.image_url;
        if (typeof marker !== 'string' || !marker.startsWith(PRIVATE_PREFIX)) continue;
        if (cache.cachedUrl(marker)) continue;           // already on disk
        const rest  = marker.slice(PRIVATE_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash < 1) continue;
        const bucket = rest.slice(0, slash);
        if (!needed.has(bucket)) needed.set(bucket, []);
        needed.get(bucket).push({ marker, path: rest.slice(slash + 1) });
    }

    const signed = new Map();
    if (!needed.size) return signed;

    // Signed-out means RLS never handed us a private row in the first place.
    if (!auth.isSignedIn()) return signed;

    for (const [bucket, items] of needed) {
        try {
            const res = await fetch(
                `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
                {
                    method: 'POST',
                    headers: await auth.headers({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        expiresIn: SIGNED_URL_TTL,
                        paths: items.map(i => i.path),
                    }),
                }
            );
            if (!res.ok) continue;
            const out = await res.json();
            if (!Array.isArray(out)) continue;
            out.forEach((r, i) => {
                if (!r || !r.signedURL || !items[i]) return;
                signed.set(items[i].marker, `${SUPABASE_URL}/storage/v1${r.signedURL}`);
            });
        } catch { /* leave unsigned; the photo is dropped below */ }
    }
    return signed;
}

// ── Shaping ────────────────────────────────────────────────

function isPrivate(u) {
    return typeof u === 'string' && u.startsWith(PRIVATE_PREFIX);
}

// Turn detection rows into photos the renderer can display. `key` is the
// photo's stable identity for caching; `url` is what to load right now.
function toPhotos(rows, signed) {
    const photos = [];
    for (const r of rows) {
        if (!r.species || !r.image_url) continue;

        const key = r.image_url;                 // stable across URL rotation
        let url = cache.cachedUrl(key);          // disk first
        let remote = null;

        if (isPrivate(key)) {
            remote = signed.get(key) || null;
            if (!url && !remote) continue;       // private and unreachable
        } else {
            remote = key;
        }

        photos.push({
            id:      r.id,
            key,
            url:     url || remote,
            remote,
            cached:  !!url,
            species: r.species,
            feeder:  (r.feeders && r.feeders.display_name) || '',
            date:    r.detected_at,
        });
    }
    return photos;
}

function groupAndSort(photos, sortMode) {
    const bySpecies = new Map();
    for (const p of photos) {
        if (!bySpecies.has(p.species)) {
            bySpecies.set(p.species, { species: p.species, photos: [], lastSeen: p.date });
        }
        const g = bySpecies.get(p.species);
        g.photos.push(p);
        if (p.date > g.lastSeen) g.lastSeen = p.date;
    }

    const groups = [...bySpecies.values()];
    switch (sortMode) {
        case 'count': groups.sort((a, b) => b.photos.length - a.photos.length); break;
        case 'alpha': groups.sort((a, b) => a.species.localeCompare(b.species)); break;
        case 'recent': groups.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '')); break;
        default: shuffle(groups); break;
    }

    const out = [];
    for (const g of groups) out.push(...g.photos);
    if (sortMode === 'random' || !sortMode) shuffle(out);
    return out;
}

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── Load ───────────────────────────────────────────────────

// Fetch the feed for these settings.
//
// Returns { photos, fallback, offline }. `fallback` is set when the selected
// photo-age window was empty and we backed up to an older one, so the UI can
// say which day or week is on screen rather than quietly lying about "today".
async function load(settings) {
    const period    = settings.photoAge || 'all';
    const feederIds = await resolveFeederIds(settings.feeders);

    try {
        let rows = [];
        let fallback = null;

        const current = windowFor(period, new Date());

        if (current) {
            rows = await queryDetections({ since: current.start, feederIds });
        } else {
            rows = await queryDetections({ feederIds });
        }

        // Nothing in the selected window — back up to the most recent window of
        // the same size that does have photos. One extra query, and only when
        // the screensaver would otherwise have been blank.
        if (current && !rows.length) {
            const recent = await queryDetections({ feederIds });
            if (recent.length) {
                const newest = recent[0].detected_at;
                const win    = windowFor(period, new Date(newest));
                // Compare instants, not ISO strings. Postgres returns
                // "+00:00" with microseconds while toISOString() produces "Z"
                // with milliseconds, so the two are not lexicographically
                // comparable even though they are both UTC.
                const from = win.start.getTime();
                const to   = win.end.getTime();
                rows = recent.filter(r => {
                    const t = Date.parse(r.detected_at);
                    return t >= from && t < to;
                });
                // A window boundary can fall mid-page; if the filter emptied
                // the page, just show the most recent photos we have.
                if (!rows.length) rows = recent;
                fallback = { period, label: win.label, since: win.start.toISOString() };
            }
        }

        const signed = await signPrivate(rows);
        const photos = groupAndSort(toPhotos(rows, signed), settings.sortMode);

        if (photos.length) saveCache(rows);
        return { photos, fallback, offline: false };

    } catch (err) {
        // Network or backend trouble. Anything already on disk is better than
        // a black screen, so rebuild the last good feed from the cache.
        const photos = loadFromCache(settings);
        return {
            photos,
            fallback: null,
            offline: true,
            error: err.message,
        };
    }
}

// ── Disk cache of the feed itself ──────────────────────────

function saveCache(rows) {
    if (!FEED_PATH) return;
    try {
        const slim = rows.map(r => ({
            id: r.id,
            species: r.species,
            image_url: r.image_url,
            detected_at: r.detected_at,
            feeder: (r.feeders && r.feeders.display_name) || '',
        }));
        fs.writeFileSync(FEED_PATH, JSON.stringify({ savedAt: Date.now(), rows: slim }));
    } catch { /* cache is an optimisation, never a requirement */ }
}

// Rebuild a playable feed from disk. Only photos whose image bytes are also
// cached can be shown — a signed URL from last week is long dead, and a public
// URL needs the network we have just established we do not have.
function loadFromCache(settings) {
    if (!FEED_PATH) return [];
    let saved;
    try {
        saved = JSON.parse(fs.readFileSync(FEED_PATH, 'utf-8'));
    } catch {
        return [];
    }
    if (!saved || !Array.isArray(saved.rows)) return [];

    const names = settings.feeders && settings.feeders.length
        ? new Set(settings.feeders) : null;

    const photos = [];
    for (const r of saved.rows) {
        if (names && !names.has(r.feeder)) continue;
        const url = cache.cachedUrl(r.image_url);
        if (!url) continue;
        photos.push({
            id: r.id,
            key: r.image_url,
            url,
            remote: null,
            cached: true,
            species: r.species,
            feeder: r.feeder,
            date: r.detected_at,
        });
    }
    return groupAndSort(photos, settings.sortMode);
}

// Warm the image cache for photos we are about to show. Runs in the background
// after the slideshow has already started on whatever was reachable.
async function warmCache(photos, limit) {
    const todo = photos.filter(p => !p.cached && p.remote).slice(0, limit || 60);
    for (const p of todo) {
        await cache.fetchLocalUrl(p.key, p.remote, await auth.headers());
    }
    await cache.prune();
}

module.exports = { init, load, warmCache, windowFor };
