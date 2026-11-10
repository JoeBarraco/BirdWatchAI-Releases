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
const cornerFeederEl     = document.getElementById('corner-feeder');
const cornerFeederNameEl = document.getElementById('corner-feeder-name');

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
let clipFailStreak = 0;  // consecutive clips that ended too fast to have played
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

// Deal the feed out across the monitors instead of giving every window the
// whole list.
//
// Each window used to shuffle its own copy, on the theory that independent
// shuffles would keep a wall from showing the same bird everywhere. They do
// not: two windows land on the same photo whenever their orders happen to
// agree at that moment, and with a short feed — "today" can be four photos —
// that is most of the time.
//
// So the order is now settled once, in the main process, and each window takes
// every Nth item from it. Those index sets are disjoint by construction, so
// the same photo cannot be on two screens at once no matter how the windows
// drift apart in time, and between them the monitors still cover the feed.
function mine(list) {
    const count = Math.max(1, settings.monitorCount || 1);
    const index = Math.min(Math.max(0, settings.monitorIndex || 0), count - 1);
    if (count === 1) return list.slice();

    const out = list.filter((_, i) => i % count === index);
    // Fewer photos than monitors. Showing a repeat beats leaving a screen
    // empty, so in that case everyone gets everything.
    return out.length ? out : list.slice();
}

function orderFor(list) {
    return mine(list);
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

    // New arrivals go through the same deal as the initial list, or a refresh
    // would hand every monitor every new photo and undo the split. Note the
    // lookup above still uses the full `incoming`: this window's photos are a
    // subset of it, and their URLs need refreshing either way.
    const have = new Set(photos.map(p => p.id));
    const added = mine(incoming).filter(p => !have.has(p.id));
    if (!added.length) return;

    // Left in the order the main process settled, which is already random for
    // the default sort — reshuffling here would only scramble the deal.
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
// clipEvery === 0 means "only clips, no stills". It is a distinct mode rather
// than a frequency, so it gets a name: `clipEvery > 0` elsewhere still reads as
// "every Nth photo", and switching clips off entirely is the playClips box.
const CLIPS_ONLY = 0;

// "A clip every N photos" counts the whole wall, not one screen.
//
// Every window still plays a clip every clipEvery slides of its own — N
// windows doing that is already one clip per clipEvery slides across the wall,
// which is the rate asked for. What was missing is *phase*: every window
// counted from zero, so all of them reached their clip on the same slide and
// the wall showed N clips at once, then none for a while.
//
// Each window now starts its count at a different offset, so the clips
// interleave instead of landing together.
//
// The offset cannot simply be the window's index into a global slide number
// (`globalSlide % clipEvery`). Global slide numbers for window i are all
// congruent to i modulo the monitor count, so whenever the monitor count and
// clipEvery share a factor the multiples of clipEvery all land on the same
// few windows: two monitors with clipEvery 4 would put every clip on monitor
// zero and never play one on monitor one. Spreading the phase across the
// cycle instead has no such blind spot — every window gets a distinct turn
// for any combination of the two numbers.
function clipPhase() {
    const monitors = Math.max(1, settings.monitorCount || 1);
    const index    = Math.min(Math.max(0, settings.monitorIndex || 0), monitors - 1);
    const every    = settings.clipEvery;
    if (!(every > 0)) return 0;
    return Math.round(index * every / monitors) % every;
}

function advance() {
    if (!photos.length) return;

    photoIdx = (photoIdx + 1) % photos.length;
    shownCount++;

    const clipsOnly = settings.playClips && settings.clipEvery === CLIPS_ONLY;

    // A clip that ends almost instantly did not play — a dead signed URL, an
    // undecodable file, a truncated upload. In clips-only mode there is no
    // still between attempts to pace things, so a feed whose only clip is
    // broken would spin through playClip as fast as the network can fail.
    // After a few of those in a row, show a still instead and let the timer
    // put a gap in. One good clip resets it.
    const clipLoopSuspected = clipFailStreak >= 3;

    const wantClip = settings.playClips && !clipLoopSuspected &&
        (clipsOnly || (settings.clipEvery > 0 &&
            shownCount % settings.clipEvery === clipPhase()));

    if (wantClip) {
        const idx = findClip(photoIdx);
        if (idx >= 0) {
            photoIdx = idx;
            playClip(photos[idx]);
            return;
        }
        // Nothing in the whole feed has a clip. Fall through to stills rather
        // than leaving the screen dead — the chosen photo age may simply be a
        // day nobody recorded video on.
    }

    if (clipLoopSuspected) clipFailStreak = 0;

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
// out from under a cached feed at any time. The name survives that — it is the
// part that actually identifies the feeder — so the two are hidden separately.
function setCornerLogo(photo) {
    const name = (photo && photo.feeder) || '';
    const src  = (photo && photo.logo) || '';

    cornerFeederNameEl.textContent = name;
    // The whole block goes when there is nothing to put in it, so the rule
    // above the clock does not hang there on its own.
    cornerFeederEl.hidden = !name && !src;

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

    const startedAt = Date.now();
    let finished = false;
    const done = () => {
        if (finished) return;
        finished = true;
        // Anything this short never rendered a frame. See advance().
        if (Date.now() - startedAt < 1200) clipFailStreak++;
        else clipFailStreak = 0;
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
