// BirdWatchAI Community Feed - Core (config, state, data loading, filters)
const SUPABASE_URL = 'https://lsamggztfizmkyljdgwq.supabase.co';
const ANON_KEY     = 'sb_publishable_-80LQjkx2s82XnURj2DfQQ_d7ARz3js';

// ── Supabase REST helper (no external JS client needed) ───
// All community features use the Supabase REST API directly,
// matching the pattern already used for reactions/moderator.
let authAccessToken = null;   // set after magic-link sign-in
let authRefreshToken = null;

function sbHeaders(authenticated) {
    const h = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
    if (authenticated && authAccessToken) {
        h['Authorization'] = `Bearer ${authAccessToken}`;
    } else {
        h['Authorization'] = `Bearer ${ANON_KEY}`;
    }
    return h;
}

// True when a real Supabase Auth session exists.
//
// Every data-loading fetch below must send the member's JWT, not the bare anon
// key: RLS decides what a caller can see, so an anon-key request returns only
// public rows even for a signed-in member of a private community — their own
// community's detections would silently never appear.
//
// Defined here rather than in community-communities.js so these fetches don't
// depend on that file having loaded.
function sbAuthed() {
    return !!authAccessToken;
}

async function sbRpc(fnName, params, authenticated) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
        method: 'POST',
        headers: sbHeaders(authenticated),
        body: JSON.stringify(params),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // A moderator session can lapse mid-visit; catch it here so every
        // sbRpc caller gets the login prompt instead of a silent no-op.
        if (typeof handleModSessionError === 'function') handleModSessionError(err);
        return { data: null, error: err };
    }
    const data = await res.json();
    return { data, error: null };
}

let currentUser = null;       // auth user info or synthetic mod user
let currentProfile = null;    // user profile info
let userLifeList = [];        // cached life list species
let userFollowedFeeders = []; // cached followed feeder IDs
let commentCounts = {};       // { detectionId: count }
let isModAsCommunityUser = false; // true when mod is bridged as community user
let REFRESH_SECS = parseInt(localStorage.getItem('bwai-refresh-interval') ?? '30', 10);


let countdown      = REFRESH_SECS || 30;
let tabHiddenAt    = null;   // timestamp when tab was hidden
let lastTopId      = null;
let allDetections  = [];   // raw data from server
let seasonEarliestBySpecies = null; // cached: earliest detected_at per species this year
let currentView    = 'feed';
let favoritesOnly  = false;
let map            = null;
let markerGroup    = null;
let heatLayer      = null;
let mapLayer       = 'pins';   // 'pins' | 'heat'
const geocodeCache = {};   // zip -> {lat, lng} or null

// ── Filters ─────────────────────────────────────────────
let selectedSpecies = '';   // tracks the committed species filter value

function getFilters() {
    const locRaw = document.getElementById('zip-filter').value.trim();
    const loc    = parseLocationFilter(locRaw);
    const radius = parseFloat(document.getElementById('radius-filter')?.value || '25') || 25;
    return {
        period:        document.querySelector('.period-btn.active')?.dataset.period ?? '',
        species:       selectedSpecies,
        rarity:        document.getElementById('rarity-filter').value,
        feeder:        document.getElementById('feeder-filter').value,
        zip:           loc?.zip || '',
        coords:        (loc && loc.lat != null) ? { lat: loc.lat, lng: loc.lng } : null,
        radiusMiles:   radius,
        search:        (document.getElementById('search-input')?.value || '').trim().toLowerCase(),
        favoritesOnly,
    };
}

function toggleFavorites() {
    favoritesOnly = !favoritesOnly;
    document.getElementById('fav-toggle').classList.toggle('active', favoritesOnly);
    refilter();
}

// ── Species filter dropdown ─────────────────────────────
async function commitSpecies(name) {
    // Manual species change breaks the "back to stats" intent
    clearStatsContext();
    selectedSpecies = name;
    document.getElementById('species-filter').value = name;
    await refilter();
}

// Identifies the filter set the server is currently answering for. When this
// changes we need a new query; when it doesn't, the rows in memory are still
// the right rows and only the client-side pass has to re-run.
function serverFilterSig() {
    return serverFilterParams().params + '|' + (getFilters().period || '');
}
let loadedFilterSig = null;

async function refilter() {
    feedRenderLimit = FEED_RENDER_STEP;
    // Species, rarity, feeder and period are evaluated by PostgREST now, so a
    // change to any of them is a different query — not something an in-memory
    // re-filter can produce. This is the path that used to pull all 9,376 rows
    // just to narrow them locally.
    if (serverFilterSig() !== loadedFilterSig) return loadFeed();

    refiltering = true;
    try {
        // Ensure reaction data is loaded when sorting by most liked or filtering by My Likes
        const sortOrder = document.getElementById('sort-filter')?.value;
        if (hasClientOnlyFilter() && !feedExhausted) {
            // Search, "near me", My Likes and the community scope can only be
            // decided here, so they still need the whole period in memory.
            document.getElementById('feed-view').innerHTML =
                '<div class="feed-loading">Loading all detections…</div>';
            await loadAllDetections();
        }
        if (sortOrder === 'liked' || favoritesOnly) {
            if (!feedExhausted) {
                document.getElementById('feed-view').innerHTML =
                    '<div class="feed-loading">Loading all detections…</div>';
                await loadAllDetections();
            }
            await loadReactionTotals();
            const ids = allDetections.map(d => d.id);
            if (ids.length) await loadReactionCounts(ids);
        }
        // Ensure comment counts are loaded for the full dataset when sorting by Most Commented
        if (sortOrder === 'commented') {
            if (!feedExhausted) {
                document.getElementById('feed-view').innerHTML =
                    '<div class="feed-loading">Loading all detections…</div>';
                await loadAllDetections();
            }
            const ids = allDetections.map(d => d.id);
            if (ids.length) await loadCommentCounts(ids);
        }
        renderFeed();
        if (currentView === 'map')     renderMap();
        if (currentView === 'gallery') renderGallery();
        if (currentView === 'clips')   renderClips();
        if (currentView === 'stats')   renderFullStats();
        // The Feeders tab draws from allFeeders rather than from the
        // detections, so it was never re-rendered here — changing community
        // left it listing every feeder until you navigated away and back.
        if (currentView === 'feeders' && typeof renderFeeders === 'function') renderFeeders();
    } finally {
        refiltering = false;
    }
    // Same drain as loadFeed: a filter change that landed while this pass was
    // awaiting must not be lost.
    if (reloadPending) {
        reloadPending = false;
        return loadFeed();
    }
}

// ── Near me (GPS proximity) ──────────────────────────────
// Parses the location filter input; supports either:
//  - "lat, lng"  (numeric coordinates) → returns { lat, lng }
//  - "12345"     (US zip)              → returns { zip }
//  - empty                             → returns null
function parseLocationFilter(raw) {
    const s = (raw || '').trim();
    if (!s) return null;
    const m = s.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
    if (/^\d{4,10}$/.test(s)) return { zip: s };
    return { zip: s };  // free-text: fall through as zip equality
}

function useMyLocation() {
    if (!navigator.geolocation) { alert('Geolocation is not supported by your browser.'); return; }
    const btn = document.getElementById('near-me-btn');
    btn.disabled = true;
    btn.textContent = '📍 Locating…';
    navigator.geolocation.getCurrentPosition(
        pos => {
            const { latitude, longitude } = pos.coords;
            document.getElementById('zip-filter').value =
                `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
            refilter();
            btn.disabled = false;
            btn.textContent = '📍 Near me';
        },
        () => {
            alert('Location access denied.');
            btn.disabled = false;
            btn.textContent = '📍 Near me';
        },
        { timeout: 8000, enableHighAccuracy: true }
    );
}

function periodToISO(period) {
    const now = new Date();
    if (period === 'today') {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    if (period === 'week') {
        const d = new Date(now);
        d.setDate(d.getDate() - d.getDay());
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
    }
    if (period === 'month') {
        return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }
    if (period === 'year') {
        return new Date(now.getFullYear(), 0, 1).toISOString();
    }
    return null;
}

function applyClientFilters(data) {
    const { feeder, zip, coords, radiusMiles, species, rarity, search, favoritesOnly } = getFilters();
    // Pre-build the feederId → GPS index once per call so "Near me" can fall
    // back to feeder GPS for detections that lack their own lat/lng.
    // Helpers live in community-views.js; guard in case that file hasn't loaded.
    const feederGps = (coords && typeof buildFeederGpsIndex === 'function'
        && typeof allFeeders !== 'undefined')
        ? buildFeederGpsIndex(allFeeders)
        : null;
    return data.filter(d => {
        if (species       && d.species               !== species) return false;
        if (rarity        && d.rarity                !== rarity)  return false;
        if (feeder        && d.feeders?.display_name !== feeder)  return false;
        // Community scope (community-communities.js). Guarded so the feed still
        // renders if that file hasn't loaded, and the helper itself fails open.
        if (typeof communityFilterExcludes === 'function'
            && communityFilterExcludes(d)) return false;
        if (coords) {
            const pt = (typeof detectionMapPoint === 'function')
                ? detectionMapPoint(d, feederGps)
                : (d.latitude != null && d.longitude != null
                    ? { lat: +d.latitude, lng: +d.longitude } : null);
            if (!pt) return false;
            const dist = haversineMiles(coords.lat, coords.lng, pt.lat, pt.lng);
            if (dist > radiusMiles) return false;
        } else if (zip && d.zip_code !== zip) {
            return false;
        }
        if (favoritesOnly && !hasUserReaction(d.id))                 return false;
        if (search) {
            const haystack = [
                d.species,
                d.feeders?.display_name,
                d.notes,
                d.zip_code,
                d.rarity,
            ].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(search)) return false;
        }
        return true;
    });
}

// ── Format detection time with local timezone label ──────
function fmtDetectedAt(isoStr) {
    return new Date(isoStr).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'numeric', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
}

// ── Load first-of-season data (full year, independent of filter period) ──
async function loadSeasonEarliest() {
    const thisYear = new Date().getFullYear();
    const yearStart = new Date(thisYear, 0, 1).toISOString();
    try {
        // Same 1000-row cap as everywhere else: `limit=10000` returned 1000
        // rows, and since they were the *earliest* 1000 of the year, any
        // species first seen after that simply never got a First of Season
        // badge.
        const rows = await fetchAllRows(
            `${SUPABASE_URL}/rest/v1/community_detections?select=id,species,detected_at`
            + `&detected_at=gte.${encodeURIComponent(yearStart)}&order=detected_at.asc`,
            sbAuthed());
        if (!rows) return;
        const earliest = {};
        rows.forEach(d => {
            if (!d.species || !d.detected_at) return;
            if (!earliest[d.species] || d.detected_at < earliest[d.species]) {
                earliest[d.species] = d.detected_at;
            }
        });
        seasonEarliestBySpecies = earliest;
    } catch (e) { /* keep previous cache on error */ }
}

// ── Load data ────────────────────────────────────────────
const PAGE_SIZE  = 60;
// Supabase caps every response at 1000 rows no matter what `limit` says. Any
// "load everything" path is therefore inherently paged, and any single query
// that assumes it got the whole table is silently wrong past row 1000.
const MAX_ROWS   = 1000;
// Page size for bulk loads. The feed pages at 60 because that's a screenful;
// bulk loads should use the largest page the server will actually return, or
// the round-trip count (and the wall-clock) is ~17x higher than it needs to be.
const BULK_PAGE_SIZE = MAX_ROWS;
// How many bulk pages to have in flight at once.
const BULK_CONCURRENCY = 6;
// Cards rendered per step. renderFeed builds one innerHTML string for every
// visible row: filtering to a common species produced 6,390 cards, a 16MB
// string and ~2s of blocked main thread. The scroll sentinel raises this in
// FEED_RENDER_STEP increments, so scrolling still walks the whole set.
const FEED_RENDER_STEP = 120;
let   feedRenderLimit  = FEED_RENDER_STEP;
let   feedVisibleCount = 0;   // rows matching filters, before the render cap
let   feedOffset = 0;
let   feedExhausted = false;
let   feedLoading   = false;
let   refiltering   = false;
let   serverTotal   = null;   // exact row count for the current filter set

// ── Server-side filter pushdown ──────────────────────────
// Species, rarity and feeder are all evaluatable by PostgREST. Pushing them
// down is the difference between "one 60-row page" and "download all 9,376
// rows to keep 6,390 of them" — the latter took 27s of serial round-trips.
// Everything getFilters() returns that ISN'T handled here has to be applied in
// the browser, which is what still forces a full load (see hasClientOnlyFilter).
function serverFilterParams() {
    const rarity = document.getElementById('rarity-filter').value;
    const feeder = document.getElementById('feeder-filter').value;
    let params = '';
    if (selectedSpecies) params += `&species=eq.${encodeURIComponent(selectedSpecies)}`;
    if (rarity)          params += `&rarity=eq.${encodeURIComponent(rarity)}`;
    if (feeder)          params += `&feeders.display_name=eq.${encodeURIComponent(feeder)}`;
    return { params, feederScoped: !!feeder };
}

// The embedded-feeders select clause. `!inner` promotes the embed to a real
// join so `feeders.display_name=eq.…` can be evaluated server-side — but only
// when a feeder is actually selected: inner-joining unconditionally would
// silently drop any detection whose feeder row is missing.
function detectionSelect(feederScoped) {
    return feederScoped
        ? 'select=*,feeders!inner(display_name,zip_code)'
        : 'select=*,feeders(display_name,zip_code)';
}

// Filters that can only be decided in the browser, and so still require the
// whole period in memory: free-text search spans a joined column, "near me"
// needs haversine, My Likes needs the reaction table, and the community scope
// needs the feeder-membership index.
function hasClientOnlyFilter() {
    return !!(document.getElementById('search-input')?.value || '').trim()
        || !!document.getElementById('zip-filter').value.trim()
        || favoritesOnly
        || !!(typeof selectedCommunity !== 'undefined' && selectedCommunity);
}

// One place that builds a detections URL, so the select clause, the period
// bound and the pushed-down filters can't drift between callers.
function detectionsUrl(offset, limit) {
    const { params, feederScoped } = serverFilterParams();
    const since = periodToISO(getFilters().period);
    let url = `${SUPABASE_URL}/rest/v1/community_detections?${detectionSelect(feederScoped)}`
            + `&limit=${limit}&offset=${offset}&order=detected_at.desc${params}`;
    if (since) url += `&detected_at=gte.${encodeURIComponent(since)}`;
    return url;
}

// Detections carried their own zip_code until 2026-06-18; every row since has
// it null, so anything reading d.zip_code — the map, the zip filter, zip
// grouping, CSV export — needs the feeder's zip folded onto the row. This used
// to live only in loadFeed, which meant rows arriving via loadAllDetections
// (i.e. every row past the first page) silently had no zip at all.
function foldFeederZip(rows) {
    rows.forEach(d => {
        if (!d.zip_code && d.feeders?.zip_code) d.zip_code = d.feeders.zip_code;
    });
    return rows;
}

// Fetches one page and, when asked, the exact total for the whole filter set.
// PostgREST reports it in Content-Range as "start-end/total", which is how we
// get a real count instead of the old rows.length (capped at 1000).
async function fetchDetectionPage(offset, limit, wantCount) {
    const headers = sbHeaders(sbAuthed());
    if (wantCount) headers['Prefer'] = 'count=exact';
    const res = await fetch(detectionsUrl(offset, limit), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = foldFeederZip(await res.json());
    let total = null;
    if (wantCount) {
        const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
        if (m) total = parseInt(m[1], 10);
    }
    return { rows, total };
}

// Fetches every row of a query, working around the 1000-row response cap.
// Asks for the exact count on the first page, then pulls the remaining pages
// concurrently. `url` must already carry its select/filter/order params and no
// limit or offset. Any query that used `limit=50000` and trusted the result to
// be complete wants this instead.
async function fetchAllRows(url, authed) {
    const headers = sbHeaders(authed);
    headers['Prefer'] = 'count=exact';
    const first = await fetch(`${url}&limit=${MAX_ROWS}&offset=0`, { headers });
    if (!first.ok) return null;
    let rows = await first.json();
    const m = /\/(\d+)$/.exec(first.headers.get('content-range') || '');
    const total = m ? parseInt(m[1], 10) : rows.length;
    const morePages = Math.ceil(total / MAX_ROWS) - 1;
    if (morePages > 0) {
        const rest = await mapConcurrent(morePages, BULK_CONCURRENCY, async i => {
            try {
                const r = await fetch(`${url}&limit=${MAX_ROWS}&offset=${(i + 1) * MAX_ROWS}`,
                                      { headers: sbHeaders(authed) });
                return r.ok ? await r.json() : [];
            } catch (e) { return []; }
        });
        rows = rows.concat(...rest);
    }
    rows.totalCount = total;
    return rows;
}

// Runs `make(i)` for i in [0,count) with at most `limit` promises in flight,
// preserving result order. Used by every bulk pager below.
async function mapConcurrent(count, limit, make) {
    const results = new Array(count);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => {
        while (true) {
            const i = next++;
            if (i >= count) return;
            results[i] = await make(i);
        }
    }));
    return results;
}

// Deduplicate allDetections by ID (handles race between infinite scroll and filter loading)
function deduplicateDetections() {
    const seen = new Set();
    allDetections = allDetections.filter(d => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
    });
}

// Set when a reload is asked for while one is already running. Bailing outright
// would drop it: change the species while a search's full load is in flight and
// the dropdown would show the new value over a feed that never re-queried.
let reloadPending = false;

async function loadFeed(append = false) {
    if (append && feedExhausted) return;
    // Neither path may overlap itself. The refresh path used to be unguarded,
    // so the 1s ticker could stack a second full load on top of one already
    // 20s deep — each resetting feedOffset and allDetections under the other.
    if (feedLoading || refiltering) {
        if (!append) { reloadPending = true; resetCountdown(); }
        return;
    }
    feedLoading = true;

    const indicator = document.getElementById('refresh-indicator');
    if (!append) {
        indicator.classList.add('refreshing');
        document.getElementById('countdown').textContent = 'Refreshing…';
        feedOffset = 0;
        feedExhausted = false;
        feedRenderLimit = FEED_RENDER_STEP;
    }

    try {
        const { rows: page, total } = await fetchDetectionPage(feedOffset, PAGE_SIZE, !append);
        if (total !== null) serverTotal = total;
        if (!append) loadedFilterSig = serverFilterSig();

        if (append) {
            allDetections = [...allDetections, ...page];
            deduplicateDetections();
        } else {
            allDetections = page;
        }
        if (page.length < PAGE_SIZE) feedExhausted = true;
        feedOffset += page.length;

        // Private feeders' media arrives as private:// markers rather than a
        // readable URL. Resolve them to signed URLs here, before anything
        // renders, so every downstream view stays unaware of the distinction
        // (community-communities.js).
        if (typeof signPrivateMedia === 'function') await signPrivateMedia(allDetections);

        if (!append) loadSeasonEarliest(); // refresh first-of-season cache
        // These derive the roster from the rows in hand. That was only ever a
        // provisional fill for the gap before the real roster query returned,
        // and it is only sound while the server isn't narrowing the rows: with
        // a species filter pushed down, allDetections holds exactly one
        // species, and repopulating from it would leave the dropdown offering
        // only the species already selected with no way back.
        //
        // Once loadAllDropdownOptions() has answered for this period it owns
        // these dropdowns — re-deriving from a 60-row page would drop the
        // roster from 23 species to whatever that page happened to contain,
        // and the cache means the real query would not run again to repair it.
        if (!dropdownsReady && !serverFilterParams().params) {
            populateFeederDropdown(allDetections);
            populateFeedSpeciesDropdown(allDetections);
            populateMapSpeciesDropdown(allDetections);
        }
        // Re-narrow them to the selected community, if any — the calls above
        // repopulate from the full set (community-communities.js). No-ops when
        // no community is selected.
        if (typeof scopeDropdownsToCommunity === 'function') await scopeDropdownsToCommunity(false);

        // Which cases still need the entire period in memory. Species, rarity
        // and feeder are NOT in this list any more — the server filters those,
        // so the paged feed is already complete and infinite scroll handles the
        // rest. Only genuinely client-side work forces a full load.
        const sortOrder = document.getElementById('sort-filter')?.value || 'recent';
        const needsAll = sortOrder === 'liked' || sortOrder === 'commented'
            || hasClientOnlyFilter()
            || currentView === 'stats' || currentView === 'gallery' || currentView === 'clips';
        if (!append && !feedExhausted && needsAll) {
            await loadAllDetections();
        }

        // Load reaction data and comment counts from Supabase
        const ids = allDetections.map(d => d.id);
        if (sortOrder === 'liked') {
            await loadReactionTotals();
            await loadReactionCounts(ids);
            await loadCommentCounts(ids);
        } else if (sortOrder === 'commented') {
            await loadCommentCounts(ids);
            loadReactionCounts(ids).then(() => renderFeed());
            if (!append) loadReactionTotals().then(() => renderFeed());
        } else {
            const pageIds = page.map(d => d.id);
            loadReactionCounts(pageIds).then(() => renderFeed());
            loadCommentCounts(pageIds).then(() => renderFeed());
            if (!append) loadReactionTotals().then(() => renderFeed());
        }

        const hadDetections = lastTopId !== null;
        const prevTop = lastTopId;
        renderFeed();
        if (currentView === 'map')     renderMap();
        if (currentView === 'gallery') renderGallery();
        if (currentView === 'clips')   renderClips();
        if (currentView === 'stats')   renderFullStats();
        if (typeof refreshSlideshowPhotos === 'function') refreshSlideshowPhotos();
        if (typeof refreshClipTheater === 'function') refreshClipTheater();
        checkForRareNotifications(allDetections);
        renderBirdOfTheDay(allDetections);
        // Confetti for brand-new Very Rare detections (even without notifications)
        if (hadDetections && prevTop !== allDetections[0]?.id) {
            const newVeryRare = allDetections.find(d => d.id !== prevTop && d.rarity === 'Very Rare' && !seenRareIds.has(d.id));
            if (newVeryRare) {
                seenRareIds.add(newVeryRare.id);
                localStorage.setItem('bwai-seen-rare', JSON.stringify([...seenRareIds]));
                launchConfetti();
            }
        }
        if (hadDetections) playChime();

    } catch (err) {
        if (!append) {
            document.getElementById('feed-view').innerHTML =
                `<div class="feed-error">Error loading feed: ${err.message}</div>`;
        }
    }

    feedLoading = false;
    if (!append) {
        indicator.classList.remove('refreshing');
        resetCountdown();
        // Fetch all species/feeder names so dropdowns are complete
        loadAllDropdownOptions();
        // First-load only: honor ?feeder=… deep-links by switching to the Feed view pre-filtered.
        if (typeof applyDeepLinkParams === 'function') applyDeepLinkParams();
        // Drain a request that arrived while this load was running.
        if (reloadPending) {
            reloadPending = false;
            return loadFeed();
        }
    }
}

// Puts the auto-refresh countdown back to a full interval. Every exit from the
// refresh path has to call this: the ticker fires loadFeed at countdown <= 0
// and only the old success path reset it, so a bailed or long-running load left
// countdown pinned at or below zero — and the ticker then re-fired it once per
// second for the whole load.
function resetCountdown() {
    const el = document.getElementById('countdown');
    if (REFRESH_SECS > 0) {
        countdown = REFRESH_SECS;
        if (el) el.textContent = `Refreshing in ${fmtCountdown(countdown)}`;
    } else if (el) {
        el.textContent = 'Auto-refresh off';
    }
}

// ── Incremental auto-refresh ─────────────────────────────
// What the 30s ticker calls. The old ticker called loadFeed(), which resets
// feedExhausted and then re-downloads the entire filtered set from scratch:
// measured at 22.5s of serial requests every 30s with a species filter active.
// A poll only needs the rows that arrived since the newest one we hold.
async function refreshFeed() {
    if (feedLoading || refiltering) { resetCountdown(); return; }
    // Nothing loaded yet, or a view that wants the whole set in memory anyway —
    // fall back to the full path.
    const sortOrder = document.getElementById('sort-filter')?.value || 'recent';
    if (!allDetections.length || sortOrder !== 'recent'
        || currentView === 'stats' || currentView === 'gallery') {
        return loadFeed();
    }

    feedLoading = true;
    const indicator = document.getElementById('refresh-indicator');
    indicator.classList.add('refreshing');
    document.getElementById('countdown').textContent = 'Refreshing…';

    try {
        // ISO-8601 UTC sorts lexicographically, so max() needs no date parsing.
        const newest = allDetections.reduce(
            (m, d) => (d.detected_at && d.detected_at > m ? d.detected_at : m), '');
        const { params, feederScoped } = serverFilterParams();
        // detected_at=gt.<newest> replaces the period's gte bound: anything
        // newer than a row we already hold is inside the period by definition.
        const newUrl = `${SUPABASE_URL}/rest/v1/community_detections?${detectionSelect(feederScoped)}`
                     + `&limit=${PAGE_SIZE}&order=detected_at.desc${params}`
                     + `&detected_at=gt.${encodeURIComponent(newest)}`;

        // Two small requests in parallel: the new rows, and the exact total for
        // the filter set. The total is how a poll notices a moderator delete or
        // edit — which an "only fetch newer rows" poll would otherwise never
        // see — and falls back to a full reload when the arithmetic disagrees.
        const countHeaders = sbHeaders(sbAuthed());
        countHeaders['Prefer'] = 'count=exact';
        const [newRes, countRes] = await Promise.all([
            fetch(newUrl, { headers: sbHeaders(sbAuthed()) }),
            fetch(detectionsUrl(0, 1), { headers: countHeaders }),
        ]);
        if (!newRes.ok) throw new Error(`HTTP ${newRes.status}`);
        const fresh = foldFeederZip(await newRes.json());

        let actualTotal = null;
        if (countRes.ok) {
            const m = /\/(\d+)$/.exec(countRes.headers.get('content-range') || '');
            if (m) actualTotal = parseInt(m[1], 10);
        }

        // A gap: more new rows than one page, or rows vanished/changed beneath
        // us. Either way our incremental picture is wrong — reload properly.
        const expected = serverTotal === null ? null : serverTotal + fresh.length;
        if (fresh.length === PAGE_SIZE
            || (actualTotal !== null && expected !== null && actualTotal !== expected)) {
            feedLoading = false;
            indicator.classList.remove('refreshing');
            return loadFeed();
        }
        if (actualTotal !== null) serverTotal = actualTotal;

        if (fresh.length) {
            if (typeof signPrivateMedia === 'function') await signPrivateMedia(fresh);
            allDetections = [...fresh, ...allDetections];
            deduplicateDetections();
            feedOffset += fresh.length;
            loadSeasonEarliest();   // a new arrival may be a first-of-season
        }

        const freshIds = fresh.map(d => d.id);
        const prevTop = lastTopId;
        const hadDetections = lastTopId !== null;
        // Counts for the whole loaded set: likes and comments change on old
        // rows too, so a poll that only refreshed new rows would freeze them.
        const ids = allDetections.map(d => d.id);
        loadReactionCounts(ids).then(() => renderFeed());
        loadCommentCounts(ids).then(() => renderFeed());
        loadReactionTotals().then(() => renderFeed());

        renderFeed();
        if (currentView === 'map') renderMap();
        if (typeof refreshSlideshowPhotos === 'function') refreshSlideshowPhotos();
        if (typeof refreshClipTheater === 'function') refreshClipTheater();
        if (fresh.length) {
            checkForRareNotifications(allDetections);
            renderBirdOfTheDay(allDetections);
            if (hadDetections && prevTop !== allDetections[0]?.id) {
                const newVeryRare = allDetections.find(
                    d => freshIds.includes(d.id) && d.rarity === 'Very Rare' && !seenRareIds.has(d.id));
                if (newVeryRare) {
                    seenRareIds.add(newVeryRare.id);
                    localStorage.setItem('bwai-seen-rare', JSON.stringify([...seenRareIds]));
                    launchConfetti();
                }
            }
            if (hadDetections) playChime();
        }
    } catch (err) {
        /* a failed poll is not worth blanking the feed the user is reading */
    }

    feedLoading = false;
    indicator.classList.remove('refreshing');
    resetCountdown();
}

// ── Load all species/feeder names for complete dropdowns ──
let dropdownsReady = false;
let totalDetectionCount = null;   // total from lightweight query

function updateFeedCount() {
    const countEl = document.getElementById('feed-count');
    const visible = applyClientFilters(allDetections);
    // Denominator is the exact count for the filter set the server is
    // answering, from Content-Range. The old code used the dropdown query's
    // rows.length, which the 1000-row cap pinned at 1000 — so a 9,376-row feed
    // read "60 of 1000".
    const denom = serverTotal !== null ? serverTotal : totalDetectionCount;
    if (denom === null && !dropdownsReady) {
        countEl.innerHTML = `<span class="loading-count">${visible.length} detections — loading all…</span>`;
    } else if (denom !== null && visible.length < denom) {
        countEl.textContent = `${visible.length} of ${denom} detections`;
    } else {
        countEl.textContent = visible.length ? `${visible.length} detection${visible.length !== 1 ? 's' : ''}` : '';
    }
}

// The dropdown roster only depends on the period (the filters themselves must
// not narrow the list you pick from), so a poll that hasn't changed period has
// nothing to redo. It used to re-run on every 30s refresh — a 4.4s query that
// then replaced the <select> innerHTML and set disabled=true, wiping the
// dropdown out from under anyone mid-selection.
let dropdownCacheKey = null;

// Call after anything that can change which species or feeders exist — a
// moderator edit or delete, a feeder leaving a community — so the next
// loadFeed() rebuilds the roster instead of trusting the cache.
function invalidateDropdownCache() {
    dropdownCacheKey = null;
}

async function loadAllDropdownOptions(force = false) {
    const cacheKey = getFilters().period || 'all';
    if (!force && dropdownsReady && dropdownCacheKey === cacheKey) return;
    dropdownCacheKey = cacheKey;

    dropdownsReady = false;
    totalDetectionCount = null;
    const specSel = document.getElementById('species-filter');

    // Show loading state
    updateFeedCount();
    specSel.innerHTML = '<option value="">Loading species…</option>';
    specSel.disabled = true;

    const { period } = getFilters();
    const since = periodToISO(period);
    const bound = since ? `&detected_at=gte.${encodeURIComponent(since)}` : '';
    try {
        // `limit=50000` was a no-op: the server caps every response at MAX_ROWS.
        // Combined with order=species that truncated the roster mid-alphabet —
        // 14 of 23 species offered, and everything after "Northern Cardinal"
        // unreachable from the filter. The count came from rows.length, which
        // the same cap pinned at 1000, so the feed read "60 of 1000".
        const rows = await fetchAllRows(
            `${SUPABASE_URL}/rest/v1/community_detections?select=species,feeders(display_name)`
            + `&order=species${bound}`, sbAuthed());
        if (!rows) return;

        totalDetectionCount = rows.totalCount;
        const species = [...new Set(rows.map(r => r.species).filter(Boolean))].sort();
        const feeders = [...new Set(rows.map(r => r.feeders?.display_name).filter(Boolean))].sort();

        // Update species dropdown
        const prevSpec = selectedSpecies;
        specSel.innerHTML = '<option value="">All species (' + species.length + ')</option>' +
            species.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
        specSel.disabled = false;
        let speciesFilterCleared = false;
        if (species.includes(prevSpec)) {
            specSel.value = prevSpec;
        } else if (prevSpec) {
            // Previously-selected species no longer exists in the current dataset
            // (e.g. a moderator corrected the only matching detection, or it aged
            // out of the active period). Keep the state variable in sync with the
            // dropdown (which has reverted to "All species") so the feed doesn't
            // silently filter against a stale value.
            selectedSpecies = '';
            speciesFilterCleared = true;
        }

        // Update map species dropdown
        const mapSel = document.getElementById('map-species-filter');
        const prevMap = mapSel.value;
        mapSel.innerHTML = '<option value="">All species</option>' +
            species.map(s => `<option value="${s}">${s}</option>`).join('');
        if (species.includes(prevMap)) mapSel.value = prevMap;

        // Update feeder dropdown
        const feederSel = document.getElementById('feeder-filter');
        const prevFeeder = feederSel.value;
        feederSel.innerHTML = '<option value="">All feeders</option>' +
            feeders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
        if (feeders.includes(prevFeeder)) feederSel.value = prevFeeder;

        dropdownsReady = true;
        updateFeedCount();

        // If we had to clear a stale species filter, re-render the active views
        // so the list reflects the now-unfiltered state (otherwise the user sees
        // an empty list with a "All species" dropdown until they reload).
        if (speciesFilterCleared) {
            renderFeed();
            if (currentView === 'map')     renderMap();
            if (currentView === 'gallery') renderGallery();
            if (currentView === 'clips')   renderClips();
            if (currentView === 'stats')   renderFullStats();
        }
    } catch (e) {
        specSel.disabled = false;
        dropdownsReady = true;
        updateFeedCount();
    }
}

// ── Infinite scroll via IntersectionObserver ─────────────
const feedSentinel = document.getElementById('feed-sentinel');
const scrollObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting || currentView !== 'feed') return;
    // Rows already in memory but held back by the render cap come first — no
    // point fetching more from the server while we're still not showing what
    // we have.
    if (feedVisibleCount > feedRenderLimit) {
        feedRenderLimit += FEED_RENDER_STEP;
        renderFeed();
        return;
    }
    loadFeed(true);
}, { rootMargin: '200px' });
scrollObserver.observe(feedSentinel);

// ── Feeder dropdown ──────────────────────────────────────
function populateFeederDropdown(data) {
    const sel   = document.getElementById('feeder-filter');
    const prev  = sel.value;
    const names = [...new Set(data.map(d => d.feeders?.display_name).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All feeders</option>' +
        names.map(n => `<option value="${n}">${n}</option>`).join('');
    if (names.includes(prev)) sel.value = prev;
}

function populateFeedSpeciesDropdown(data) {
    const sel = document.getElementById('species-filter');
    const prev = selectedSpecies;
    const species = [...new Set(data.map(d => d.species).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All species</option>' +
        species.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (species.includes(prev)) {
        sel.value = prev;
    }
    // Don't clear selectedSpecies — full dropdown options load later
    // and the filter should persist across refreshes
}

// ── Map species dropdown ─────────────────────────────────
function populateMapSpeciesDropdown(data) {
    const sel     = document.getElementById('map-species-filter');
    const prev    = sel.value;
    const species = [...new Set(data.map(d => d.species).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All species</option>' +
        species.map(s => `<option value="${s}">${s}</option>`).join('');
    if (species.includes(prev)) sel.value = prev;
}

