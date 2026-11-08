// BirdWatchAI Community Feed — Configuration window logic
//
// No Supabase calls here any more. The feeder list and the account live in the
// main process, which owns the session; this window only drives the form.

const transitionEl   = document.getElementById('transition');
const intervalEl     = document.getElementById('interval');
const sortModeEl     = document.getElementById('sortMode');
const photoAgeEl     = document.getElementById('photoAge');
const feederListEl   = document.getElementById('feeder-list');
const showCaptionEl  = document.getElementById('showCaption');
const showProgressEl = document.getElementById('showProgress');
const refreshEl      = document.getElementById('refreshMinutes');
const cacheMBEl      = document.getElementById('cacheMB');
const cacheStatsEl   = document.getElementById('cache-stats');
const statusMsg      = document.getElementById('status-msg');
const showClockEl    = document.getElementById('showClock');
const playClipsEl    = document.getElementById('playClips');
const clipEveryEl    = document.getElementById('clipEvery');
const clipSecondsEl  = document.getElementById('clipSeconds');
const checkUpdatesEl = document.getElementById('checkUpdates');
const versionLineEl  = document.getElementById('version-line');
const updateLineEl   = document.getElementById('update-line');

const accountStatusEl = document.getElementById('account-status');
const accountOutEl    = document.getElementById('account-signed-out');
const accountInEl     = document.getElementById('account-signed-in');
const accountEmailEl  = document.getElementById('account-email');
const accountCodeRow  = document.getElementById('account-code-row');
const accountCodeEl   = document.getElementById('account-code');
const accountMsgEl    = document.getElementById('account-msg');

// Selected feeder display names from saved settings ([] = all feeders)
let selectedFeeders = [];

// ── Account ────────────────────────────────────────────────

function setAccountMsg(text, kind) {
    accountMsgEl.textContent = text || '';
    accountMsgEl.className = 'account-msg' + (kind ? ` ${kind}` : '');
}

function renderAccount(status) {
    const signedIn = status && status.signedIn;
    accountStatusEl.textContent = signedIn
        ? `Signed in as ${status.email}`
        : 'Not signed in — public feeders only.';
    accountStatusEl.className = 'account-status' + (signedIn ? ' signed-in' : '');
    accountOutEl.hidden = !!signedIn;
    accountInEl.hidden  = !signedIn;
}

async function refreshAccount() {
    try {
        renderAccount(await window.screensaverAPI.authStatus());
    } catch {
        renderAccount(null);
    }
}

document.getElementById('btn-send-code').addEventListener('click', async () => {
    const email = accountEmailEl.value.trim();
    if (!email) { setAccountMsg('Enter your email address first.', 'error'); return; }

    setAccountMsg('Sending…');
    try {
        await window.screensaverAPI.authRequest(email);
        accountCodeRow.hidden = false;
        accountCodeEl.focus();
        setAccountMsg('Check your email — copy the link without clicking it, then paste it above.', 'success');
    } catch (err) {
        setAccountMsg(cleanError(err), 'error');
    }
});

document.getElementById('btn-verify').addEventListener('click', doVerify);
accountCodeEl.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });

async function doVerify() {
    const email = accountEmailEl.value.trim();
    const code  = accountCodeEl.value.trim();
    if (!code) { setAccountMsg('Paste the link from the email (or type the code).', 'error'); return; }

    setAccountMsg('Signing in…');
    try {
        const status = await window.screensaverAPI.authVerify(email, code);
        renderAccount(status);
        accountCodeEl.value = '';
        accountCodeRow.hidden = true;
        setAccountMsg('Signed in. Your private feeders are listed below.', 'success');
        await loadFeeders();   // the list widens now that RLS sees the account
    } catch (err) {
        setAccountMsg(cleanError(err), 'error');
    }
}

document.getElementById('btn-signout').addEventListener('click', async () => {
    setAccountMsg('Signing out…');
    try {
        renderAccount(await window.screensaverAPI.authSignOut());
        setAccountMsg('Signed out. Cached photos cleared.', 'success');
        await Promise.all([loadFeeders(), showCacheStats()]);
    } catch (err) {
        setAccountMsg(cleanError(err), 'error');
    }
});

// Electron prefixes IPC errors with "Error invoking remote method '…':".
function cleanError(err) {
    const msg = (err && err.message) || String(err);
    return msg.replace(/^Error invoking remote method '[^']*':\s*/, '')
              .replace(/^Error:\s*/, '');
}

// ── Feeders ────────────────────────────────────────────────

async function loadFeeders() {
    feederListEl.innerHTML = '<p class="feeder-loading">Loading feeders…</p>';
    try {
        renderFeeders(await window.screensaverAPI.listFeeders());
    } catch (err) {
        console.error('Failed to load feeders:', err);
        feederListEl.innerHTML =
            '<p class="feeder-loading">Could not load feeders — showing all photos.</p>';
    }
}

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

// Read the selected feeders from the form.
// Returns [] when all (or none) are selected, meaning "all feeders".
function collectFeeders() {
    const items = [...feederListEl.querySelectorAll('.feeder-item')];
    if (!items.length) return selectedFeeders;
    const checked = items.filter(cb => cb.checked).map(cb => cb.value);
    // All selected → store [] so newly-added feeders are included automatically.
    if (checked.length === items.length) return [];
    return checked;
}

// ── Photo cache ────────────────────────────────────────────

function formatBytes(n) {
    if (!n) return '0 MB';
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

async function showCacheStats() {
    try {
        const { files, bytes } = await window.screensaverAPI.cacheStats();
        cacheStatsEl.textContent = files
            ? `Currently holding ${files} photo${files === 1 ? '' : 's'} (${formatBytes(bytes)}).`
            : 'Nothing cached yet.';
    } catch {
        cacheStatsEl.textContent = '';
    }
}

document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    await window.screensaverAPI.clearCache();
    await showCacheStats();
});

// ── Updates ────────────────────────────────────────────────

async function showVersion() {
    try {
        const v = await window.screensaverAPI.appVersion();
        versionLineEl.textContent = `You have version ${v}. `;
    } catch {
        versionLineEl.textContent = '';
    }
}

// `force` skips the once-a-day cache, for the "Check now" button.
async function showUpdate(force) {
    updateLineEl.textContent = force ? 'Checking…' : '';
    try {
        const info = await window.screensaverAPI.checkUpdate(!!force);
        if (info && info.available) {
            updateLineEl.textContent = '';
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'update-link';
            a.textContent = `Version ${info.version} is available — download it`;
            a.addEventListener('click', (e) => {
                e.preventDefault();
                window.screensaverAPI.openExternal(info.url);
            });
            updateLineEl.appendChild(a);
        } else {
            updateLineEl.textContent = force ? 'That is the latest version.' : '';
        }
    } catch {
        updateLineEl.textContent = force ? 'Could not reach GitHub.' : '';
    }
}

document.getElementById('btn-check-update')
    .addEventListener('click', () => showUpdate(true));

// ── Load / save ────────────────────────────────────────────

async function loadSettings() {
    const settings = await window.screensaverAPI.getSettings();

    transitionEl.value  = settings.transition  || 'random';
    intervalEl.value    = String(settings.interval || 6000);
    sortModeEl.value    = settings.sortMode    || 'random';
    photoAgeEl.value    = settings.photoAge    || 'all';
    refreshEl.value     = String(settings.refreshMinutes || 5);
    cacheMBEl.value     = String(settings.cacheMB || 512);
    showCaptionEl.checked  = settings.showCaption  !== false;
    showProgressEl.checked = settings.showProgress !== false;
    showClockEl.checked    = settings.showClock    !== false;
    playClipsEl.checked    = settings.playClips    !== false;
    checkUpdatesEl.checked = settings.checkUpdates !== false;
    clipEveryEl.value      = String(settings.clipEvery   || 5);
    clipSecondsEl.value    = String(settings.clipSeconds || 12);

    selectedFeeders = Array.isArray(settings.feeders) ? settings.feeders : [];

    await Promise.all([
        refreshAccount(), loadFeeders(), showCacheStats(),
        showVersion(), showUpdate(false),
    ]);
}

document.getElementById('btn-save').addEventListener('click', async () => {
    const settings = {
        transition:     transitionEl.value,
        interval:       parseInt(intervalEl.value, 10),
        sortMode:       sortModeEl.value,
        photoAge:       photoAgeEl.value,
        feeders:        collectFeeders(),
        showCaption:    showCaptionEl.checked,
        showProgress:   showProgressEl.checked,
        showClock:      showClockEl.checked,
        playClips:      playClipsEl.checked,
        clipEvery:      parseInt(clipEveryEl.value, 10),
        clipSeconds:    parseInt(clipSecondsEl.value, 10),
        checkUpdates:   checkUpdatesEl.checked,
        refreshMinutes: parseInt(refreshEl.value, 10),
        cacheMB:        parseInt(cacheMBEl.value, 10),
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
