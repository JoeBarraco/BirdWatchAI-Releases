// BirdWatchAI Community Feed — Slideshow renderer
//
// This file used to query Supabase itself, once per monitor. It no longer
// talks to the network at all: the main process loads the feed (lib/feed.js)
// and pushes finished photo records here, already resolved to local cache
// files where we have them. The renderer's job is ordering and playback.

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
const videoEl         = document.getElementById('slide-video');
const captionEl       = document.getElementById('slideshow-caption');
const counterEl       = document.getElementById('slideshow-counter');
const noteEl          = document.getElementById('slideshow-note');
const progressFill    = document.getElementById('slideshow-progress-fill');
const loadingEl       = document.getElementById('slideshow-loading');
const emptyEl         = document.getElementById('slideshow-empty');
const emptyMsgEl      = document.getElementById('slideshow-empty-msg');
const cornerEl        = document.getElementById('slideshow-corner');
const cornerTimeEl    = document.getElementById('corner-time');
const cornerDateEl    = document.getElementById('corner-date');
const cornerUpdateEl  = document.getElementById('corner-update');
const cornerLogoEl    = document.getElementById('corner-logo');

// ── State ──────────────────────────────────────────────────
let photos       = [];
let photoIdx     = 0;
let activeSlot   = 0;      // 0 = A, 1 = B
let slideToken   = 0;      // prevents stale transitions from committing
let timer        = null;
let progressRAF  = null;
let slideStart   = 0;
let slideSpan    = 0;      // ms the current item is on screen
let idleTimer    = null;
let playing      = false;
let shownCount   = 0;      // items shown, for "a clip every N photos"
let updateInfo   = null;

// Settings (overridden by main process)
let settings = {
    transition:   'random',
    interval:     6000,
    sortMode:     'random',
    photoAge:     'all',
    feeders:      [],
    showCaption:  true,
    showProgress: true,
    showClock:    true,
    playClips:    true,
    clipEvery:    5,
    clipSeconds:  12,
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

    startClock();
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
        if (!playing) showEmptyState(emptyMessage(result));
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

// ── A newer release exists ─────────────────────────────────
window.screensaverAPI.onUpdate((info) => {
    if (!info || !info.available) return;
    updateInfo = info;
    cornerUpdateEl.textContent = `Version ${info.version} available`;
    cornerEl.classList.add('visible');
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
        if (!fresh) continue;
        if (fresh.url && fresh.url !== p.url) p.url = fresh.url;
        if (fresh.video !== undefined) p.video = fresh.video;
        // A signed logo URL expires on the same clock as the photo's, and a
        // refresh is the only thing that mints a new one.
        if (fresh.logo !== undefined) p.logo = fresh.logo;
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

// ── Clock corner ───────────────────────────────────────────
//
// Lower right, and not hidden by the idle fade: a clock you cannot see is not
// a clock. The other three corners all carry something the server burns into
// the photo itself — timestamp, watermark, species caption — so this is the
// only one free.
//
// Strictly the wall clock. The detection's temperature used to sit here too,
// which put a reading from hours or days ago under a heading that says
// "Current Time" — the very confusion the label exists to prevent. It is not
// shown anywhere else either, because it never needed to be: the server burns
// it into the photo itself, bottom left, alongside the confidence, the
// detection time and the rarity. We were drawing a second copy of a number
// that was already on screen, in the one place guaranteed to misread it.
function startClock() {
    if (!settings.showClock) {
        if (!updateInfo) cornerEl.classList.remove('visible');
        return;
    }
    cornerEl.classList.add('visible');
    tickClock();
    setInterval(tickClock, 10000);
}

function tickClock() {
    const now = new Date();
    cornerTimeEl.textContent = now.toLocaleTimeString(undefined,
        { hour: 'numeric', minute: '2-digit' });
    cornerDateEl.textContent = now.toLocaleDateString(undefined,
        { weekday: 'long', month: 'long', day: 'numeric' });
}

// ── Playback ───────────────────────────────────────────────
function startPlayback() {
    photoIdx = 0;
    activeSlot = 0;
    playing = true;
    shownCount = 0;

    // Reset both slides
    [slideA, slideB].forEach(el => {
        el.className = 'slideshow-slide';
        el.removeAttribute('src');
    });

    showSlide(0);
    startTimer(settings.interval);
    bumpIdle();
}

// Move on: usually the next still, but every clipEvery-th item looks for a
// video to play instead.
function advance() {
    if (!photos.length) return;

    photoIdx = (photoIdx + 1) % photos.length;
    shownCount++;

    const wantClip = settings.playClips &&
        settings.clipEvery > 0 &&
        shownCount % settings.clipEvery === 0;

    if (wantClip) {
        const idx = findClip(photoIdx);
        if (idx >= 0) {
            photoIdx = idx;
            playClip(photos[idx]);
            return;
        }
    }

    showSlide(1);
    startTimer(settings.interval);
}

// Nearest upcoming detection that has a clip. Most do not, so this scans
// rather than assuming the one we landed on will do.
function findClip(from) {
    for (let i = 0; i < photos.length; i++) {
        const idx = (from + i) % photos.length;
        if (photos[idx].video) return idx;
    }
    return -1;
}

function setCaption(photo) {
    if (settings.showCaption) {
        let caption = photo.species || '';
        if (photo.feeder) caption += ` — ${photo.feeder}`;
        captionEl.textContent = caption;
    }
    counterEl.textContent = `${photoIdx + 1} / ${photos.length}`;
    setCornerLogo(photo);
}

// The logo belongs to the feeder whose bird is on screen, so it changes with
// the slide. It lives in the corner panel, which means it is visible only when
// that panel is — with the clock switched off and no update to announce there
// is no panel to put it in.
//
// A logo that fails to load is hidden rather than left as a broken-image box:
// this runs unattended for months and a feeder can delete its own logo object
// out from under a cached feed at any time.
function setCornerLogo(photo) {
    const src = (photo && photo.logo) || '';
    if (!src) {
        cornerLogoEl.hidden = true;
        cornerLogoEl.removeAttribute('src');
        return;
    }
    if (cornerLogoEl.getAttribute('src') === src) return;
    cornerLogoEl.onerror = () => { cornerLogoEl.hidden = true; };
    cornerLogoEl.onload  = () => { cornerLogoEl.hidden = false; };
    cornerLogoEl.hidden = true;
    cornerLogoEl.src = src;
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

    setCaption(photo);

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

// ── Clips ──────────────────────────────────────────────────
//
// Clips are streamed rather than cached, so anything can go wrong at any
// moment: a dead signed URL, a codec the build will not decode, a feeder that
// uploaded a truncated file. Every failure path lands on the same `done`,
// which returns to the stills rather than leaving a black stage.
function playClip(photo) {
    const myToken = ++slideToken;   // invalidate any in-flight image preload

    clearTimeout(timer);
    cancelAnimationFrame(progressRAF);
    setCaption(photo);
    console.log(`clip: ${photo.species} (${photo.id})`);

    let finished = false;
    const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(cap);
        videoEl.classList.remove('active');
        videoEl.onended = videoEl.onerror = null;
        try {
            videoEl.pause();
            videoEl.removeAttribute('src');
            videoEl.load();     // actually stops the download
        } catch { /* nothing to stop */ }

        if (myToken !== slideToken) return;   // something else took over
        advance();
    };

    const cap = setTimeout(done, Math.max(3, settings.clipSeconds || 12) * 1000);

    videoEl.onended = done;
    videoEl.onerror = done;

    try {
        videoEl.muted = true;      // belt and braces; also set in the markup
        videoEl.src = photo.video;
        const p = videoEl.play();
        if (p && typeof p.catch === 'function') p.catch(done);

        videoEl.classList.add('active');

        // Run the progress bar over the clip's real length once known, so it
        // means the same thing it does for a still.
        videoEl.onloadedmetadata = () => {
            const secs = isFinite(videoEl.duration) && videoEl.duration > 0
                ? Math.min(videoEl.duration, settings.clipSeconds || 12)
                : (settings.clipSeconds || 12);
            runProgress(secs * 1000);
        };
        runProgress(Math.max(3, settings.clipSeconds || 12) * 1000);
    } catch {
        done();
    }
}

// ── Timing ─────────────────────────────────────────────────
function runProgress(ms) {
    cancelAnimationFrame(progressRAF);
    slideStart = performance.now();
    slideSpan  = ms;

    function tick() {
        const pct = Math.min(100, ((performance.now() - slideStart) / slideSpan) * 100);
        progressFill.style.width = pct + '%';
        if (pct < 100) progressRAF = requestAnimationFrame(tick);
    }
    tick();
}

function startTimer(ms) {
    clearTimeout(timer);
    runProgress(ms);
    timer = setTimeout(advance, ms);
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
