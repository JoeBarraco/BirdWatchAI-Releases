// BirdWatchAI Screensaver — Slideshow renderer
// Fetches bird photos from Supabase and displays them with transitions.
// Adapted from community-social.js gallery slideshow.

// ── Supabase config (read-only, public anon key) ───────────
const SUPABASE_URL = 'https://lsamggztfizmkyljdgwq.supabase.co';
const ANON_KEY     = 'sb_publishable_-80LQjkx2s82XnURj2DfQQ_d7ARz3js';

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
const progressFill    = document.getElementById('slideshow-progress-fill');
const loadingEl       = document.getElementById('slideshow-loading');

// ── State ──────────────────────────────────────────────────
let photos       = [];
let photoIdx     = 0;
let activeSlot   = 0;      // 0 = A, 1 = B
let slideToken   = 0;      // prevents stale transitions from committing
let timer        = null;
let progressRAF  = null;
let slideStart   = 0;
let idleTimer    = null;

// Settings (overridden by main process)
let settings = {
    transition:   'random',
    interval:     6000,
    sortMode:     'random',
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

    // Start loading photos
    loadPhotos();
});

// ── Signal mouse clicks to main process to exit ────────────
document.addEventListener('mousedown', () => {
    window.screensaverAPI.signalActivity();
});

// ── Fetch photos from Supabase ─────────────────────────────
async function loadPhotos() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/community_detections` +
            `?select=id,species,image_url,detected_at,feeders(display_name)` +
            `&image_url=not.is.null` +
            `&order=detected_at.desc` +
            `&limit=500`;

        const res = await fetch(url, {
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
            },
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const detections = await res.json();

        // Group by species (mirrors buildGalleryData from community-social.js)
        const speciesMap = {};
        for (const d of detections) {
            if (!d.species || !d.image_url) continue;
            if (!speciesMap[d.species]) {
                speciesMap[d.species] = {
                    species: d.species,
                    photos: [],
                    lastSeen: d.detected_at,
                };
            }
            const entry = speciesMap[d.species];
            entry.photos.push({
                id: d.id,
                url: d.image_url,
                date: d.detected_at,
                species: d.species,
                feeder: d.feeders?.display_name || '',
            });
            if (d.detected_at > entry.lastSeen) entry.lastSeen = d.detected_at;
        }

        const speciesList = Object.values(speciesMap).filter(s => s.photos.length > 0);

        // Sort species groups based on settings
        switch (settings.sortMode) {
            case 'count':
                speciesList.sort((a, b) => b.photos.length - a.photos.length);
                break;
            case 'alpha':
                speciesList.sort((a, b) => a.species.localeCompare(b.species));
                break;
            case 'recent':
                speciesList.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
                break;
            case 'random':
            default:
                shuffleArray(speciesList);
                break;
        }

        // Flatten to photo list
        photos = [];
        for (const s of speciesList) {
            for (const p of s.photos) {
                photos.push(p);
            }
        }

        // Extra shuffle for random mode
        if (settings.sortMode === 'random') {
            shuffleArray(photos);
        }

        if (!photos.length) {
            loadingEl.querySelector('p').textContent = 'No photos available.';
            return;
        }

        // Hide loading, start playback (after optional stagger delay for multi-monitor)
        loadingEl.classList.add('hidden');
        const delay = settings.staggerDelay || 0;
        if (delay > 0) {
            setTimeout(() => startPlayback(), delay);
        } else {
            startPlayback();
        }

    } catch (err) {
        console.error('Failed to load photos:', err);
        loadingEl.querySelector('p').textContent =
            'Unable to load photos. Check your internet connection.';
    }
}

// ── Playback ───────────────────────────────────────────────
function startPlayback() {
    photoIdx = 0;
    activeSlot = 0;

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

    // Preload before swapping
    const pre = new Image();
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        if (myToken !== slideToken) return;
        nextImg.src = photo.url;
        requestAnimationFrame(commit);
    };
    pre.onload  = finish;
    pre.onerror = finish;
    pre.src     = photo.url;
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

// ── Periodic refresh — pull new photos every 5 minutes ─────
setInterval(async () => {
    try {
        const url = `${SUPABASE_URL}/rest/v1/community_detections` +
            `?select=id,species,image_url,detected_at,feeders(display_name)` +
            `&image_url=not.is.null` +
            `&order=detected_at.desc` +
            `&limit=500`;

        const res = await fetch(url, {
            headers: {
                apikey: ANON_KEY,
                Authorization: `Bearer ${ANON_KEY}`,
            },
        });
        if (!res.ok) return;

        const detections = await res.json();
        const existingIds = new Set(photos.map(p => p.id));
        const newPhotos = [];

        for (const d of detections) {
            if (!d.species || !d.image_url) continue;
            if (existingIds.has(d.id)) continue;
            newPhotos.push({
                id: d.id,
                url: d.image_url,
                date: d.detected_at,
                species: d.species,
                feeder: d.feeders?.display_name || '',
            });
        }

        if (newPhotos.length) {
            shuffleArray(newPhotos);
            // Insert after current position so they appear naturally
            photos.splice(photoIdx + 1, 0, ...newPhotos);
        }
    } catch {
        // Silently ignore refresh failures
    }
}, 5 * 60 * 1000);

// ── Utilities ──────────────────────────────────────────────
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
