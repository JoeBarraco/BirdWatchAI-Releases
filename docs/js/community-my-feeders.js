// ── My feeders: link this account to the feeders it owns ─────────────────
//
// Server side: supabase/setup-feeder-owners.sql. The desktop app shows a
// one-time code (made with the feeder's secret write token); typing it here
// calls feeder_claim(), which records this account as an owner. Owned
// feeders are what make "🏠 At my feeder" appear on the life list.
//
// MY_FEEDERS_READY gates the menu entry: the website half is useless until
// the desktop app can show a code. Flip it to true when an app release with
// "Link to my account" is out. The dialog itself works either way, and
// ?myfeeders=1 opens it for testing.
const MY_FEEDERS_READY = false;

function updateMyFeedersNavUI() {
    const btn = document.getElementById('navbar-my-feeders');
    if (!btn) return;
    const signedIn = typeof hasAuthSession === 'function' && hasAuthSession();
    btn.style.display = (MY_FEEDERS_READY && signedIn) ? '' : 'none';
}

function openMyFeeders() {
    if (typeof hasAuthSession !== 'function' || !hasAuthSession()) { openUserLogin(); return; }
    document.getElementById('my-feeders-modal').classList.add('open');
    document.getElementById('my-feeders-status').textContent = '';
    loadMyFeeders();
}

function closeMyFeeders() {
    document.getElementById('my-feeders-modal').classList.remove('open');
}

async function loadMyFeeders() {
    const list = document.getElementById('my-feeders-list');
    list.innerHTML = '<li class="classroom-muted">Loading…</li>';
    const { data, error } = await sbRpc('my_feeders', {}, true);
    if (error) { list.innerHTML = `<li class="classroom-muted">${esc(error.message || 'Could not load your feeders.')}</li>`; return; }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
        list.innerHTML = '<li class="classroom-muted">No feeders linked yet.</li>';
        return;
    }
    const online = iso => iso && (Date.now() - new Date(iso).getTime()) < 10 * 60 * 1000;
    list.innerHTML = rows.map(f => `
        <li class="mf-row">
            <span class="mf-name">
                <span class="classroom-dot ${online(f.last_heartbeat_at) ? 'on' : 'off'}"></span>
                ${esc(f.display_name || 'Feeder')}
                <span class="classroom-muted">· ${f.is_public ? 'public' : 'private'}</span>
            </span>
            <button type="button" class="classroom-btn" onclick="unclaimMyFeeder('${escJs(f.feeder_id)}', '${escJs(f.display_name || 'this feeder')}')">Unlink</button>
        </li>`).join('');
}

async function claimMyFeeder() {
    const input = document.getElementById('my-feeders-code');
    const status = document.getElementById('my-feeders-status');
    const code = (input.value || '').trim();
    if (!code) { status.textContent = 'Type the code shown in the BirdWatchAI app.'; return; }
    status.textContent = 'Linking…';
    const { data, error } = await sbRpc('feeder_claim', { p_code: code }, true);
    if (error) { status.textContent = error.message || 'That code did not work.'; return; }
    input.value = '';
    status.textContent = '';
    showToast(`Linked: ${(data && data.display_name) || 'your feeder'}`);
    loadMyFeeders();
    if (typeof loadAndRenderLifeList === 'function'
        && document.getElementById('life-list-modal').classList.contains('open')) {
        loadAndRenderLifeList(currentUser.id, true);
    }
}

async function unclaimMyFeeder(feederId, name) {
    if (!confirm(`Unlink ${name} from your account? The feeder keeps working; it just stops counting as yours here.`)) return;
    const { error } = await sbRpc('feeder_unclaim', { p_feeder_id: feederId }, true);
    if (error) { showToast(error.message || 'Could not unlink it.'); return; }
    loadMyFeeders();
}

document.getElementById('my-feeders-modal')?.addEventListener('click', e => {
    if (e.target.id === 'my-feeders-modal') closeMyFeeders();
});
document.getElementById('my-feeders-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') claimMyFeeder();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMyFeeders();
});

// Keep the menu entry in step with sign-in, without touching community-auth.js:
// watch the Sign Out item's visibility, which updateCommunityUI drives.
(function () {
    const signOut = document.getElementById('navbar-community-logout');
    if (signOut) new MutationObserver(updateMyFeedersNavUI)
        .observe(signOut, { attributes: true, attributeFilter: ['style'] });
    updateMyFeedersNavUI();
    try {
        if (new URLSearchParams(location.search).get('myfeeders') === '1') {
            window.addEventListener('load', () => setTimeout(openMyFeeders, 1500));
        }
    } catch (_) { /* no */ }
})();
