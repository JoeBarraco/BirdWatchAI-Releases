// BirdWatchAI Community Feed — detection feed
//
// All feed work happens in the main process now. It used to live in the
// renderer, which meant an N-monitor setup ran N independent copies: N REST
// queries on launch, N more every five minutes, and N downloads of each photo.
// One fetch, broadcast to every window, is both lighter on the community
// backend and the only place a cache or an access token sensibly lives.
//
// Four things happen here that did not before:
//
//   * Photo-age fallback. "Today" with no detections today used to leave a
//     blank screensaver. Now an empty window falls back to the most recent
//     window of the same size that does have photos, and reports which one.
//
//   * Private communities. Queries carry the signed-in member's JWT, so RLS
//     widens them to every feeder that member can see. Private photos arrive
//     as private://bucket/path markers and are exchanged for signed URLs.
//
//   * Caching. Photos AND clips are resolved against the on-disk caches first,
//     and the last good feed is written to disk so a launch with no network
//     still has something to show.
//
//   * Spread sampling for "all time" and "this year". See below — this is the
//     difference between a screensaver that shows a year of birds and one that
//     shows the last three weeks and calls it a year.

const fs   = require('fs');
const path = require('path');
const { SUPABASE_URL } = require('./supabase');
const auth  = require('./auth');
const cache = require('./imagecache');

const PRIVATE_PREFIX  = 'private://';
const SIGNED_URL_TTL  = 7200;   // seconds; matches the community site
const ROW_LIMIT       = 500;

// "All time" used to be a single `order=detected_at.desc&limit=500`, which is
// not all time at all — it is the newest 500 rows. On a backend with 13k
// detections that reached back about three weeks, so "all", "this year" and
// often "this month" returned an identical set and 96% of the archive was
// unreachable no matter what the setting said.
//
// Now the feed is built from two pieces:
//
//   RECENT_LIMIT newest rows, re-queried on every refresh so new detections
//   appear promptly, plus
//
//   HISTORY_TARGET rows sampled across month-sized buckets spanning the whole
//   range, re-sampled at most once a day and persisted to disk.
//
// The split is what keeps this cheap. Sampling costs one query per bucket, but
// only once per day; the every-30-minutes refresh still costs a single query,
// exactly as before. A different random offset within each bucket on each
// re-sample means consecutive nights show different birds from the same month.
const RECENT_LIMIT    = 150;
const HISTORY_TARGET  = 450;
const MAX_BUCKETS     = 24;     // bounds the queries one re-sample can cost
const HISTORY_TTL_MS  = 24 * 60 * 60 * 1000;

let FEED_PATH    = null;
let HISTORY_PATH = null;

function init(userDataDir) {
    FEED_PATH    = path.join(userDataDir, 'feed-cache.json');
    HISTORY_PATH = path.join(userDataDir, 'history-sample.json');
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

// Is this a period whose range is wide enough that the newest N rows would not
// honestly represent it?
function isSpreadPeriod(period) {
    return period === 'all' || period === 'year';
}

// ── Queries ────────────────────────────────────────────────

const BASE_SELECT = 'id,species,image_url,video_url,detected_at,temperature,rarity';

// feeders.logo_url is newer than some backends this build will meet. An
// installed screensaver updates on its own schedule and the community backend
// on another, so asking for a column that does not exist yet must not be fatal:
// PostgREST answers the whole query with 400 / 42703, which would take the
// entire feed down to add a decoration. Ask once, remember the answer for the
// process, and fall back to the select that has always worked.
let feederSelect = 'feeders(display_name,logo_url)';
const FEEDER_SELECT_FALLBACK = 'feeders(display_name)';

function currentSelect() {
    return `${BASE_SELECT},${feederSelect}`;
}

// Resolve the saved feeder display names to ids. Filtering server-side on uuid
// keeps the fallback query honest: with a client-side name filter, a 500-row
// page could easily contain nothing from the selected feeder and look like
// "no photos" when there are plenty. Returns null for "no server-side filter".
//
// Memoised for the life of the process. Feeder names do not change while a
// screensaver is running, and this used to cost a second Postgres query on
// every single refresh — on every machine — purely to re-derive a constant.
const feederIdCache = new Map();        // names key -> ids | null

async function resolveFeederIds(names) {
    if (!names || !names.length) return null;

    const key = [...names].sort().join('\u0000');
    if (feederIdCache.has(key)) return feederIdCache.get(key);

    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?select=id,display_name`,
            { headers: await auth.headers() }
        );
        if (!res.ok) return null;        // not cached: a transient failure should be retried
        const rows = await res.json();
        const wanted = new Set(names);
        const ids = rows.filter(r => wanted.has(r.display_name)).map(r => r.id);
        // None matched — the feeders were renamed or removed. Showing
        // everything beats showing nothing.
        const out = ids.length ? ids : null;
        feederIdCache.set(key, out);
        return out;
    } catch {
        return null;
    }
}

// One page of detections. `wantCount` asks PostgREST for the exact total in
// the Content-Range header, which is how the sampler learns how far it may
// offset into a bucket without paying for a separate count query.
async function queryDetections({ since, until, feederIds, limit, offset, order, wantCount }) {
    const build = (select) => {
        let url = `${SUPABASE_URL}/rest/v1/community_detections` +
            `?select=${select}` +
            `&image_url=not.is.null` +
            `&order=detected_at.${order === 'asc' ? 'asc' : 'desc'}` +
            `&limit=${limit || ROW_LIMIT}`;

        if (offset)  url += `&offset=${offset}`;
        if (since)   url += `&detected_at=gte.${encodeURIComponent(since.toISOString())}`;
        if (until)   url += `&detected_at=lt.${encodeURIComponent(until.toISOString())}`;
        if (feederIds) url += `&feeder_id=in.(${feederIds.join(',')})`;
        return url;
    };

    const extra = wantCount ? { Prefer: 'count=exact' } : undefined;
    const headers = await auth.headers(extra);
    let res = await fetch(build(currentSelect()), { headers });

    // 42703 is "column does not exist". Only that specific failure is worth a
    // retry — anything else (auth, network, a real query error) should surface.
    if (res.status === 400 && feederSelect !== FEEDER_SELECT_FALLBACK) {
        const body = await res.clone().json().catch(() => null);
        if (body && body.code === '42703') {
            console.warn('[feed] backend has no feeders.logo_url; continuing without logos.');
            feederSelect = FEEDER_SELECT_FALLBACK;
            res = await fetch(build(currentSelect()), { headers });
        }
    }

    if (!res.ok) throw new Error(`Feed query failed (HTTP ${res.status})`);
    const rows = await res.json();

    if (!wantCount) return rows;

    // "0-54/312" — the slash tail is the total. "*" means the backend declined
    // to count, in which case the sampler simply does not offset.
    let total = null;
    const cr = res.headers.get('content-range');
    if (cr) {
        const tail = cr.split('/')[1];
        if (tail && tail !== '*') total = parseInt(tail, 10);
    }
    return { rows, total: Number.isFinite(total) ? total : null };
}

// ── Spread sampling ────────────────────────────────────────

// Month-sized buckets covering [from, to), merged into larger groups if that
// would otherwise be more buckets than MAX_BUCKETS — a backend with five years
// of detections should not cost sixty queries to sample.
function buildBuckets(from, to) {
    const months = [];
    let s = new Date(from.getFullYear(), from.getMonth(), 1);
    const guard = new Date(to);
    while (s < guard && months.length < 600) {
        const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
        months.push({ start: new Date(s), end: e });
        s = e;
    }
    if (!months.length) return [];
    if (months.length <= MAX_BUCKETS) return months;

    const group = Math.ceil(months.length / MAX_BUCKETS);
    const merged = [];
    for (let i = 0; i < months.length; i += group) {
        const chunk = months.slice(i, i + group);
        merged.push({ start: chunk[0].start, end: chunk[chunk.length - 1].end });
    }
    return merged;
}

function bucketKey(b) {
    return `${b.start.toISOString()}|${b.end.toISOString()}`;
}

function sampleKey(period, feederIds) {
    return `${period}|${feederIds ? [...feederIds].sort().join(',') : 'all'}`;
}

function readHistory() {
    if (!HISTORY_PATH) return null;
    try {
        return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    } catch {
        return null;
    }
}

function writeHistory(data) {
    if (!HISTORY_PATH) return;
    try {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify(data));
    } catch { /* the sample is an optimisation, never a requirement */ }
}

// Rows spread across the whole range, re-sampled at most once a day.
//
// `win` is the period window ('year') or null ('all'); for null the range
// starts at the oldest detection the backend holds.
async function historyRows(period, win, feederIds) {
    const key    = sampleKey(period, feederIds);
    const saved  = readHistory();
    const fresh  = saved && saved.key === key &&
                   Date.now() - (saved.savedAt || 0) < HISTORY_TTL_MS;

    if (fresh && Array.isArray(saved.rows)) return saved.rows;

    // Where does the history start? For 'year' the window says so. For 'all'
    // we ask the backend for its oldest detection — one row, and only on a
    // re-sample, so once a day at worst.
    let from = win ? win.start : null;
    if (!from) {
        if (saved && saved.oldest && saved.key === key) {
            from = new Date(saved.oldest);
        } else {
            const first = await queryDetections({ feederIds, limit: 1, order: 'asc' });
            if (!first.length) return [];
            from = new Date(first[0].detected_at);
        }
    }

    const to = win ? new Date(Math.min(win.end.getTime(), Date.now())) : new Date();
    const buckets = buildBuckets(from, to);
    if (!buckets.length) return [];

    const perBucket = Math.max(10, Math.ceil(HISTORY_TARGET / buckets.length));
    const counts    = (saved && saved.key === key && saved.counts) || {};
    const nextCounts = {};
    const rows = [];

    for (const b of buckets) {
        const bk    = bucketKey(b);
        const known = counts[bk];
        // A known count lets us start somewhere random in the bucket, so the
        // same month does not show the same birds every day. Without one
        // (first sample for this bucket) take the newest page and learn the
        // count from the response for next time.
        const offset = Number.isFinite(known) && known > perBucket
            ? Math.floor(Math.random() * (known - perBucket + 1))
            : 0;

        try {
            const { rows: page, total } = await queryDetections({
                since: b.start,
                until: b.end,
                feederIds,
                limit: perBucket,
                offset,
                wantCount: true,
            });
            if (Number.isFinite(total)) nextCounts[bk] = total;
            rows.push(...page);
        } catch {
            // One bad bucket must not cost the whole sample. Keep what we have
            // and carry on; the next re-sample tries again.
        }
    }

    writeHistory({
        savedAt: Date.now(),
        key,
        oldest: from.toISOString(),
        counts: { ...counts, ...nextCounts },
        rows,
    });

    return rows;
}

function dedupeRows(...lists) {
    const byId = new Map();
    for (const list of lists) {
        for (const r of list) {
            if (r && r.id != null && !byId.has(r.id)) byId.set(r.id, r);
        }
    }
    return [...byId.values()];
}

// ── Private media ──────────────────────────────────────────
//
// A private feeder's photos live in a non-public bucket, so the row carries a
// private://bucket/path marker rather than a URL. Members mint a short-lived
// signed URL; Supabase evaluates storage RLS at signing time, so holding a
// session is the whole of the permission check.
//
// Only markers we have not already cached need signing — private media already
// on disk is served from there, signed URL or not. That now covers clips too,
// which is a real saving: this used to re-sign every private clip in the page
// on every refresh whether or not one was ever played.
async function signPrivate(rows, wantVideo) {
    const needed = new Map();   // bucket -> [{ marker, path }]
    const seen   = new Set();

    const want = (marker, isVideo) => {
        if (typeof marker !== 'string' || !marker.startsWith(PRIVATE_PREFIX)) return;
        if (seen.has(marker)) return;
        const onDisk = isVideo ? cache.clips.cachedUrl(marker) : cache.cachedUrl(marker);
        if (onDisk) return;
        seen.add(marker);
        const rest  = marker.slice(PRIVATE_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash < 1) return;
        const bucket = rest.slice(0, slash);
        if (!needed.has(bucket)) needed.set(bucket, []);
        needed.get(bucket).push({ marker, path: rest.slice(slash + 1) });
    };

    for (const r of rows) {
        want(r.image_url, false);
        if (wantVideo) want(r.video_url, true);
        // Logos are small and repeat on every row from the same feeder, so
        // they cache like stills: once one is on disk it needs no signature,
        // and `seen` keeps a 500-row page from asking for the same handful of
        // markers hundreds of times.
        if (r.feeders && r.feeders.logo_url) want(r.feeders.logo_url, false);
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
function toPhotos(rows, signed, wantVideo) {
    const photos = [];
    for (const r of rows) {
        if (!r.species || !r.image_url) continue;

        const key = r.image_url;                 // stable across URL rotation
        const url = cache.cachedUrl(key);        // disk first
        let remote = null;

        if (isPrivate(key)) {
            remote = signed.get(key) || null;
            if (!url && !remote) continue;       // private and unreachable
        } else {
            remote = key;
        }

        // Clips resolve exactly like stills now that they have a cache of
        // their own: disk first, remote as the fallback, and `videoKey` is
        // what warmCache uses to put it on disk for next time.
        let video = null, videoKey = null, videoRemote = null, videoCached = false;
        if (wantVideo && r.video_url) {
            videoKey    = r.video_url;
            const local = cache.clips.cachedUrl(videoKey);
            videoRemote = isPrivate(videoKey) ? (signed.get(videoKey) || null) : videoKey;
            videoCached = !!local;
            video       = local || videoRemote;
        }

        // The feeder's logo, resolved the same way as the still. A logo that
        // is private and unsigned simply goes missing rather than dropping
        // the photo — the bird is the point, the badge is decoration.
        const logoKey = (r.feeders && r.feeders.logo_url) || null;
        let logo = null, logoRemote = null;
        if (logoKey) {
            logo = cache.cachedUrl(logoKey);
            logoRemote = isPrivate(logoKey) ? (signed.get(logoKey) || null) : logoKey;
        }

        photos.push({
            id:      r.id,
            key,
            url:     url || remote,
            remote,
            cached:  !!url,
            video,
            videoKey,
            videoRemote,
            videoCached,
            logo:       logo || logoRemote,
            logoKey,
            logoRemote,
            logoCached: !!logo,
            species: r.species,
            feeder:  (r.feeders && r.feeders.display_name) || '',
            date:    r.detected_at,
            temp:    typeof r.temperature === 'number' ? r.temperature : null,
            rarity:  r.rarity || null,
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

        if (isSpreadPeriod(period)) {
            // Newest rows every refresh, history from the daily sample.
            const recent = await queryDetections({
                since: current ? current.start : null,
                feederIds,
                limit: RECENT_LIMIT,
            });
            const history = await historyRows(period, current, feederIds);
            rows = dedupeRows(recent, history);
        } else if (current) {
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

        const wantVideo = !!settings.playClips;
        const signed = await signPrivate(rows, wantVideo);
        const photos = groupAndSort(toPhotos(rows, signed, wantVideo), settings.sortMode);

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
            // Kept so an offline launch can still play whatever clips are on
            // disk. Without it the marker was lost and offline meant stills.
            video_url: r.video_url || null,
            detected_at: r.detected_at,
            temperature: r.temperature,
            rarity: r.rarity,
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
    const wantVideo = !!settings.playClips;

    const photos = [];
    for (const r of saved.rows) {
        if (names && !names.has(r.feeder)) continue;
        const url = cache.cachedUrl(r.image_url);
        if (!url) continue;
        // A clip that made it to disk plays offline now. One that did not is
        // simply absent, and the slideshow shows the still instead.
        const video = wantVideo && r.video_url ? cache.clips.cachedUrl(r.video_url) : null;
        photos.push({
            id: r.id,
            key: r.image_url,
            url,
            remote: null,
            cached: true,
            video,
            videoKey: r.video_url || null,
            videoRemote: null,
            videoCached: !!video,
            species: r.species,
            feeder: r.feeder,
            date: r.detected_at,
            temp: typeof r.temperature === 'number' ? r.temperature : null,
            rarity: r.rarity || null,
        });
    }
    return groupAndSort(photos, settings.sortMode);
}

// Warm the caches for media we are about to show. Runs in the background
// after the slideshow has already started on whatever was reachable.
async function warmCache(photos, limit, clipLimit) {
    const todo = photos.filter(p => !p.cached && p.remote).slice(0, limit || 60);
    for (const p of todo) {
        await cache.fetchLocalUrl(p.key, p.remote, await auth.headers());
    }

    // Logos first-come-first-served and deduplicated: there are only ever a
    // handful across the whole feed, they are tiny, and one on disk serves
    // every photo from that feeder for as long as the cache holds it. Not
    // counted against `limit`, which exists to bound photo downloads.
    const logos = new Map();
    for (const p of photos) {
        if (p.logoKey && !p.logoCached && p.logoRemote && !logos.has(p.logoKey)) {
            logos.set(p.logoKey, p.logoRemote);
        }
    }
    for (const [key, remote] of logos) {
        await cache.fetchLocalUrl(key, remote, await auth.headers());
    }

    // Clips, bounded separately and deliberately modestly. A clip is ~1.75 MB
    // against ~130 KB for a still, so the bound is what stops a warm-up from
    // costing more egress than it saves. Over a few refreshes the clips in
    // rotation land on disk and the per-night cost collapses to nothing.
    const clips = new Map();
    for (const p of photos) {
        if (p.videoKey && !p.videoCached && p.videoRemote && !clips.has(p.videoKey)) {
            clips.set(p.videoKey, p.videoRemote);
        }
    }
    let n = 0;
    const clipCap = clipLimit == null ? 25 : clipLimit;
    for (const [key, remote] of clips) {
        if (n++ >= clipCap) break;
        await cache.clips.fetchLocalUrl(key, remote, await auth.headers());
    }

    await cache.prune();
    await cache.clips.prune();
}

module.exports = { init, load, warmCache, windowFor };
