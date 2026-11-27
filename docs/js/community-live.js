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
let   liveOnlineKeys = new Set();   // device keys currently offering live view
let   liveRefreshBusy = false;
let   liveView = null;              // the open player, if any

// Called after every loadFeeders(). Cheap: one feeders query for ids we haven't seen, plus one
// tiny relay request per feeder that's online. Re-renders the grid only if the set changed.
async function refreshLiveAvailability(feeders) {
    if (liveRefreshBusy || !Array.isArray(feeders) || !feeders.length) return;
    liveRefreshBusy = true;
    try {
        const ids = feeders.map(f => String(f.id || f.feeder_id || '')).filter(Boolean);
        const missing = ids.filter(id => !liveDeviceKeys.has(id));
        if (missing.length) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/feeders?select=id,device_key&id=in.(${missing.map(encodeURIComponent).join(',')})`,
                { headers: sbHeaders(sbAuthed()) });
            if (res.ok) {
                for (const row of await res.json()) {
                    if (row.device_key) liveDeviceKeys.set(String(row.id), row.device_key);
                }
            }
        }

        const candidates = feeders
            .filter(f => typeof feederIsOnline !== 'function' || feederIsOnline(f))
            .map(f => liveDeviceKeys.get(String(f.id || f.feeder_id || '')))
            .filter(Boolean);

        const results = await Promise.all(candidates.map(async key => {
            try {
                const r = await fetch(`${LIVE_RELAY_HTTP}/online/${encodeURIComponent(key)}`, { cache: 'no-store' });
                return r.ok && (await r.json()).online ? key : null;
            } catch { return null; }   // relay unreachable: just no buttons
        }));
        const next = new Set(results.filter(Boolean));

        const changed = next.size !== liveOnlineKeys.size || [...next].some(k => !liveOnlineKeys.has(k));
        liveOnlineKeys = next;
        if (changed && typeof renderFeeders === 'function') renderFeeders();
    } catch (e) {
        console.warn('Live view: availability check failed', e);
    } finally {
        liveRefreshBusy = false;
    }
}

// Button for a feeder card, or '' when that feeder isn't offering live view right now.
function liveButtonHtml(f) {
    const key = liveDeviceKeys.get(String(f.id || f.feeder_id || ''));
    if (!key || !liveOnlineKeys.has(key)) return '';
    return `<button class="feeder-watch-live" data-device-key="${esc(key)}" data-feeder-name="${esc(f.display_name || 'Feeder')}" onclick="openLiveView(this)" title="Watch this feeder live">🔴 Watch live</button>`;
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
        .feeder-watch-live{background:#d33;color:#fff;border:0;border-radius:6px;padding:6px 10px;
            font-weight:600;cursor:pointer}
        .feeder-watch-live:hover{background:#b22}
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
