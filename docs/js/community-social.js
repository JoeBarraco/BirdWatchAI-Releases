// BirdWatchAI Community Feed - Social (reactions, gallery, slideshow, UI helpers)
// ── Filter event wiring ──────────────────────────────────
document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadFeed();
    });
});

document.getElementById('rarity-filter').addEventListener('change', () => refilter());
document.getElementById('feeder-filter').addEventListener('change', () => refilter());

let zipDebounce;
document.getElementById('zip-filter').addEventListener('input', () => {
    clearTimeout(zipDebounce);
    zipDebounce = setTimeout(() => refilter(), 400);
});

let searchDebounce;
document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => refilter(), 300);
});

function clearFilters() {
    clearStatsContext();
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.period-btn[data-period=""]').classList.add('active');
    selectedSpecies = '';
    document.getElementById('species-filter').value = '';
    document.getElementById('rarity-filter').value  = '';
    document.getElementById('feeder-filter').value  = '';
    document.getElementById('zip-filter').value     = '';
    document.getElementById('search-input').value   = '';
    document.getElementById('sort-filter').value   = 'recent';
    favoritesOnly = false;
    document.getElementById('fav-toggle').classList.remove('active');
    loadFeed();
}

// ── Auto-refresh ─────────────────────────────────────────
function fmtCountdown(secs) {
    if (secs >= 60) {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    return `${secs}s`;
}

function changeRefreshInterval(val) {
    REFRESH_SECS = parseInt(val, 10);
    localStorage.setItem('bwai-refresh-interval', REFRESH_SECS);
    if (REFRESH_SECS > 0) {
        countdown = REFRESH_SECS;
        document.getElementById('countdown').textContent = `Refreshing in ${fmtCountdown(countdown)}`;
    } else {
        document.getElementById('countdown').textContent = 'Auto-refresh off';
    }
}

// Restore saved interval on load
(function initRefreshSelect() {
    const sel = document.getElementById('refresh-interval');
    if (sel) {
        const saved = String(REFRESH_SECS);
        const opt = sel.querySelector(`option[value="${saved}"]`);
        if (opt) { sel.value = saved; }
    }
    const cdEl = document.getElementById('countdown');
    if (REFRESH_SECS === 0) {
        cdEl.textContent = 'Auto-refresh off';
    } else {
        cdEl.textContent = `Refreshing in ${countdown}s`;
    }
})();

setInterval(() => {
    if (REFRESH_SECS === 0) return;  // auto-refresh disabled
    if (document.hidden) return;     // don't tick while tab is hidden
    countdown--;
    if (countdown <= 0) {
        loadFeed();
    } else {
        document.getElementById('countdown').textContent = `Refreshing in ${fmtCountdown(countdown)}`;
    }
}, 1000);

// When user returns to tab, refresh immediately if overdue
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && tabHiddenAt !== null) {
        const secondsAway = (Date.now() - tabHiddenAt) / 1000;
        tabHiddenAt = null;
        if (REFRESH_SECS > 0 && secondsAway >= REFRESH_SECS) loadFeed();
    } else if (document.hidden) {
        tabHiddenAt = Date.now();
    }
});

// ── Scroll lock helpers (shared by all modals) ─────────
function lockScroll() {
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
}
function unlockScroll() {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
}

// ── Lightbox ─────────────────────────────────────────────
const lightbox     = document.getElementById('lightbox');
const lightboxImg  = document.getElementById('lightbox-img');

function openLightbox(src, alt) {
    lightboxImg.src = src;
    lightboxImg.alt = alt || '';
    lightbox.classList.add('open');
    lockScroll();
}
function closeLightbox() {
    lightbox.classList.remove('open');
    unlockScroll();
}

lightbox.addEventListener('click', closeLightbox);
lightboxImg.addEventListener('click', e => e.stopPropagation());
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);

// ── Inline video player ─────────────────────────────────
// Plays detection videos in a modal rather than navigating away,
// so the moderator (sessionStorage-backed) session isn't disrupted
// on platforms that hand direct media URLs off to the OS player.
const videoModal  = document.getElementById('video-modal');
const videoPlayer = document.getElementById('video-modal-player');

function openVideoPlayer(src) {
    if (!src) return;
    videoPlayer.src = src;
    videoModal.classList.add('open');
    lockScroll();
    // Best-effort autoplay; ignore rejection (e.g. mobile gesture policy)
    const p = videoPlayer.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
}
function closeVideoPlayer() {
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    videoModal.classList.remove('open');
    unlockScroll();
}
videoModal.addEventListener('click', e => {
    if (e.target === videoModal) closeVideoPlayer();
});
videoPlayer.addEventListener('click', e => e.stopPropagation());
document.getElementById('video-modal-close').addEventListener('click', closeVideoPlayer);
// Intercept any element marked as a video play link
document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-video-play]');
    if (trigger) {
        e.preventDefault();
        openVideoPlayer(trigger.getAttribute('data-video-play'));
    }
});

// Delegate clicks on feed cards
document.getElementById('feed-view').addEventListener('click', e => {
    // Image → lightbox
    if (e.target.tagName === 'IMG' && e.target.closest('.card')) {
        openLightbox(e.target.src, e.target.alt);
        return;
    }
    // AI Research button
    const aiBtn = e.target.closest('.card-ai');
    if (aiBtn) { openAIResearch(aiBtn.dataset.aiSpecies); return; }
    // Share button
    const shareBtn = e.target.closest('[data-share-id]');
    if (shareBtn) { shareDetection(shareBtn.dataset.shareId, shareBtn.closest('.card')); return; }
    // Audio button
    const audioBtn = e.target.closest('[data-audio-species]');
    if (audioBtn) {
        if (audioBtn.classList.contains('playing')) {
            stopBirdCall(audioBtn);
        } else {
            playBirdCall(audioBtn.dataset.audioSpecies, audioBtn);
        }
        return;
    }
    // Reaction button
    const rxBtn = e.target.closest('[data-reaction-id]');
    if (rxBtn) { toggleReaction(rxBtn.dataset.reactionId, rxBtn.dataset.emoji, rxBtn); return; }
    // Species name → photo carousel
    const speciesLink = e.target.closest('.species-link');
    if (speciesLink) { openCarousel(speciesLink.dataset.species); return; }
    // Card body (not a button/link) → detail modal
    const card = e.target.closest('.card');
    if (card && !e.target.closest('button, a')) {
        openDetailModal(card.dataset.id);
        return;
    }
});

// ── Bird call audio (xeno-canto) ─────────────────────────
const audioCache = {};
let currentAudio = null;

async function playBirdCall(species, btn) {
    if (!species) return;
    if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; currentAudio = null; }
    document.querySelectorAll('.card-audio.playing').forEach(b => { b.classList.remove('playing'); b.textContent = '🔊 Call'; });

    btn.classList.add('loading');
    try {
        if (!audioCache[species]) {
            const q   = encodeURIComponent(species);
            const res = await fetch(`https://xeno-canto.org/api/2/recordings?query=${q}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const rec  = data.recordings?.[0];
            if (!rec?.file) {
                btn.classList.remove('loading');
                showToast('No audio available for this species');
                return;
            }
            audioCache[species] = (rec.file.startsWith('http') ? '' : 'https:') + rec.file;
        }
        const audio = new Audio(audioCache[species]);
        currentAudio = audio;
        btn.classList.remove('loading');
        btn.classList.add('playing');
        btn.textContent = '⏹ Stop';
        audio.play();
        audio.addEventListener('ended', () => { btn.classList.remove('playing'); btn.textContent = '🔊 Call'; currentAudio = null; });
        audio.addEventListener('error', () => { btn.classList.remove('playing', 'loading'); btn.textContent = '🔊 Call'; showToast('Could not load audio'); });
    } catch (_) {
        btn.classList.remove('loading', 'playing');
        btn.textContent = '🔊 Call';
        showToast('Could not load bird call audio');
    }
}

function stopBirdCall(btn) {
    if (currentAudio) { currentAudio.pause(); currentAudio.currentTime = 0; currentAudio = null; }
    btn.classList.remove('playing');
    btn.textContent = '🔊 Call';
}

// ── Emoji reactions (Supabase-backed, shared across users) ──
const EMOJI_MAP = { '❤️': 'liked' };
const EMOJI_REVERSE = { 'liked': '❤️' };
const EMOJI_LIST = ['❤️'];

// Returns the user ID to use for reactions — real auth ID if signed in, else anon
function getReactionUserId() {
    if (currentUser && currentUser.id) return currentUser.id;
    let id = localStorage.getItem('bwai-user-id');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('bwai-user-id', id);
    }
    return id;
}

// In-memory cache of reaction data: { detectionId: { emojiKey: { count, reacted } } }
let reactionCache = {};
// Totals cache for sorting: { detectionId: totalCount }
let reactionTotals = {};

function getReactions(detectionId) {
    // Returns { emoji: count } for display, where emoji is the actual emoji character
    const data = reactionCache[detectionId] || {};
    const result = {};
    for (const [key, info] of Object.entries(data)) {
        const emoji = EMOJI_REVERSE[key];
        if (emoji) result[emoji] = info.count;
    }
    return result;
}

function isReacted(detectionId, emoji) {
    const key = EMOJI_MAP[emoji];
    return reactionCache[detectionId]?.[key]?.reacted || false;
}

function hasUserReaction(detectionId) {
    const data = reactionCache[detectionId];
    if (!data) return false;
    return Object.values(data).some(info => info.reacted);
}

function getReactionTotal(detectionId) {
    return reactionTotals[detectionId] || 0;
}

async function loadReactionCounts(detectionIds) {
    if (!detectionIds.length) return;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_reaction_counts`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_detection_ids: detectionIds, p_user_id: getReactionUserId() }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && typeof data === 'object') {
            Object.assign(reactionCache, data);
            // Update totals
            for (const [did, emojis] of Object.entries(data)) {
                let total = 0;
                for (const info of Object.values(emojis)) total += info.count;
                reactionTotals[did] = total;
            }
        }
    } catch (_) { /* silently fail — reactions are non-critical */ }
}

async function loadReactionTotals() {
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_reaction_totals`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && typeof data === 'object') {
            reactionTotals = {};
            for (const [did, total] of Object.entries(data)) {
                reactionTotals[did] = total;
            }
        }
    } catch (_) { /* silently fail */ }
}

async function toggleReaction(detectionId, emoji, btn) {
    const emojiKey = EMOJI_MAP[emoji];
    if (!emojiKey) return;

    // Require signed-in user
    if (!currentUser) {
        showToast('Sign in to like detections');
        openUserLogin();
        return;
    }

    // Optimistic UI update
    const wasReacted = btn.classList.contains('reacted');
    const cached = reactionCache[detectionId]?.[emojiKey];
    const oldCount = cached?.count || 0;
    const newCount = wasReacted ? Math.max(0, oldCount - 1) : oldCount + 1;

    if (!reactionCache[detectionId]) reactionCache[detectionId] = {};
    reactionCache[detectionId][emojiKey] = { count: newCount, reacted: !wasReacted };

    // Update totals
    const oldTotal = reactionTotals[detectionId] || 0;
    reactionTotals[detectionId] = wasReacted ? Math.max(0, oldTotal - 1) : oldTotal + 1;

    btn.classList.toggle('reacted', !wasReacted);
    btn.textContent = emoji + (newCount ? ' ' + newCount : '');

    // Server call
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/toggle_reaction`, {
            method: 'POST',
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_detection_id: detectionId, p_user_id: getReactionUserId(), p_emoji: emojiKey }),
        });
        if (res.ok) {
            const serverData = await res.json();
            if (serverData && typeof serverData === 'object') {
                reactionCache[detectionId] = serverData;
                // Recalculate total
                let total = 0;
                for (const info of Object.values(serverData)) total += info.count;
                reactionTotals[detectionId] = total;
                // Re-render this card's reaction buttons from server truth
                updateCardReactions(detectionId);
            }
        }
    } catch (_) { /* keep optimistic state */ }
}

function updateCardReactions(detectionId) {
    document.querySelectorAll(`[data-reaction-id="${detectionId}"]`).forEach(btn => {
        const emoji = btn.dataset.emoji;
        const emojiKey = EMOJI_MAP[emoji];
        const info = reactionCache[detectionId]?.[emojiKey];
        const count = info?.count || 0;
        const reacted = info?.reacted || false;
        btn.classList.toggle('reacted', reacted);
        btn.textContent = emoji + (count ? ' ' + count : '');
    });
}

// ── "Liked by" popover ──────────────────────────────────────
let likersCache = {};

async function showLikers(detectionId, anchor) {
    // Close any existing popover
    const existing = document.getElementById('likers-popover');
    if (existing) { existing.remove(); return; }

    const popover = document.createElement('div');
    popover.id = 'likers-popover';
    popover.className = 'likers-popover';
    popover.innerHTML = '<div class="likers-loading">Loading…</div>';
    anchor.style.position = 'relative';
    anchor.appendChild(popover);

    // Close on outside click
    const closeHandler = e => {
        if (!popover.contains(e.target) && e.target !== anchor) {
            popover.remove();
            document.removeEventListener('click', closeHandler, true);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);

    try {
        // Fetch reaction records for this detection
        const rxRes = await fetch(
            `${SUPABASE_URL}/rest/v1/detection_reactions?detection_id=eq.${detectionId}&emoji=eq.liked&select=user_id,created_at&order=created_at.desc`,
            { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
        );
        if (!rxRes.ok) throw new Error('fetch failed');
        const reactions = await rxRes.json();

        if (!reactions.length) {
            popover.innerHTML = '<div class="likers-empty">No likes yet</div>';
            return;
        }

        // Fetch user profiles for the user IDs
        const userIds = [...new Set(reactions.map(r => r.user_id))];
        const profileRes = await fetch(
            `${SUPABASE_URL}/rest/v1/user_profiles?id=in.(${userIds.map(id => `"${id}"`).join(',')})&select=id,display_name`,
            { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
        );
        const profiles = profileRes.ok ? await profileRes.json() : [];
        const nameMap = {};
        profiles.forEach(p => { nameMap[p.id] = p.display_name; });

        // Build list
        const names = reactions.map(r => nameMap[r.user_id] || null).filter(Boolean);
        const anonCount = reactions.length - names.length;

        let html = '<div class="likers-list">';
        if (names.length) {
            html += names.map(n => `<div class="liker-name">❤️ ${n}</div>`).join('');
        }
        if (anonCount > 0) {
            html += `<div class="liker-anon">${anonCount} anonymous like${anonCount > 1 ? 's' : ''}</div>`;
        }
        html += '</div>';
        popover.innerHTML = html;
    } catch {
        popover.innerHTML = '<div class="likers-empty">Could not load likes</div>';
    }
}

// ── Gallery view ────────────────────────────────────────────
async function loadAllThenRenderGallery() {
    if (!feedExhausted) {
        document.getElementById('gallery-grid').innerHTML =
            '<div class="feed-loading" style="grid-column:1/-1;">Loading all detections…</div>';
        await loadAllDetections();
    }
    renderGallery();
}

function buildGalleryData() {
    const visible = applyClientFilters(allDetections);
    const speciesMap = {};
    for (const d of visible) {
        if (!d.species) continue;
        if (!speciesMap[d.species]) {
            speciesMap[d.species] = { species: d.species, photos: [], lastSeen: d.detected_at, rarity: d.rarity };
        }
        const entry = speciesMap[d.species];
        if (d.image_url) entry.photos.push({ id: d.id, url: d.image_url, date: d.detected_at, species: d.species });
        if (d.detected_at > entry.lastSeen) entry.lastSeen = d.detected_at;
        // Keep highest rarity
        if (!entry.rarity && d.rarity) entry.rarity = d.rarity;
        if (d.rarity === 'Very Rare') entry.rarity = 'Very Rare';
        else if (d.rarity === 'Rare' && entry.rarity !== 'Very Rare') entry.rarity = 'Rare';
    }
    return Object.values(speciesMap).filter(s => s.photos.length > 0);
}

// Fisher–Yates, mutates + returns the input array.
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Sum reaction totals across all photos of a species.
function speciesLikeTotal(s) {
    let total = 0;
    for (const p of s.photos) total += getReactionTotal(p.id) || 0;
    return total;
}

async function onGallerySortChange() {
    const sort = document.getElementById('gallery-sort').value;
    // Ensure reaction totals are available before sorting by likes.
    if (sort === 'liked') await loadReactionTotals();
    renderGallery();
}

function renderGallery() {
    const species = buildGalleryData();
    const sort = document.getElementById('gallery-sort').value;
    if (sort === 'count')  species.sort((a, b) => b.photos.length - a.photos.length);
    if (sort === 'alpha')  species.sort((a, b) => a.species.localeCompare(b.species));
    if (sort === 'recent') species.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    if (sort === 'liked')  species.sort((a, b) => speciesLikeTotal(b) - speciesLikeTotal(a));
    if (sort === 'random') shuffleArray(species);

    const grid = document.getElementById('gallery-grid');
    if (!species.length) {
        grid.innerHTML = '<div class="feed-empty" style="grid-column:1/-1;">No photos match your filters.</div>';
        return;
    }
    grid.innerHTML = species.map(s => {
        const rarityClass = s.rarity ? 'rarity-' + s.rarity.toLowerCase().replace(/\s+/g, '-') : '';
        return `
        <div class="gallery-card" data-gallery-species="${esc(s.species)}">
            <img src="${s.photos[0].url}" alt="${esc(s.species)}" loading="lazy">
            <span class="gallery-card-badge">${s.photos.length} photo${s.photos.length !== 1 ? 's' : ''}</span>
            <div class="gallery-card-info">
                <div class="gallery-card-species">${esc(s.species)}</div>
                <div class="gallery-card-meta">
                    Last seen ${fmtDetectedAt(s.lastSeen)}${s.rarity ? ` · <span class="${rarityClass}">${esc(s.rarity)}</span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.gallery-card').forEach(card => {
        card.addEventListener('click', () => {
            const sp = card.dataset.gallerySpecies;
            const data = buildGalleryData().find(s => s.species === sp);
            if (data) openSlideshowForSpecies(data);
        });
    });
}

// ── Slideshow ────────────────────────────────────────────
const slideshowModal = document.getElementById('slideshow-modal');
const slideshowImgA  = document.getElementById('slideshow-img-a');
const slideshowImgB  = document.getElementById('slideshow-img-b');
let slideshowPhotos = [];
let slideshowIdx = 0;
let slideshowTimer = null;
let slideshowPaused = false;
const SLIDESHOW_INTERVAL = 4000; // ms per photo
let slideshowProgressRAF = null;
let slideshowSlideStart = 0;
let slideshowActiveSlot = 0; // 0 = A, 1 = B
let slideshowIdleTimer = null;
let slideshowSlideToken = 0; // increments on each showSlideshowSlide call
let slideshowSortMode = 'count';     // gallery-wide sort used to start the slideshow
let slideshowFilterSpecies = null;   // non-null when viewing a single species

const SLIDESHOW_TRANSITIONS = [
    { id: 'fade',     label: '✦ Fade'      },
    { id: 'slide',    label: '▸ Slide'     },
    { id: 'kenburns', label: '⊙ Ken Burns' },
    { id: 'blur',     label: '◌ Blur'      },
    { id: 'random',   label: '⟲ Random'    }
];
let slideshowTransitionIdx = 0;

function openSlideshowForSpecies(speciesData) {
    slideshowSortMode = null;
    slideshowFilterSpecies = speciesData.species;
    slideshowPhotos = speciesData.photos;
    startSlideshowPlayback();
}

async function startSlideshow() {
    const sort = document.getElementById('gallery-sort').value;
    slideshowSortMode = sort;
    slideshowFilterSpecies = null;
    // Ensure reaction totals are loaded when the user picked "Liked".
    if (sort === 'liked') await loadReactionTotals();

    const species = buildGalleryData();
    if (sort === 'count')  species.sort((a, b) => b.photos.length - a.photos.length);
    if (sort === 'alpha')  species.sort((a, b) => a.species.localeCompare(b.species));
    if (sort === 'recent') species.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    if (sort === 'liked')  species.sort((a, b) => speciesLikeTotal(b) - speciesLikeTotal(a));

    const all = [];
    for (const s of species) {
        for (const p of s.photos) all.push(p);
    }

    // Liked: drop photos with zero total reactions, order the rest by likes desc.
    if (sort === 'liked') {
        const withLikes = all.filter(p => (getReactionTotal(p.id) || 0) > 0);
        withLikes.sort((a, b) => getReactionTotal(b.id) - getReactionTotal(a.id));
        if (!withLikes.length) { showToast('No liked photos yet'); return; }
        slideshowPhotos = withLikes;
        startSlideshowPlayback();
        return;
    }

    // Random: shuffle the flat photo list for a true mix across species.
    if (sort === 'random') shuffleArray(all);

    if (!all.length) { showToast('No photos to show'); return; }
    slideshowPhotos = all;
    startSlideshowPlayback();
}

function startSlideshowPlayback() {
    slideshowIdx = 0;
    slideshowPaused = false;
    slideshowActiveSlot = 0;
    // Reset slide slots to a known clean state
    [slideshowImgA, slideshowImgB].forEach(el => {
        el.className = 'slideshow-slide';
        el.removeAttribute('src');
    });
    document.getElementById('slideshow-playpause').textContent = '⏸';
    slideshowModal.classList.add('open');
    lockScroll();
    showSlideshowSlide(0);
    startSlideshowTimer();
    requestSlideshowFullscreen();
    bumpSlideshowIdle();
}

function showSlideshowSlide(direction) {
    const photo = slideshowPhotos[slideshowIdx];
    if (!photo) return;

    const myToken = ++slideshowSlideToken;

    // If the user picked "random", roll a fresh transition for this slide.
    if (SLIDESHOW_TRANSITIONS[slideshowTransitionIdx].id === 'random') {
        const pool = SLIDESHOW_TRANSITIONS.filter(t => t.id !== 'random');
        slideshowModal.dataset.transition = pool[Math.floor(Math.random() * pool.length)].id;
    }

    document.getElementById('slideshow-caption').textContent = photo.species || '';
    document.getElementById('slideshow-counter').textContent =
        `${slideshowIdx + 1} / ${slideshowPhotos.length}`;

    const transition = slideshowModal.dataset.transition || 'fade';
    const slots = [slideshowImgA, slideshowImgB];
    const currentImg = slots[slideshowActiveSlot];
    const nextImg    = slots[1 - slideshowActiveSlot];

    const commit = () => {
        if (myToken !== slideshowSlideToken) return; // superseded by a newer call
        // Reset any leftover transition classes on the incoming slide
        nextImg.className = 'slideshow-slide';
        nextImg.alt = photo.species || '';

        if (transition === 'slide' && direction) {
            // Position the incoming slide off-screen, then animate it in.
            nextImg.classList.add(direction > 0 ? 'from-right' : 'from-left');
            // Force layout so the starting transform is applied
            void nextImg.offsetWidth;
            nextImg.classList.remove('from-right', 'from-left');
            nextImg.classList.add('active');
            currentImg.classList.remove('active');
            currentImg.classList.add(direction > 0 ? 'exit-left' : 'exit-right');
        } else {
            // Crossfade (fade / kenburns / blur)
            nextImg.classList.add('active');
            currentImg.classList.remove('active');
        }

        slideshowActiveSlot = 1 - slideshowActiveSlot;
    };

    // Preload before swapping so the crossfade reveals a fully-loaded image.
    const pre = new Image();
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        if (myToken !== slideshowSlideToken) return; // stale
        nextImg.src = photo.url;
        requestAnimationFrame(commit);
    };
    pre.onload = finish;
    pre.onerror = finish;
    pre.src = photo.url;
    // Safety net in case the browser never fires load/error
    setTimeout(finish, 1200);
}

function startSlideshowTimer() {
    clearTimeout(slideshowTimer);
    cancelAnimationFrame(slideshowProgressRAF);
    if (slideshowPaused) {
        document.getElementById('slideshow-progress-fill').style.width = '0%';
        return;
    }
    slideshowSlideStart = performance.now();
    function tick() {
        const elapsed = performance.now() - slideshowSlideStart;
        const pct = Math.min(100, (elapsed / SLIDESHOW_INTERVAL) * 100);
        document.getElementById('slideshow-progress-fill').style.width = pct + '%';
        if (pct < 100) slideshowProgressRAF = requestAnimationFrame(tick);
    }
    tick();
    slideshowTimer = setTimeout(() => {
        slideshowIdx = (slideshowIdx + 1) % slideshowPhotos.length;
        showSlideshowSlide(1);
        startSlideshowTimer();
    }, SLIDESHOW_INTERVAL);
}

function toggleSlideshowPause() {
    slideshowPaused = !slideshowPaused;
    document.getElementById('slideshow-playpause').textContent = slideshowPaused ? '▶' : '⏸';
    if (!slideshowPaused) startSlideshowTimer();
    else {
        clearTimeout(slideshowTimer);
        cancelAnimationFrame(slideshowProgressRAF);
        document.getElementById('slideshow-progress-fill').style.width = '0%';
    }
    bumpSlideshowIdle();
}

function slideshowNav(dir) {
    slideshowIdx = (slideshowIdx + dir + slideshowPhotos.length) % slideshowPhotos.length;
    showSlideshowSlide(dir);
    if (!slideshowPaused) startSlideshowTimer();
    bumpSlideshowIdle();
}

function cycleSlideshowTransition() {
    slideshowTransitionIdx = (slideshowTransitionIdx + 1) % SLIDESHOW_TRANSITIONS.length;
    const mode = SLIDESHOW_TRANSITIONS[slideshowTransitionIdx];
    // For 'random', leave a harmless default in place; showSlideshowSlide
    // will roll a fresh pick on the next slide change.
    if (mode.id !== 'random') slideshowModal.dataset.transition = mode.id;
    const btn = document.getElementById('slideshow-transition-btn');
    if (btn) btn.textContent = mode.label;
    bumpSlideshowIdle();
}

// Fullscreen helpers (with webkit prefix for Safari)
function isSlideshowFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function requestSlideshowFullscreen() {
    const el = slideshowModal;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req && !isSlideshowFullscreen()) {
        try { req.call(el).catch(() => {}); } catch (_) { /* user-gesture required; ignore */ }
    }
}
function exitSlideshowFullscreen() {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex && isSlideshowFullscreen()) {
        try { ex.call(document).catch(() => {}); } catch (_) { /* ignore */ }
    }
}
function toggleSlideshowFullscreen() {
    if (isSlideshowFullscreen()) exitSlideshowFullscreen();
    else requestSlideshowFullscreen();
    bumpSlideshowIdle();
}

function bumpSlideshowIdle() {
    slideshowModal.classList.remove('idle');
    clearTimeout(slideshowIdleTimer);
    slideshowIdleTimer = setTimeout(() => {
        if (slideshowModal.classList.contains('open') && !slideshowPaused) {
            slideshowModal.classList.add('idle');
        }
    }, 2500);
}

function closeSlideshow() {
    if (!slideshowModal.classList.contains('open')) return;
    slideshowModal.classList.remove('open', 'idle');
    clearTimeout(slideshowTimer);
    clearTimeout(slideshowIdleTimer);
    cancelAnimationFrame(slideshowProgressRAF);
    exitSlideshowFullscreen();
    unlockScroll();
}

document.getElementById('slideshow-close').addEventListener('click', closeSlideshow);

// Silently merge new detections into a running slideshow after a feed refresh
function refreshSlideshowPhotos() {
    if (!slideshowModal.classList.contains('open')) return;
    if (!slideshowPhotos.length) return;

    const currentId = slideshowPhotos[slideshowIdx]?.id;
    const sort = slideshowSortMode;

    let newPhotos;

    if (slideshowFilterSpecies) {
        // Species-specific slideshow — only include photos of that species
        const visible = applyClientFilters(allDetections);
        newPhotos = visible
            .filter(d => d.species === slideshowFilterSpecies && d.image_url)
            .map(d => ({ id: d.id, url: d.image_url, date: d.detected_at, species: d.species }));
        if (!newPhotos.length) return;
    } else if (sort === 'liked') {
        const species = buildGalleryData();
        const all = [];
        for (const s of species) for (const p of s.photos) all.push(p);
        newPhotos = all.filter(p => (getReactionTotal(p.id) || 0) > 0);
        newPhotos.sort((a, b) => getReactionTotal(b.id) - getReactionTotal(a.id));
        if (!newPhotos.length) return;
    } else {
        const species = buildGalleryData();
        if (sort === 'count')  species.sort((a, b) => b.photos.length - a.photos.length);
        if (sort === 'alpha')  species.sort((a, b) => a.species.localeCompare(b.species));
        if (sort === 'recent') species.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
        const all = [];
        for (const s of species) for (const p of s.photos) all.push(p);
        if (!all.length) return;

        if (sort === 'random') {
            // Keep existing order, append only genuinely new photos
            const existingIds = new Set(slideshowPhotos.map(p => p.id));
            const added = all.filter(p => !existingIds.has(p.id));
            if (!added.length) return;
            shuffleArray(added);
            // Insert new photos after the current position so they appear naturally
            slideshowPhotos.splice(slideshowIdx + 1, 0, ...added);
            document.getElementById('slideshow-counter').textContent =
                `${slideshowIdx + 1} / ${slideshowPhotos.length}`;
            return;
        }

        newPhotos = all;
    }

    // Check if anything actually changed
    if (newPhotos.length === slideshowPhotos.length &&
        newPhotos.every((p, i) => p.id === slideshowPhotos[i].id)) return;

    slideshowPhotos = newPhotos;

    // Restore position to the photo we were showing
    if (currentId) {
        const newIdx = slideshowPhotos.findIndex(p => p.id === currentId);
        slideshowIdx = newIdx >= 0 ? newIdx : Math.min(slideshowIdx, slideshowPhotos.length - 1);
    }

    document.getElementById('slideshow-counter').textContent =
        `${slideshowIdx + 1} / ${slideshowPhotos.length}`;
}
document.getElementById('slideshow-prev').addEventListener('click', () => slideshowNav(-1));
document.getElementById('slideshow-next').addEventListener('click', () => slideshowNav(1));
// Reveal chrome on any pointer activity inside the modal
slideshowModal.addEventListener('mousemove', bumpSlideshowIdle);
slideshowModal.addEventListener('touchstart', bumpSlideshowIdle, { passive: true });

// Keep the fullscreen button icon in sync when the user exits via Esc, etc.
function syncFullscreenButton() {
    const btn = document.getElementById('slideshow-fullscreen-btn');
    if (!btn) return;
    btn.textContent = isSlideshowFullscreen() ? '⤢' : '⛶';
}
document.addEventListener('fullscreenchange', syncFullscreenButton);
document.addEventListener('webkitfullscreenchange', syncFullscreenButton);

// Arrow keys for slideshow navigation
document.addEventListener('keydown', e => {
    if (!slideshowModal.classList.contains('open')) return;
    if (e.key === 'ArrowLeft')  { slideshowNav(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { slideshowNav(1);  e.preventDefault(); }
    if (e.key === ' ')          { toggleSlideshowPause(); e.preventDefault(); }
    if (e.key === 'f' || e.key === 'F') { toggleSlideshowFullscreen(); e.preventDefault(); }
    if (e.key === 't' || e.key === 'T') { cycleSlideshowTransition(); e.preventDefault(); }
});

// ── Species photo carousel ────────────────────────────────
const carouselModal = document.getElementById('carousel-modal');

function closeCarousel() {
    carouselModal.classList.remove('open');
    unlockScroll();
}

document.getElementById('carousel-close').addEventListener('click', closeCarousel);
carouselModal.addEventListener('click', e => { if (e.target === carouselModal) closeCarousel(); });

function openCarousel(species) {
    if (!species) return;
    const photos = allDetections.filter(d => d.species === species && d.image_url);
    document.getElementById('carousel-title').textContent = `📸 ${species} — ${photos.length} photo${photos.length !== 1 ? 's' : ''}`;
    const grid = document.getElementById('carousel-grid');
    if (!photos.length) {
        grid.innerHTML = '<p class="carousel-empty">No photos found for this species.</p>';
    } else {
        grid.innerHTML = photos.map(d =>
            `<img src="${d.image_url}" alt="${esc(d.species)}" loading="lazy" title="${fmtDetectedAt(d.detected_at)}">`
        ).join('');
        // Clicking a carousel photo opens the full lightbox
        grid.querySelectorAll('img').forEach(img => img.addEventListener('click', () => {
            closeCarousel();
            openLightbox(img.src, img.alt);
        }));
    }
    carouselModal.classList.add('open');
    lockScroll();
}

// ── Liked Detections (Stats tab) ─────────────────────────
let likesResortTimer = null;
let likesPollInterval = null;
let lastLikesSignature = '';

function likesSignature(rows) {
    return rows.map(r => `${r.d.id}:${r.wow}:${r.liked}:${r.celebrate}:${r.bird}`).join('|');
}

function buildLikesRows() {
    const visible = applyClientFilters(allDetections);
    return visible.map(d => {
        const data = reactionCache[d.id] || {};
        const liked     = data.liked?.count || 0;
        return { d, liked, total: liked };
    }).filter(r => r.total > 0)
      .sort((a, b) => b.total - a.total);
}

function likesRowHtml(r, rank) {
    const rarityClass = r.d.rarity ? 'rarity-' + r.d.rarity.toLowerCase().replace(/\s+/g, '-') : '';
    const photoBtn = r.d.image_url
        ? `<img src="${r.d.image_url}" alt="${esc(r.d.species)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;cursor:pointer;vertical-align:middle;" onclick="openLightbox('${r.d.image_url}','${esc(r.d.species)}')">`
        : '';
    const videoBtn = r.d.video_url
        ? `<a href="${r.d.video_url}" data-video-play="${r.d.video_url}" target="_blank" rel="noopener" title="Watch video" style="font-size:1.75rem;vertical-align:middle;text-decoration:none;">🎬</a>`
        : '';
    const rxBtn = (emoji, count) => {
        const reacted = isReacted(r.d.id, emoji);
        return `<button class="reaction-btn${reacted ? ' reacted' : ''}" data-reaction-id="${r.d.id}" data-emoji="${emoji}" style="font-size:0.85rem;padding:2px 6px;">${emoji}${count ? ' ' + count : ''}</button>`;
    };
    return `<tr data-likes-id="${r.d.id}">
        <td class="stats-rank likes-rank">${rank}</td>
        <td class="stats-species-name" style="white-space:nowrap;">${esc(r.d.species || 'Unknown')}${r.d.rarity
            ? ` <span class="rarity-badge ${rarityClass}">${esc(r.d.rarity)}</span>` : ''}</td>
        <td style="white-space:nowrap;">${r.d.feeders?.display_name ? esc(r.d.feeders.display_name) : ''}</td>
        <td>${r.d.zip_code ? esc(r.d.zip_code) : ''}</td>
        <td style="white-space:nowrap;">${fmtDetectedAt(r.d.detected_at)}</td>
        <td style="text-align:center;">${rxBtn('❤️', r.liked)}</td>
        <td class="likes-total" data-total="${r.total}" style="text-align:center;font-weight:600;">${r.total}</td>
        <td style="text-align:center;white-space:nowrap;">${photoBtn} ${videoBtn}</td>
    </tr>`;
}

function likesTableHtml(rows) {
    return `<table class="stats-table" style="table-layout:auto;">
        <thead><tr>
            <th class="stats-rank">#</th>
            <th>Species</th>
            <th>Feeder</th>
            <th>ZIP</th>
            <th>Detected</th>
            <th style="text-align:center;">❤️</th>
            <th style="text-align:center;">Total</th>
            <th style="text-align:center;">Media</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => likesRowHtml(r, i + 1)).join('')}</tbody>
    </table>`;
}

async function renderLikesPanel() {
    const panel = document.getElementById('stats-likes');
    panel.innerHTML = '<div class="feed-loading">Loading reaction data…</div>';

    if (!feedExhausted) await loadAllDetections();
    await loadReactionTotals();
    const ids = allDetections.map(d => d.id);
    if (ids.length) await loadReactionCounts(ids);

    const rows = buildLikesRows();
    if (rows.length === 0) {
        panel.innerHTML = '<div class="feed-empty">No reactions yet. Like some detections to see stats here!</div>';
        lastLikesSignature = '';
        return;
    }
    lastLikesSignature = likesSignature(rows);

    // Wire up click handler (event delegation)
    panel.onclick = (e) => {
        const rxBtn = e.target.closest('[data-reaction-id]');
        if (!rxBtn) return;
        toggleReaction(rxBtn.dataset.reactionId, rxBtn.dataset.emoji, rxBtn);
        // Update total cell in-place
        const row = rxBtn.closest('tr');
        if (row) {
            const countCells = row.querySelectorAll('[data-reaction-id]');
            let total = 0;
            countCells.forEach(btn => {
                const txt = btn.textContent.replace(/[^\d]/g, '');
                total += parseInt(txt, 10) || 0;
            });
            const totalCell = row.querySelector('.likes-total');
            if (totalCell) { totalCell.textContent = total; totalCell.dataset.total = total; }
        }
        // Debounce animated re-sort after 3s of inactivity
        clearTimeout(likesResortTimer);
        likesResortTimer = setTimeout(() => resortLikesPanel(), 3000);
    };

    panel.innerHTML = likesTableHtml(rows);
}

async function resortLikesPanel() {
    const panel = document.getElementById('stats-likes');
    const tbody = panel.querySelector('tbody');
    if (!tbody) return;

    // Ensure all detections are loaded (auto-refresh may have reset to page 1)
    if (!feedExhausted) await loadAllDetections();

    // Fetch fresh data from server (includes other users' reactions)
    await loadReactionTotals();
    const ids = allDetections.map(d => d.id);
    if (ids.length) await loadReactionCounts(ids);

    // Build new sorted rows
    const rows = buildLikesRows();
    if (rows.length === 0) {
        panel.innerHTML = '<div class="feed-empty">No reactions yet. Like some detections to see stats here!</div>';
        lastLikesSignature = '';
        return;
    }

    // Skip the DOM rebuild entirely when nothing has changed.
    // This is the common case on idle polls and eliminates the scroll jump
    // caused by tbody.innerHTML replacement + scroll anchor recalculation.
    const signature = likesSignature(rows);
    if (signature === lastLikesSignature) return;
    lastLikesSignature = signature;

    // Capture old positions and scores RIGHT BEFORE DOM change (after all async work)
    const scrollY = window.scrollY;
    const oldRows = tbody.querySelectorAll('tr[data-likes-id]');
    const oldPositions = {};
    const oldScores = {};
    oldRows.forEach(tr => {
        const id = tr.dataset.likesId;
        oldPositions[id] = tr.getBoundingClientRect();
        const totalCell = tr.querySelector('.likes-total');
        oldScores[id] = parseInt(totalCell?.dataset.total, 10) || 0;
    });

    // Replace tbody content
    tbody.innerHTML = rows.map((r, i) => likesRowHtml(r, i + 1)).join('');

    // Restore scroll position
    window.scrollTo(0, scrollY);

    // FLIP animation: move new rows from old positions
    const newRows = tbody.querySelectorAll('tr[data-likes-id]');
    newRows.forEach(tr => {
        const id = tr.dataset.likesId;
        const newRect = tr.getBoundingClientRect();

        if (oldPositions[id]) {
            const deltaY = oldPositions[id].top - newRect.top;
            if (Math.abs(deltaY) > 1) {
                // Invert: place at old position instantly
                tr.style.transform = `translateY(${deltaY}px)`;
                // Force layout so the browser registers the starting position
                tr.getBoundingClientRect();
                // Play: animate to final position
                tr.classList.add('likes-row-flip');
                tr.style.transform = '';
                tr.addEventListener('transitionend', () => {
                    tr.classList.remove('likes-row-flip');
                }, { once: true });
            }
        } else {
            // New row that wasn't in the table before
            tr.classList.add('likes-row-new');
            tr.addEventListener('animationend', () => tr.classList.remove('likes-row-new'), { once: true });
        }

        // Flash score cells that changed
        const newTotal = parseInt(tr.querySelector('.likes-total')?.dataset.total, 10) || 0;
        if (oldScores[id] !== undefined && oldScores[id] !== newTotal) {
            const totalCell = tr.querySelector('.likes-total');
            if (totalCell) {
                totalCell.classList.add('likes-score-changed');
                totalCell.addEventListener('animationend', () => totalCell.classList.remove('likes-score-changed'), { once: true });
            }
            // Also flash individual emoji cells that changed
            tr.querySelectorAll('[data-reaction-id]').forEach(btn => {
                btn.closest('td')?.classList.add('likes-score-changed');
                btn.closest('td')?.addEventListener('animationend', function() { this.classList.remove('likes-score-changed'); }, { once: true });
            });
        }
    });
}

// ── Species comparison (Stats tab) ────────────────────────
function renderCompare() {
    const species = [...new Set(allDetections.map(d => d.species).filter(Boolean))].sort();
    const panel   = document.getElementById('stats-compare');
    if (species.length < 2) {
        panel.innerHTML = '<p style="color:var(--color-gray-500);padding:1rem;">Not enough species data to compare.</p>';
        return;
    }
    const sel = (id, label, defaultIdx) => `
        <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:140px;">
            <label style="font-size:0.8rem;font-weight:600;color:var(--color-gray-500);">${label}</label>
            <select id="${id}" class="filter-select" onchange="updateCompare()">
                ${species.map((s, i) => `<option value="${s}"${i === defaultIdx ? ' selected' : ''}>${s}</option>`).join('')}
            </select>
        </div>`;
    panel.innerHTML = `
        <div class="compare-selects">
            ${sel('compare-a', 'Species A', 0)}
            <div style="padding-top:20px;font-size:1.25rem;color:var(--color-gray-500);">⚖️</div>
            ${sel('compare-b', 'Species B', 1)}
        </div>
        <div id="compare-result"></div>`;
    updateCompare();
}

function updateCompare() {
    const a = document.getElementById('compare-a')?.value;
    const b = document.getElementById('compare-b')?.value;
    if (!a || !b) return;
    const statsFor = sp => {
        const rows = allDetections.filter(d => d.species === sp);
        const days = new Set(rows.map(d => d.detected_at?.slice(0, 10))).size;
        const feeders = new Set(rows.map(d => d.feeders?.display_name).filter(Boolean)).size;
        const temps = rows.map(d => d.temperature).filter(t => t != null);
        const avgTemp = temps.length ? (temps.reduce((s, t) => s + t, 0) / temps.length).toFixed(1) : '—';
        const hours = rows.map(d => new Date(d.detected_at).getHours());
        const peakHour = hours.length ? hours.reduce((a, b, _, arr) => {
            const freq = v => arr.filter(x => x === v).length;
            return freq(a) >= freq(b) ? a : b;
        }) : null;
        const peakStr = peakHour !== null ? `${peakHour}:00–${peakHour + 1}:00` : '—';
        return { count: rows.length, days, feeders, avgTemp, peakStr };
    };
    const sa = statsFor(a), sb = statsFor(b);
    const win = (va, vb) => va > vb ? ['compare-winner', ''] : va < vb ? ['', 'compare-winner'] : ['', ''];
    const [wa1, wb1] = win(sa.count, sb.count);
    const [wa2, wb2] = win(sa.days, sb.days);
    const [wa3, wb3] = win(sa.feeders, sb.feeders);
    document.getElementById('compare-result').innerHTML = `
        <table class="compare-table">
            <thead><tr><th>Metric</th><th>${esc(a)}</th><th>${esc(b)}</th></tr></thead>
            <tbody>
                <tr><td>Total detections</td><td class="${wa1}">${sa.count}</td><td class="${wb1}">${sb.count}</td></tr>
                <tr><td>Active days</td><td class="${wa2}">${sa.days}</td><td class="${wb2}">${sb.days}</td></tr>
                <tr><td>Feeders visited</td><td class="${wa3}">${sa.feeders}</td><td class="${wb3}">${sb.feeders}</td></tr>
                <tr><td>Avg temperature</td><td>${sa.avgTemp}${sa.avgTemp !== '—' ? '°F' : ''}</td><td>${sb.avgTemp}${sb.avgTemp !== '—' ? '°F' : ''}</td></tr>
                <tr><td>Peak hour</td><td>${sa.peakStr}</td><td>${sb.peakStr}</td></tr>
            </tbody>
        </table>`;
}

// ── Helpers ──────────────────────────────────────────────
function esc(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Push notifications for rare birds ────────────────────
let notificationsEnabled = false;
const seenRareIds = new Set(JSON.parse(localStorage.getItem('bwai-seen-rare') || '[]'));

function updateNotifBtn() {
    const btn = document.getElementById('notif-toggle');
    if (notificationsEnabled) {
        btn.textContent  = '🔔 Notifying';
        btn.style.background = '#2d5a3d';
    } else {
        btn.textContent  = '🔔 Notify rare';
        btn.style.background = 'var(--color-gray-500)';
    }
}

async function requestNotifPermission() {
    if (!('Notification' in window)) { alert('Notifications are not supported in this browser.'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
        notificationsEnabled = true;
        document.getElementById('notif-banner').style.display = 'none';
        updateNotifBtn();
    }
}

function toggleNotifications() {
    if (!('Notification' in window)) { alert('Notifications are not supported in this browser.'); return; }
    if (Notification.permission === 'denied') {
        alert('Notification permission was denied. Please enable it in your browser settings and reload.');
        return;
    }
    if (!notificationsEnabled) {
        if (Notification.permission === 'granted') {
            notificationsEnabled = true;
            updateNotifBtn();
        } else {
            // Show the inline banner asking for permission
            document.getElementById('notif-banner').style.display = 'flex';
        }
    } else {
        notificationsEnabled = false;
        updateNotifBtn();
    }
}

function checkForRareNotifications(detections) {
    if (!notificationsEnabled || Notification.permission !== 'granted') return;
    const rare = detections.filter(d =>
        (d.rarity === 'Rare' || d.rarity === 'Very Rare') && !seenRareIds.has(d.id)
    );
    rare.forEach(d => {
        seenRareIds.add(d.id);
        localStorage.setItem('bwai-seen-rare', JSON.stringify([...seenRareIds]));
        if (d.rarity === 'Very Rare') launchConfetti();
        const notif = new Notification(`${d.rarity} bird detected! 🐦`, {
            body: `${d.species}${d.feeders?.display_name ? ' at ' + d.feeders.display_name : ''}${d.zip_code ? ' (' + d.zip_code + ')' : ''}`,
            icon: d.image_url || '',
            tag:  String(d.id),
        });
        notif.onclick = () => { window.focus(); notif.close(); };
    });
}

// Offer notifications if not yet decided
window.addEventListener('load', () => {
    if ('Notification' in window && Notification.permission === 'default') {
        setTimeout(() => {
            document.getElementById('notif-banner').style.display = 'flex';
        }, 4000);
    }
});

// ── Animated KPI counter ─────────────────────────────────
function animateCount(el, target, duration = 600) {
    const start    = performance.now();
    const from     = parseInt(el.textContent.replace(/\D/g, '')) || 0;
    const isFloat  = String(target).includes('.');
    const decimals = isFloat ? 1 : 0;
    function step(now) {
        const t   = Math.min((now - start) / duration, 1);
        const ease = 1 - Math.pow(1 - t, 3);   // ease-out cubic
        const val  = from + (target - from) * ease;
        el.textContent = isFloat ? val.toFixed(decimals) : Math.round(val).toLocaleString();
        if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// ── Very Rare confetti burst ─────────────────────────────
const CONFETTI_COLORS = ['#2d5a3d','#d4a574','#e74c3c','#3498db','#f39c12','#9b59b6','#fff'];

function launchConfetti(count = 80) {
    for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        el.className = 'confetti-piece';
        el.style.left     = Math.random() * 100 + 'vw';
        el.style.top      = '-10px';
        el.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
        el.style.animationDuration = (1.2 + Math.random() * 1.6) + 's';
        el.style.animationDelay   = (Math.random() * 0.6) + 's';
        document.body.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }
}

// ── Shareable detection links ─────────────────────────────
function shareDetection(id, cardEl) {
    const url     = `${location.origin}${location.pathname}?id=${id}`;
    // Read from the card DOM directly — reliable even after auto-refresh replaces allDetections
    const species = cardEl?.querySelector('.card-title')?.childNodes[0]?.textContent?.trim() || '';
    const feeder  = cardEl?.querySelector('.card-feeder')?.textContent?.trim() || '';
    const title   = species ? `${species} — BirdWatchAI` : 'BirdWatchAI Detection';
    const text    = species
        ? `Check out this ${species}${feeder ? ' spotted at ' + feeder : ''}!`
        : 'Check out this bird detection!';

    function promptFallback() {
        prompt('Copy this link:', url);
    }

    function clipboardFallback() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url)
                .then(() => showToast('Link copied!'))
                .catch(promptFallback);
        } else {
            promptFallback();
        }
    }

    // Web Share API — native share sheet on iOS / Android
    if (navigator.share) {
        try {
            navigator.share({ title, text, url })
                .then(() => {})
                .catch(err => {
                    if (!err || err.name !== 'AbortError') {
                        showToast('Share error: ' + (err?.name || err));
                        clipboardFallback();
                    }
                });
        } catch (syncErr) {
            // navigator.share threw synchronously
            showToast('Share failed: ' + syncErr.message);
            clipboardFallback();
        }
        return;
    }

    // navigator.share not available — show why and fall back
    showToast('Share API unavailable — copying link');
    clipboardFallback();
}

// ── AI Species Research panel ────────────────────────────
const aiPanel = document.getElementById('ai-panel');
const aiPanelOverlay = document.getElementById('ai-panel-overlay');
const aiPanelTitle = document.getElementById('ai-panel-title');
const aiPanelBody = document.getElementById('ai-panel-body');

function openAIResearch(species) {
    if (!species) return;
    aiPanelTitle.textContent = species;
    aiPanelBody.innerHTML = '<div class="ai-panel-loading">Loading species info…</div>';
    aiPanel.classList.add('open');
    aiPanelOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    fetchSpeciesSummary(species);
}

function closeAIPanel() {
    aiPanel.classList.remove('open');
    aiPanelOverlay.classList.remove('open');
    document.body.style.overflow = '';
}

async function fetchSpeciesSummary(species) {
    // Build quick links section immediately
    const linksHtml = `
        <div class="ai-panel-section">
            <h4>🔗 Quick Links</h4>
            <div class="ai-panel-links">
                <a href="https://www.allaboutbirds.org/guide/${encodeURIComponent(species.replace(/\s+/g, '_'))}" target="_blank" rel="noopener">🐦 All About Birds</a>
                <a href="https://www.audubon.org/field-guide/bird/${encodeURIComponent(species.toLowerCase().replace(/\s+/g, '-'))}" target="_blank" rel="noopener">🌿 Audubon</a>
                <a href="https://www.google.com/search?q=${encodeURIComponent(species + ' bird species news')}" target="_blank" rel="noopener">🔍 Google News</a>
            </div>
        </div>`;

    // Fetch Wikipedia summary
    try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(species)}`);
        if (!res.ok) throw new Error('Not found');
        const data = await res.json();

        const thumb = data.thumbnail
            ? `<img class="ai-panel-thumb" src="${data.thumbnail.source}" alt="${species}">`
            : '';
        const extract = data.extract || 'No summary available.';

        aiPanelBody.innerHTML = `
            ${thumb}
            <div class="ai-panel-section">
                <h4>📋 Overview</h4>
                <p class="ai-panel-extract">${extract}</p>
            </div>
            ${linksHtml}`;
    } catch {
        aiPanelBody.innerHTML = `
            <div class="ai-panel-section">
                <p class="ai-panel-extract" style="color:var(--color-gray-500);">No Wikipedia summary found for "${species}". Try the links below for more information.</p>
            </div>
            ${linksHtml}`;
    }
}

// Close AI panel on Escape
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && aiPanel.classList.contains('open')) {
        closeAIPanel();
    }
});

function showToast(msg) {
    let t = document.getElementById('share-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'share-toast';
        t.style.cssText = 'position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);' +
            'background:#2d5a3d;color:white;padding:8px 18px;border-radius:20px;font-size:0.875rem;' +
            'z-index:9998;pointer-events:none;opacity:0;transition:opacity 0.2s;';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}

