// BirdWatchAI Community Feed - Clips (video grid + back-to-back theater)
//
// The Clips tab is the moving-picture twin of the Gallery: it draws from the same
// applyClientFilters(allDetections) set, so every control in the filter bar — period, species,
// feeder, rarity, near-me, search — already scopes it. "All clips from today" is the Today
// button; "just this feeder" is the feeder dropdown. No filter UI of its own, on purpose.
//
// Playback is two <video> slots, A and B. While one plays, the next clip is already loading into
// the other, so the handoff on `ended` is a swap rather than a fetch — that's what makes a run of
// 4-second clips feel like one continuous reel instead of a stutter every few seconds.

const CLIPS_PAGE = 60;              // grid cards per "Show more" press
const CLIP_ERROR_GIVEUP = 6;        // consecutive dead clips before we stop skipping

let clipList     = [];              // full filtered + sorted playlist (grid indices point into this)
let clipIdx      = 0;
let clipsShown   = CLIPS_PAGE;      // how much of the grid is painted
let clipGridSig  = '';              // last painted grid signature, to skip no-op repaints
let clipErrors   = 0;               // consecutive playback failures
let clipPaused   = false;
let clipMuted    = localStorage.getItem('bwai-clips-muted') === '1';
let clipIdleTimer = null;
let clipActiveSlot = 0;             // 0 = A, 1 = B
let clipsTopUpPending = false;      // a full-set fetch is in flight
let clipsTopUpTries = 0;            // bounded, so a failing fetch can't spin forever

const clipTheater = document.getElementById('clip-theater');
const clipVideoA  = document.getElementById('clip-video-a');
const clipVideoB  = document.getElementById('clip-video-b');

function clipSlots() { return [clipVideoA, clipVideoB]; }
function clipActive() { return clipSlots()[clipActiveSlot]; }

// ── Data ────────────────────────────────────────────────
function buildClipList() {
    const sort = document.getElementById('clips-sort')?.value || 'recent';
    const clips = applyClientFilters(allDetections)
        .filter(d => d.video_url)
        .map(d => ({
            id: d.id,
            url: d.video_url,
            poster: d.image_url || '',
            species: d.species || 'Unknown',
            date: d.detected_at,
            feeder: d.feeders?.display_name || '',
            rarity: d.rarity || '',
        }));

    if (sort === 'recent') clips.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (sort === 'oldest') clips.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (sort === 'alpha')  clips.sort((a, b) =>
        a.species.localeCompare(b.species) || (b.date || '').localeCompare(a.date || ''));
    if (sort === 'random') applyStableShuffle(clips);

    return clips;
}

// "Random" has to stay put once rolled. The feed re-renders every 30 seconds, and a fresh
// shuffleArray() each time would reorder the grid under the reader's cursor and yank a running
// theater to a different clip. So the roll happens once and is remembered as a rank per id;
// detections that arrive later are appended in fresh random order rather than reshuffling the lot.
let clipRandomRanks = null;

function applyStableShuffle(clips) {
    if (!clipRandomRanks) {
        clipRandomRanks = new Map();
        shuffleArray(clips.slice()).forEach((c, i) => clipRandomRanks.set(c.id, i));
    }
    const unranked = clips.filter(c => !clipRandomRanks.has(c.id));
    if (unranked.length) {
        let next = clipRandomRanks.size;
        shuffleArray(unranked).forEach(c => clipRandomRanks.set(c.id, next++));
    }
    clips.sort((a, b) => clipRandomRanks.get(a.id) - clipRandomRanks.get(b.id));
    return clips;
}

async function loadAllThenRenderClips() {
    if (!feedExhausted) {
        document.getElementById('clips-grid').innerHTML =
            '<div class="feed-loading" style="grid-column:1/-1;">Loading all detections…</div>';
        await loadAllDetections();
    }
    renderClips();
}

function onClipsSortChange() {
    clipsShown = CLIPS_PAGE;    // a new order means the old "Show more" depth is meaningless
    clipRandomRanks = null;     // picking Random again should roll a genuinely new order
    renderClips();
}

// ── Grid ────────────────────────────────────────────────
function renderClips() {
    const grid = document.getElementById('clips-grid');
    const summary = document.getElementById('clips-summary');
    if (!grid) return;          // markup not on the page (stale cached HTML); bail quietly
    // While the theater is up it owns clipList — rebuilding it here on a background refresh would
    // renumber the playlist under a clip that's mid-play. refreshClipTheater() handles that case,
    // and closeClipTheater() repaints the grid on the way out.
    if (clipTheater?.classList.contains('open')) return;

    clipList = buildClipList();
    clipsShown = Math.min(Math.max(clipsShown, CLIPS_PAGE), clipList.length);

    const playAll = document.getElementById('clips-playall');
    if (playAll) playAll.disabled = clipList.length === 0;

    if (!clipList.length) {
        clipGridSig = '';
        summary.textContent = '';
        grid.innerHTML = '<div class="feed-empty" style="grid-column:1/-1;">No clips match your filters.</div>';
        document.getElementById('clips-more').style.display = 'none';
        return;
    }

    summary.textContent = clipList.length === 1
        ? '1 clip'
        : `${clipList.length.toLocaleString()} clips`;

    // Changing a filter re-runs loadFeed(), which only fetches the first page — so a render
    // triggered from there would describe page 1 as if it were the whole set ("60 clips" when
    // there are thousands). Pull the rest in, then repaint with the real count.
    if (!feedExhausted && currentView === 'clips' && !clipsTopUpPending && clipsTopUpTries < 3) {
        clipsTopUpPending = true;
        clipsTopUpTries++;
        summary.textContent += ' · loading more…';
        loadAllDetections().finally(() => {
            clipsTopUpPending = false;
            if (feedExhausted) clipsTopUpTries = 0;
            if (currentView === 'clips') renderClips();
        });
    }

    // The feed auto-refreshes every 30s. Repainting an unchanged grid would restart every lazy
    // image and throw away scroll anchoring for no reason, so bail when nothing visible moved.
    const shown = clipList.slice(0, clipsShown);
    const sig = shown.map(c => c.id).join(',');
    if (sig !== clipGridSig) {
        clipGridSig = sig;
        grid.innerHTML = shown.map((c, i) => `
            <div class="gallery-card clip-card" data-clip-idx="${i}" title="${esc(c.species)} — ${esc(fmtDetectedAt(c.date))}">
                <div class="clip-thumb">
                    ${c.poster
                        ? `<img src="${c.poster}" alt="${esc(c.species)}" loading="lazy">`
                        : '<div class="clip-thumb-empty">🎬</div>'}
                    <span class="clip-play-badge">▶</span>
                    <span class="gallery-card-badge">${esc(fmtClipTime(c.date))}</span>
                </div>
                <div class="gallery-card-info">
                    <div class="gallery-card-species">${esc(c.species)}</div>
                    <div class="gallery-card-meta">${c.feeder ? esc(c.feeder) : 'Unknown feeder'}</div>
                </div>
            </div>`).join('');
    }

    const more = document.getElementById('clips-more');
    const remaining = clipList.length - clipsShown;
    more.style.display = remaining > 0 ? '' : 'none';
    more.textContent = `Show more (${remaining.toLocaleString()} left)`;
}

function showMoreClips() {
    clipsShown = Math.min(clipsShown + CLIPS_PAGE, clipList.length);
    renderClips();
}

// Short label for the grid badge — today's clips read as a time, older ones as a date.
function fmtClipTime(iso) {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return d.toLocaleString('en-US', sameDay
        ? { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }
        : { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric' });
}

document.getElementById('clips-grid')?.addEventListener('click', e => {
    const card = e.target.closest('.clip-card');
    if (!card) return;
    openClipTheater(parseInt(card.dataset.clipIdx, 10));
});

// ── Theater ─────────────────────────────────────────────
function startClipTheater() {
    if (!clipList.length) { showToast('No clips to play'); return; }
    openClipTheater(0);
}

function openClipTheater(startIdx) {
    if (!clipList.length || !clipTheater) return;
    clipPaused = false;
    clipErrors = 0;
    clipActiveSlot = 0;
    clipSlots().forEach(v => {
        v.className = 'clip-slide';
        v.removeAttribute('src');
        v.removeAttribute('poster');
        delete v.dataset.clipId;
        v.load();
    });
    clipTheater.classList.add('open');
    lockScroll();
    syncClipMuteButton();
    document.getElementById('clip-playpause').textContent = '⏸';
    showClip(startIdx);
    requestClipFullscreen();
    bumpClipIdle();
}

function showClip(i) {
    if (!clipList.length) return;
    clipIdx = ((i % clipList.length) + clipList.length) % clipList.length;
    const clip = clipList[clipIdx];

    const current = clipActive();
    const next    = clipSlots()[1 - clipActiveSlot];

    // The incoming slot usually holds this very clip already (preloaded during the previous one).
    // Only re-source it when the user jumped somewhere we hadn't anticipated.
    if (next.dataset.clipId !== clip.id) loadClipInto(next, clip);
    try { next.currentTime = 0; } catch (_) { /* not seekable yet; it starts at 0 anyway */ }
    next.muted = clipMuted;

    current.pause();
    current.classList.remove('active');
    next.classList.add('active');
    clipActiveSlot = 1 - clipActiveSlot;

    if (!clipPaused) playClipSlot(next);

    document.getElementById('clip-caption').textContent =
        clip.species + (clip.feeder ? ` · ${clip.feeder}` : '');
    document.getElementById('clip-subcaption').textContent = fmtDetectedAt(clip.date);
    document.getElementById('clip-counter').textContent =
        `${clipIdx + 1} / ${clipList.length}`;
    document.getElementById('clip-progress-fill').style.width = '0%';

    // Warm the slot we just vacated with whatever comes next, so `ended` is a swap, not a fetch.
    if (clipList.length > 1) {
        const upcoming = clipList[(clipIdx + 1) % clipList.length];
        loadClipInto(clipSlots()[1 - clipActiveSlot], upcoming);
    }
}

function loadClipInto(video, clip) {
    video.dataset.clipId = clip.id;
    if (clip.poster) video.poster = clip.poster;
    else video.removeAttribute('poster');
    video.src = clip.url;
    video.load();
}

// Autoplay with sound needs the opening click to still count as a user gesture. When the browser
// refuses anyway, fall back to muted rather than sitting on a frozen frame.
function playClipSlot(video) {
    const p = video.play();
    if (p && typeof p.catch === 'function') {
        p.catch(() => {
            if (video.muted) return;
            clipMuted = true;
            video.muted = true;
            syncClipMuteButton();
            showToast('Autoplay blocked — playing muted');
            video.play().catch(() => {});
        });
    }
}

function clipNav(dir) {
    clipErrors = 0;             // a deliberate move isn't part of a dead-clip run
    showClip(clipIdx + dir);
    bumpClipIdle();
}

function toggleClipPause() {
    clipPaused = !clipPaused;
    document.getElementById('clip-playpause').textContent = clipPaused ? '▶' : '⏸';
    if (clipPaused) clipActive().pause();
    else playClipSlot(clipActive());
    bumpClipIdle();
}

function toggleClipMute() {
    clipMuted = !clipMuted;
    localStorage.setItem('bwai-clips-muted', clipMuted ? '1' : '0');
    clipSlots().forEach(v => v.muted = clipMuted);
    syncClipMuteButton();
    bumpClipIdle();
}

function syncClipMuteButton() {
    const btn = document.getElementById('clip-mute');
    if (btn) {
        btn.textContent = clipMuted ? '🔇' : '🔊';
        btn.setAttribute('aria-label', clipMuted ? 'Unmute' : 'Mute');
    }
}

function closeClipTheater() {
    if (!clipTheater || !clipTheater.classList.contains('open')) return;
    clipTheater.classList.remove('open', 'idle');
    clipSlots().forEach(v => {
        v.pause();
        v.removeAttribute('src');
        delete v.dataset.clipId;
        v.load();                // drops the buffered data instead of leaving it resident
    });
    clearTimeout(clipIdleTimer);
    exitClipFullscreen();
    unlockScroll();
    renderClips();              // pick up anything the feed added while we were watching
}

// Per-slot playback events. Only the visible slot drives the UI — the other one is mid-preload and
// its events are noise.
clipSlots().forEach(v => {
    v.addEventListener('ended', () => {
        if (v !== clipActive() || !clipTheater.classList.contains('open')) return;
        clipErrors = 0;
        if (clipList.length === 1) { v.currentTime = 0; playClipSlot(v); return; }
        showClip(clipIdx + 1);
    });
    v.addEventListener('timeupdate', () => {
        if (v !== clipActive() || !v.duration) return;
        const pct = Math.min(100, (v.currentTime / v.duration) * 100);
        document.getElementById('clip-progress-fill').style.width = pct + '%';
    });
    // A clip whose storage object was deleted by a moderator 404s. Skip past it rather than
    // stalling the reel, but stop if we're just walking through a run of dead files.
    v.addEventListener('error', () => {
        if (v !== clipActive() || !clipTheater.classList.contains('open')) return;
        clipErrors++;
        if (clipErrors >= CLIP_ERROR_GIVEUP) {
            showToast('These clips are unavailable');
            toggleClipPauseTo(true);
            return;
        }
        if (clipList.length > 1) showClip(clipIdx + 1);
    });
});

function toggleClipPauseTo(paused) {
    clipPaused = paused;
    document.getElementById('clip-playpause').textContent = paused ? '▶' : '⏸';
    if (paused) clipActive().pause();
}

// ── Fullscreen / idle chrome (mirrors the photo slideshow) ──
function isClipFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function requestClipFullscreen() {
    const req = clipTheater.requestFullscreen || clipTheater.webkitRequestFullscreen;
    if (req && !isClipFullscreen()) {
        try { req.call(clipTheater).catch(() => {}); } catch (_) { /* gesture required; ignore */ }
    }
}
function exitClipFullscreen() {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex && isClipFullscreen()) {
        try { ex.call(document).catch(() => {}); } catch (_) { /* ignore */ }
    }
}
function toggleClipFullscreen() {
    if (isClipFullscreen()) exitClipFullscreen();
    else requestClipFullscreen();
    bumpClipIdle();
}

function bumpClipIdle() {
    if (!clipTheater) return;
    clipTheater.classList.remove('idle');
    clearTimeout(clipIdleTimer);
    clipIdleTimer = setTimeout(() => {
        if (clipTheater.classList.contains('open') && !clipPaused) clipTheater.classList.add('idle');
    }, 2500);
}

if (clipTheater) {
    document.getElementById('clip-close').addEventListener('click', closeClipTheater);
    document.getElementById('clip-prev').addEventListener('click', () => clipNav(-1));
    document.getElementById('clip-next').addEventListener('click', () => clipNav(1));
    clipTheater.addEventListener('mousemove', bumpClipIdle);
    clipTheater.addEventListener('touchstart', bumpClipIdle, { passive: true });
    // Tapping the picture itself is the universal play/pause gesture.
    document.querySelector('.clip-stage')?.addEventListener('click', toggleClipPause);
}

// This file loads before community-auth.js, so stopImmediatePropagation here keeps the global
// single-key shortcuts (f = My Likes, r = refresh, 1-5 = views) from also firing while the
// theater owns the keyboard.
document.addEventListener('keydown', e => {
    if (!clipTheater || !clipTheater.classList.contains('open')) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const handled = {
        ArrowLeft:  () => clipNav(-1),
        ArrowRight: () => clipNav(1),
        ' ':        toggleClipPause,
        f:          toggleClipFullscreen,
        F:          toggleClipFullscreen,
        m:          toggleClipMute,
        M:          toggleClipMute,
        Escape:     closeClipTheater,
    }[e.key];
    if (!handled) {
        // Anything else that's a bare single-key press gets swallowed rather than passed on:
        // otherwise "3" would switch the view to Gallery behind the player, and "r" would reload
        // the feed out from under it. Modified keys (Ctrl/Cmd/Alt) and Tab still reach the browser.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopImmediatePropagation();
        return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    handled();
});

function syncClipFullscreenButton() {
    const btn = document.getElementById('clip-fullscreen-btn');
    if (btn) btn.textContent = isClipFullscreen() ? '⤢' : '⛶';
}
document.addEventListener('fullscreenchange', syncClipFullscreenButton);
document.addEventListener('webkitfullscreenchange', syncClipFullscreenButton);

// Merge newly-arrived detections into a running theater without interrupting playback — the same
// courtesy refreshSlideshowPhotos() does for the photo slideshow.
function refreshClipTheater() {
    if (!clipTheater || !clipTheater.classList.contains('open')) return;
    const currentId = clipList[clipIdx]?.id;
    const fresh = buildClipList();
    if (!fresh.length) return;
    if (fresh.length === clipList.length && fresh.every((c, i) => c.id === clipList[i].id)) return;

    clipList = fresh;
    if (currentId) {
        const at = clipList.findIndex(c => c.id === currentId);
        clipIdx = at >= 0 ? at : Math.min(clipIdx, clipList.length - 1);
    }
    document.getElementById('clip-counter').textContent = `${clipIdx + 1} / ${clipList.length}`;
}
