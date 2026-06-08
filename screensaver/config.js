// BirdWatchAI Screensaver — Configuration window logic

// ── Supabase config (read-only, public anon key) ───────────
// Used to populate the feeder list with feeders that actually have photos.
const SUPABASE_URL = 'https://lsamggztfizmkyljdgwq.supabase.co';
const ANON_KEY     = 'sb_publishable_-80LQjkx2s82XnURj2DfQQ_d7ARz3js';

const transitionEl  = document.getElementById('transition');
const intervalEl    = document.getElementById('interval');
const sortModeEl    = document.getElementById('sortMode');
const photoAgeEl    = document.getElementById('photoAge');
const feederListEl  = document.getElementById('feeder-list');
const showCaptionEl = document.getElementById('showCaption');
const showProgressEl= document.getElementById('showProgress');
const statusMsg     = document.getElementById('status-msg');

// Selected feeder display names from saved settings ([] = all feeders)
let selectedFeeders = [];

// ── Fetch the list of feeders that have community photos ───
async function fetchFeeders() {
    const url = `${SUPABASE_URL}/rest/v1/community_detections` +
        `?select=feeders(display_name)` +
        `&image_url=not.is.null` +
        `&order=detected_at.desc` +
        `&limit=2000`;

    const res = await fetch(url, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rows = await res.json();
    const names = [...new Set(
        rows.map(r => r.feeders?.display_name).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
    return names;
}

// ── Render the feeder checkbox list ────────────────────────
function renderFeeders(feeders) {
    if (!feeders.length) {
        feederListEl.innerHTML =
            '<p class="feeder-loading">No feeders found — showing all photos.</p>';
        return;
    }

    // An empty saved list means "all feeders" → check everything.
    const showAll = selectedFeeders.length === 0;

    feederListEl.innerHTML = '';

    // "All feeders" master toggle
    const allLabel = document.createElement('label');
    allLabel.className = 'feeder-all';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.id = 'feeder-all';
    allCb.checked = showAll || feeders.every(f => selectedFeeders.includes(f));
    allLabel.appendChild(allCb);
    allLabel.appendChild(document.createTextNode('All feeders'));
    feederListEl.appendChild(allLabel);

    // Individual feeders
    for (const name of feeders) {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'feeder-item';
        cb.value = name;
        cb.checked = showAll || selectedFeeders.includes(name);
        label.appendChild(cb);
        label.appendChild(document.createTextNode(name));
        feederListEl.appendChild(label);
    }

    const itemCbs = () => [...feederListEl.querySelectorAll('.feeder-item')];

    // Master toggles all
    allCb.addEventListener('change', () => {
        itemCbs().forEach(cb => { cb.checked = allCb.checked; });
    });

    // Any individual change syncs the master state
    itemCbs().forEach(cb => {
        cb.addEventListener('change', () => {
            allCb.checked = itemCbs().every(c => c.checked);
        });
    });
}

// ── Read the selected feeders from the form ────────────────
// Returns [] when all (or none) are selected, meaning "all feeders".
function collectFeeders() {
    const items = [...feederListEl.querySelectorAll('.feeder-item')];
    if (!items.length) return [];
    const checked = items.filter(cb => cb.checked).map(cb => cb.value);
    // All selected → store [] so newly-added feeders are included automatically.
    if (checked.length === items.length) return [];
    return checked;
}

// ── Load current settings into the form ────────────────────
async function loadSettings() {
    const settings = await window.screensaverAPI.getSettings();

    transitionEl.value  = settings.transition  || 'random';
    intervalEl.value    = String(settings.interval || 6000);
    sortModeEl.value    = settings.sortMode    || 'random';
    photoAgeEl.value    = settings.photoAge    || 'all';
    showCaptionEl.checked  = settings.showCaption  !== false;
    showProgressEl.checked = settings.showProgress !== false;

    selectedFeeders = Array.isArray(settings.feeders) ? settings.feeders : [];

    try {
        const feeders = await fetchFeeders();
        renderFeeders(feeders);
    } catch (err) {
        console.error('Failed to load feeders:', err);
        feederListEl.innerHTML =
            '<p class="feeder-loading">Could not load feeders — showing all photos.</p>';
    }
}

// ── Save settings and close ────────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
    const settings = {
        transition:   transitionEl.value,
        interval:     parseInt(intervalEl.value, 10),
        sortMode:     sortModeEl.value,
        photoAge:     photoAgeEl.value,
        feeders:      collectFeeders(),
        showCaption:  showCaptionEl.checked,
        showProgress: showProgressEl.checked,
    };

    await window.screensaverAPI.saveSettings(settings);

    statusMsg.textContent = 'Settings saved!';
    setTimeout(() => window.close(), 600);
});

// Cancel — close without saving
document.getElementById('btn-cancel').addEventListener('click', () => {
    window.close();
});

// Init
loadSettings();
