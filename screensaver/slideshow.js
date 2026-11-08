// BirdWatchAI Community Feed — Slideshow renderer
//
// This file used to query Supabase itself, once per monitor. It no longer
// talks to the network at all: the main process loads the feed (lib/feed.js)
// and pushes finished photo records here, already resolved to local cache
// files where we have them. The renderer's job is ordering and transitions.

// ── Transition definitions ─────────────────────────────────
const TRANSITIONS = [
    { id: 'fade',     label: 'Fade'      },
    { id: 'slide',    label: 'Slide'     },
    { id: 'kenburns', label: 'Ken Burns' },
    { id: 'blur',     label: 'Blur'      },
];

// ── DOM refs ───────────────────────────────────────────────
const slideshowEl     = document.getElementById('slideshow');
const slideA          = document.getElementById('slide-a');
const slideB          = document.getElementById('slide-b');
const captionEl       = document.getElementById('slideshow-caption');
const counterEl       = document.getElementById('slideshow-counter');
const noteEl          = document.getElementById('slideshow-note');
const progressFill    = document.getElementById('slideshow-progress-fill');
const loadingEl       = document.getElementById('slideshow-loading');
const emptyEl         = document.getElementById('slideshow-empty');
const emptyMsgEl      = document.getElementById('slideshow-empty-msg');

// ── State ──────────────────────────────────────────────────
let photos       = [];
let photoIdx     = 0;
let activeSlot   = 0;      // 0 = A, 1 = B
let slideToken   = 0;      // prevents stale transitions from committing
let timer        = null;
let progressRAF  = null;
let slideStart   = 0;
let idleTimer    = null;
let playing      = false;

// Settings (overridden by main process)
let settings = {
    transition:   'random',
    interval:     6000,
    sortMode:     'random',
    photoAge:     'all',
    feeders:      [],
    showCaption:  true,
    showProgress: true,
};

// ── Receive settings from main process ─────────────────────
window.screensaverAPI.onSettings((s) => {
    settings = { ...settings, ...s };

    // Apply transition
    if (settings.transition !== 'random') {
        slideshowEl.dataset.transition = settings.transition;
    }

    // Visibility toggles
    document.getElementById('slideshow-chrome').style.display =
        settings.showCaption ? '' : 'none';
    document.getElementById('slideshow-bar').style.display =
        settings.showProgress ? '' : 'none';
});

// ── Receive the feed from main ─────────────────────────────
window.screensaverAPI.onFeed((result) => {
    const incoming = Array.isArray(result.photos) ? result.photos : [];

    // Say which window we actually landed on when the chosen photo-age had
    // nothing in it. "Today" quietly showing last Tuesday is worse than
    // showing last Tuesday and saying so.
    if (noteEl) {
        noteEl.textContent = result.fallback
            ? `No photos ${periodPhrase(result.fallback.period)} — showing ${result.fallback.label}`
            : '';
    }

    if (!incoming.length) {
        if (!playing) {
            showEmptyState(emptyMessage(result));
        }
        return;   // a failed refresh never interrupts a running slideshow
    }

    if (!playing) {
        photos = orderFor(incoming);
        hideEmptyState();
        loadingEl.classList.add('hidden');
        const delay = settings.staggerDelay || 0;
        if (delay > 0) setTimeout(startPlayback, delay);
        else           startPlayback();
        return;
    }

    mergeRefresh(incoming);
});

// Each monitor shuffles its own copy, so a multi-display wall is not showing
// the same bird four times.
function orderFor(list) {
    const copy = list.slice();
    if (!settings.sortMode || settings.sortMode === 'random') shuffle(copy);
    return copy;
}

// Fold a refresh into a running slideshow: refresh the URLs we already hold
// (a signed URL for private media only lives a couple of hours, and photos
// cached since the last pass now have a local path), then queue what's new.
function mergeRefresh(incoming) {
    const byId = new Map(incoming.map(p => [p.id, p]));

    for (const p of photos) {
        const fresh = byId.get(p.id);
        if (fresh && fresh.url && fresh.url !== p.url) p.url = fresh.url;
    }

    const have = new Set(photos.map(p => p.id));
    const added = incoming.filter(p => !have.has(p.id));
    if (!added.length) return;

    shuffle(added);
    photos.splice(photoIdx + 1, 0, ...added);
}

function periodPhrase(period) {
    switch (period) {
        case 'today': return 'today';
        case 'week':  return 'this week';
        case 'month': return 'this month';
        case 'year':  return 'this year';
        default:      return 'in that range';
    }
}

function emptyMessage(result) {
    if (result.offline) {
        return 'No connection, and no photos saved yet — check back soon.';
    }
    const filtered = (settings.feeders && settings.feeders.length) ||
        (settings.photoAge && settings.photoAge !== 'all');
    return filtered
        ? 'No photos match your feeder settings.'
        : 'No photos available yet — check back soon.';
}

// ── Signal mouse clicks to main process to exit ────────────
document.addEventListener('mousedown', () => {
    window.screensaverAPI.signalActivity();
});

// ── Playback ───────────────────────────────────────────────
function startPlayback() {
    photoIdx = 0;
    activeSlot = 0;
    playing = true;

    // Reset both slides
    [slideA, slideB].forEach(el => {
        el.className = 'slideshow-slide';
        el.removeAttribute('src');
    });

    showSlide(0);
    startTimer();
    bumpIdle();
}

function showSlide(direction) {
    const photo = photos[photoIdx];
    if (!photo) return;

    const myToken = ++slideToken;

    // For random transition, pick a fresh one per slide
    if (settings.transition === 'random') {
        const pick = TRANSITIONS[Math.floor(Math.random() * TRANSITIONS.length)];
        slideshowEl.dataset.transition = pick.id;
    }

    // Update caption
    if (settings.showCaption) {
        let caption = photo.species || '';
        if (photo.feeder) caption += ` — ${photo.feeder}`;
        captionEl.textContent = caption;
    }
    counterEl.textContent = `${photoIdx + 1} / ${photos.length}`;

    const transition = slideshowEl.dataset.transition || 'fade';
    const slots      = [slideA, slideB];
    const currentImg = slots[activeSlot];
    const nextImg    = slots[1 - activeSlot];

    const commit = () => {
        if (myToken !== slideToken) return;

        nextImg.className = 'slideshow-slide';
        nextImg.alt = photo.species || '';

        if (transition === 'slide' && direction) {
            nextImg.classList.add(direction > 0 ? 'from-right' : 'from-left');
            void nextImg.offsetWidth; // force layout
            nextImg.classList.remove('from-right', 'from-left');
            nextImg.classList.add('active');
            currentImg.classList.remove('active');
            currentImg.classList.add(direction > 0 ? 'exit-left' : 'exit-right');
        } else {
            nextImg.classList.add('active');
            currentImg.classList.remove('active');
        }

        activeSlot = 1 - activeSlot;
    };

    // Preload before swapping. A cached photo is a local file, so this is
    // usually instant; the remote fallback is what the safety net is for.
    const src = photo.url;
    const pre = new Image();
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        if (myToken !== slideToken) return;
        nextImg.src = src;
        requestAnimationFrame(commit);
    };
    pre.onload  = finish;
    pre.onerror = () => {
        // A local cache file that has been pruned, or a signed URL that died
        // mid-slideshow. Fall back to the remote copy once before giving up.
        if (!done && photo.remote && src !== photo.remote) {
            photo.url = photo.remote;
            pre.onerror = finish;
            pre.src = photo.remote;
            return;
        }
        finish();
    };
    pre.src = src;
    setTimeout(finish, 2000); // safety net
}

function startTimer() {
    clearTimeout(timer);
    cancelAnimationFrame(progressRAF);
    slideStart = performance.now();

    function tick() {
        const elapsed = performance.now() - slideStart;
        const pct = Math.min(100, (elapsed / settings.interval) * 100);
        progressFill.style.width = pct + '%';
        if (pct < 100) progressRAF = requestAnimationFrame(tick);
    }
    tick();

    timer = setTimeout(() => {
        photoIdx = (photoIdx + 1) % photos.length;
        showSlide(1);
        startTimer();
    }, settings.interval);
}

// ── Idle overlay fade ──────────────────────────────────────
function bumpIdle() {
    slideshowEl.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        slideshowEl.classList.add('idle');
    }, 4000);
}

// ── Empty state (floating logo) ────────────────────────────
function showEmptyState(message) {
    loadingEl.classList.add('hidden');
    if (message) emptyMsgEl.textContent = message;
    emptyEl.classList.add('visible');
}

function hideEmptyState() {
    emptyEl.classList.remove('visible');
}

// ── Utilities ──────────────────────────────────────────────
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
