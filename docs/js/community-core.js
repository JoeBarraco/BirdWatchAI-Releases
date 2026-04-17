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

async function sbRpc(fnName, params, authenticated) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
        method: 'POST',
        headers: sbHeaders(authenticated),
        body: JSON.stringify(params),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
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
    return {
        period:        document.querySelector('.period-btn.active')?.dataset.period ?? '',
        species:       selectedSpecies,
        rarity:        document.getElementById('rarity-filter').value,
        feeder:        document.getElementById('feeder-filter').value,
        zip:           document.getElementById('zip-filter').value.trim(),
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

async function refilter() {
    refiltering = true;
    try {
        const hasFilter = selectedSpecies ||
            document.getElementById('rarity-filter').value ||
            document.getElementById('feeder-filter').value ||
            document.getElementById('zip-filter').value.trim() ||
            (document.getElementById('search-input')?.value || '').trim() ||
            favoritesOnly;
        if (hasFilter && !feedExhausted) {
            // Load all data so filtered results are complete
            document.getElementById('feed-view').innerHTML =
                '<div class="feed-loading">Loading all detections…</div>';
            await loadAllDetections();
        }
        // Ensure reaction data is loaded when sorting by most liked or filtering by My Likes
        const sortOrder = document.getElementById('sort-filter')?.value;
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
        if (currentView === 'stats')   renderFullStats();
    } finally {
        refiltering = false;
    }
}

// ── Near me (ZIP from geolocation) ───────────────────────
function useMyLocation() {
    if (!navigator.geolocation) { alert('Geolocation is not supported by your browser.'); return; }
    const btn = document.getElementById('near-me-btn');
    btn.disabled = true;
    btn.textContent = '📍 Locating…';
    navigator.geolocation.getCurrentPosition(
        async pos => {
            const { latitude, longitude } = pos.coords;
            try {
                const res  = await fetch(`https://api.zippopotam.us/us/${latitude.toFixed(4)},${longitude.toFixed(4)}`).catch(() => null);
                // zippopotam doesn't support reverse geocoding; use a free reverse-geocode API
                const res2 = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
                const data = await res2.json();
                const zip  = data?.address?.postcode?.split('-')[0];
                if (zip) {
                    document.getElementById('zip-filter').value = zip;
                    refilter();
                } else {
                    alert('Could not determine ZIP code for your location.');
                }
            } catch {
                alert('Could not determine ZIP code for your location.');
            }
            btn.disabled = false;
            btn.textContent = '📍 Near me';
        },
        () => {
            alert('Location access denied.');
            btn.disabled = false;
            btn.textContent = '📍 Near me';
        },
        { timeout: 8000 }
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
    const { feeder, zip, species, rarity, search, favoritesOnly } = getFilters();
    return data.filter(d => {
        if (species       && d.species               !== species) return false;
        if (rarity        && d.rarity                !== rarity)  return false;
        if (feeder        && d.feeders?.display_name !== feeder)  return false;
        if (zip           && d.zip_code              !== zip)      return false;
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
        const url = `${SUPABASE_URL}/rest/v1/community_detections?select=id,species,detected_at&detected_at=gte.${encodeURIComponent(yearStart)}&order=detected_at.asc&limit=10000`;
        const res = await fetch(url, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
        });
        if (!res.ok) return;
        const rows = await res.json();
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
let   feedOffset = 0;
let   feedExhausted = false;
let   feedLoading   = false;
let   refiltering   = false;

// Deduplicate allDetections by ID (handles race between infinite scroll and filter loading)
function deduplicateDetections() {
    const seen = new Set();
    allDetections = allDetections.filter(d => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
    });
}

async function loadFeed(append = false) {
    if (refiltering) return;   // don't auto-refresh while a filter is being applied
    if (append && (feedExhausted || feedLoading)) return;
    feedLoading = true;

    const indicator = document.getElementById('refresh-indicator');
    if (!append) {
        indicator.classList.add('refreshing');
        document.getElementById('countdown').textContent = 'Refreshing…';
        feedOffset = 0;
        feedExhausted = false;
    }

    const { period } = getFilters();
    const since = periodToISO(period);

    let url = `${SUPABASE_URL}/rest/v1/community_detections?select=*,feeders(display_name)&limit=${PAGE_SIZE}&offset=${feedOffset}&order=detected_at.desc`;
    if (since) url += `&detected_at=gte.${encodeURIComponent(since)}`;

    try {
        const res = await fetch(url, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = await res.json();

        if (append) {
            allDetections = [...allDetections, ...page];
            deduplicateDetections();
        } else {
            allDetections = page;
        }
        if (page.length < PAGE_SIZE) feedExhausted = true;
        feedOffset += page.length;

        if (!append) loadSeasonEarliest(); // refresh first-of-season cache
        populateFeederDropdown(allDetections);
        populateFeedSpeciesDropdown(allDetections);
        populateMapSpeciesDropdown(allDetections);

        // If active filters or sorting by most liked, load all detections so results are complete.
        // The stats and gallery views also need the full dataset — otherwise switching the period
        // while on those views would render with only the first PAGE_SIZE rows.
        const sortOrder = document.getElementById('sort-filter')?.value || 'recent';
        const hasActiveFilter = selectedSpecies ||
            document.getElementById('rarity-filter').value ||
            document.getElementById('feeder-filter').value ||
            document.getElementById('zip-filter').value.trim() ||
            (document.getElementById('search-input')?.value || '').trim() ||
            favoritesOnly;
        const needsAll = sortOrder === 'liked' || sortOrder === 'commented' || hasActiveFilter ||
            currentView === 'stats' || currentView === 'gallery';
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
        if (currentView === 'stats')   renderFullStats();
        if (typeof refreshSlideshowPhotos === 'function') refreshSlideshowPhotos();
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
        if (REFRESH_SECS > 0) {
            countdown = REFRESH_SECS;
        } else {
            document.getElementById('countdown').textContent = 'Auto-refresh off';
        }
        // Fetch all species/feeder names so dropdowns are complete
        loadAllDropdownOptions();
    }
}

// ── Load all species/feeder names for complete dropdowns ──
let dropdownsReady = false;
let totalDetectionCount = null;   // total from lightweight query

function updateFeedCount() {
    const countEl = document.getElementById('feed-count');
    const visible = applyClientFilters(allDetections);
    if (!dropdownsReady && totalDetectionCount === null) {
        countEl.innerHTML = `<span class="loading-count">${visible.length} detections — loading all…</span>`;
    } else if (totalDetectionCount !== null && !feedExhausted) {
        countEl.textContent = `${visible.length} of ${totalDetectionCount} detections`;
    } else {
        countEl.textContent = visible.length ? `${visible.length} detection${visible.length !== 1 ? 's' : ''}` : '';
    }
}

async function loadAllDropdownOptions() {
    dropdownsReady = false;
    totalDetectionCount = null;
    const specSel = document.getElementById('species-filter');

    // Show loading state
    updateFeedCount();
    specSel.innerHTML = '<option value="">Loading species…</option>';
    specSel.disabled = true;

    const { period } = getFilters();
    const since = periodToISO(period);
    // Use Prefer: count=exact header to get total count, and a high limit to fetch all rows
    let url = `${SUPABASE_URL}/rest/v1/community_detections?select=species,feeders(display_name)&order=species&limit=50000`;
    if (since) url += `&detected_at=gte.${encodeURIComponent(since)}`;
    try {
        const res = await fetch(url, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }
        });
        if (!res.ok) return;
        const rows = await res.json();
        totalDetectionCount = rows.length;
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
    if (entries[0].isIntersecting && currentView === 'feed') loadFeed(true);
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

