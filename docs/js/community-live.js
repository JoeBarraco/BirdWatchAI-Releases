// BirdWatchAI Community — live view ("🔴 Watch live" on feeder cards).
//
// Feeders that have "Allow live view" ticked keep an idle connection to the BirdWatch live relay
// (live.birdwatchai.com). This file:
//   1. finds out which visible feeders are connected right now (relay /online/<device key>), and
//      gives those a "Watch live" button on their card;
//   2. on click, gets a 5-minute viewer token from the live-token edge function — which checks,
//      as the signed-in member, that they can see the feeder (private feeders: members only) —
//      and plays the stream in a modal using live-view.js.
//
// The video goes browser ⇄ relay directly; nothing streams through Supabase.
// Needs: community-core.js (SUPABASE_URL, sbHeaders, sbAuthed), community-social.js (esc),
//        community-views.js (allFeeders, feederIsOnline, renderFeeders), live-view.js.

const LIVE_RELAY_WS   = 'wss://live.birdwatchai.com';
const LIVE_RELAY_HTTP = 'https://live.birdwatchai.com';

const liveDeviceKeys = new Map();   // feeder id -> device_key (from the feeders table, RLS-scoped)
const liveState      = new Map();   // device_key -> true/false, as last reported by the relay
let   liveScanTimer  = null;
let   liveScanBusy   = false;
let   liveView       = null;   // the open player, if any

// Fill in device keys for feeder ids we haven't looked up yet. RLS-scoped: a private feeder the
// visitor can't see simply never gets a key, so never gets a button.
async function liveResolveKeys(ids) {
    const missing = [...new Set(ids)].filter(id => id && !liveDeviceKeys.has(id));
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?select=id,device_key&id=in.(${chunk.map(encodeURIComponent).join(',')})`,
            { headers: sbHeaders(sbAuthed()) });
        if (!res.ok) continue;
        const rows = await res.json();
        for (const id of chunk) liveDeviceKeys.set(id, null);      // remember misses too
        for (const row of rows) liveDeviceKeys.set(String(row.id), row.device_key || null);
    }
}

// Ask the relay which of these feeders are offering live view. Returns true if anything changed.
async function liveCheck(ids) {
    await liveResolveKeys(ids);
    const keys = [...new Set(ids.map(id => liveDeviceKeys.get(id)).filter(Boolean))].slice(0, 60);
    let changed = false;
    await Promise.all(keys.map(async key => {
        let online = false;
        try {
            const r = await fetch(`${LIVE_RELAY_HTTP}/online/${encodeURIComponent(key)}`, { cache: 'no-store' });
            online = r.ok && !!(await r.json()).online;
        } catch { /* relay unreachable: treat as not live */ }
        if (liveState.get(key) !== online) changed = true;
        liveState.set(key, online);
    }));
    return changed;
}

function liveIsOn(feederId) {
    const key = liveDeviceKeys.get(String(feederId || ''));
    return !!key && liveState.get(key) === true;
}

// ── Feeders tab ─────────────────────────────────────────
// Called after every loadFeeders(); re-renders the grid only if a feeder went live or stopped.
async function refreshLiveAvailability(feeders) {
    if (!Array.isArray(feeders) || !feeders.length) return;
    try {
        const ids = feeders
            .filter(f => typeof feederIsOnline !== 'function' || feederIsOnline(f))
            .map(f => String(f.id || f.feeder_id || ''))
            .filter(Boolean);
        if (await liveCheck(ids)) {
            if (typeof renderFeeders === 'function') renderFeeders();
            liveUpdateSlots();
        }
    } catch (e) {
        console.warn('Live view: availability check failed', e);
    }
}

function liveButtonHtml(f) {
    const id = String(f.id || f.feeder_id || '');
    if (!liveIsOn(id)) return '';
    return `<button class="feeder-watch-live" data-device-key="${esc(liveDeviceKeys.get(id))}" data-feeder-name="${esc(f.display_name || 'Feeder')}" onclick="openLiveView(this)" title="Watch this feeder live">🔴 Live</button>`;
}

// ── Detection cards ─────────────────────────────────────
// Cards render a placeholder; a background scan fills in the ones whose feeder is live, without
// re-rendering the feed (which would reset scroll and images).
function liveSlotHtml(feederId, feederName) {
    const id = String(feederId || '');
    liveScheduleScan(400);
    return `<span class="live-slot" data-feeder-id="${esc(id)}" data-feeder-name="${esc(feederName || 'Feeder')}">${liveSlotInner(id, feederName)}</span>`;
}

function liveSlotInner(id, name) {
    if (!liveIsOn(id)) return '';
    return `<button class="card-watch-live" data-device-key="${esc(liveDeviceKeys.get(id))}" data-feeder-name="${esc(name || 'Feeder')}" onclick="openLiveView(this)" title="Watch this feeder live">🔴 Watch live</button>`;
}

function liveUpdateSlots() {
    document.querySelectorAll('.live-slot').forEach(el => {
        const html = liveSlotInner(el.dataset.feederId, el.dataset.feederName);
        if (el.innerHTML !== html) el.innerHTML = html;
    });
}

function liveScheduleScan(delayMs) {
    if (liveScanTimer) return;
    liveScanTimer = setTimeout(liveScan, delayMs);
}

async function liveScan() {
    liveScanTimer = null;
    if (liveScanBusy) return;
    liveScanBusy = true;
    try {
        const ids = [...document.querySelectorAll('.live-slot')].map(el => el.dataset.feederId).filter(Boolean);
        if (ids.length && !document.hidden) {
            await liveCheck(ids);
            liveUpdateSlots();
        }
    } catch (e) {
        console.warn('Live view: feed scan failed', e);
    } finally {
        liveScanBusy = false;
        // Keep the buttons honest while the page is open: feeders come and go.
        liveScheduleScan(45000);
    }
}

async function liveViewToken(deviceKey) {
    const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
    const res = await fetch(`${functionsUrl}/live-token?feeder=${encodeURIComponent(deviceKey)}`, {
        headers: sbHeaders(sbAuthed()),
    });
    if (!res.ok) throw new Error(`live-token ${res.status}`);
    return (await res.json()).token;
}

function openLiveView(btn) {
    const key = btn?.dataset?.deviceKey;
    if (!key || typeof BirdWatchLive === 'undefined') return;
    closeLiveView();

    const overlay = document.createElement('div');
    overlay.id = 'live-view-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', `${btn.dataset.feederName} — live`);
    overlay.innerHTML = `
        <div class="live-view-dialog">
            <div class="live-view-header">
                <strong>${esc(btn.dataset.feederName)}</strong> <span class="live-view-sub">live</span>
                <button class="live-view-close" onclick="closeLiveView()" aria-label="Close">✕</button>
            </div>
            <div class="live-view-player"></div>
            <p class="live-view-note">A few frames a second, no sound. Closes itself after 30 minutes.</p>
        </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeLiveView(); });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', liveViewEsc);

    liveView = BirdWatchLive.mount(overlay.querySelector('.live-view-player'), {
        relayUrl: LIVE_RELAY_WS,
        feederId: key,
        fps: 3,
        getToken: () => liveViewToken(key),
    });
}

function liveViewEsc(e) { if (e.key === 'Escape') closeLiveView(); }

function closeLiveView() {
    if (liveView) { liveView.destroy(); liveView = null; }
    document.getElementById('live-view-modal')?.remove();
    document.removeEventListener('keydown', liveViewEsc);
}

(function injectLiveViewStyles() {
    if (document.getElementById('live-view-styles')) return;
    const s = document.createElement('style');
    s.id = 'live-view-styles';
    s.textContent = `
        .card-watch-live{background:none;border:0;padding:0;margin:0;font:inherit;font-size:12px;
            color:#d33;font-weight:600;cursor:pointer;text-align:left}
        .card-watch-live:hover{text-decoration:underline}
        .live-slot:empty{display:none}
        #live-view-modal{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.7);
            display:flex;align-items:center;justify-content:center;padding:16px}
        #live-view-modal .live-view-dialog{background:var(--color-white,#fff);color:inherit;border-radius:12px;
            width:min(960px,100%);padding:12px 12px 8px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
        #live-view-modal .live-view-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
        #live-view-modal .live-view-sub{color:#d33;font-weight:600;text-transform:uppercase;font-size:12px}
        #live-view-modal .live-view-close{margin-left:auto;border:0;background:none;font-size:20px;cursor:pointer}
        #live-view-modal .live-view-note{margin:6px 2px 0;font-size:12px;opacity:.7}`;
    document.head.appendChild(s);
})();
