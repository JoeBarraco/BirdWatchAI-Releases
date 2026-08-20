// BirdWatchAI Community Feed — communities
//
// Named communities (public or private) that feeders publish into and users
// are granted membership in. Three pieces live here:
//
//   1. The feed's community scope filter
//   2. The owner / moderator panel (approve feeder requests, invite people)
//   3. Admin community creation
//
// Design notes: birdwatchai-server/docs/COMMUNITIES.md
// Schema + RLS:  supabase/setup-communities.sql

let myCommunities        = [];    // [{id, slug, name, visibility, role}]
let communityFeederIndex = null;  // Map<communityId, Set<feederId>>
let selectedCommunity    = '';    // '' = everything visible to me

// ── Session ──────────────────────────────────────────────
//
// ⚠ The moderator login is a separate, hand-rolled system: moderator_login
// checks a password against the `moderators` table and bridgeModAsCommunityUser
// fabricates a user object client-side. There is no JWT, so auth.uid() is null
// in Postgres and every community_* RPC below rejects the caller.
//
// So key off the access token, never off currentUser — the mod bridge
// overwrites currentUser but leaves authAccessToken alone. A user signed in
// both ways still has a valid token and everything here keeps working.
function hasAuthSession() {
    return !!authAccessToken;
}

function communityRoleIn(communityId) {
    const c = myCommunities.find(x => x.id === communityId);
    return c ? c.role : null;
}

// ── Loading ──────────────────────────────────────────────

async function loadMyCommunities() {
    if (!hasAuthSession()) { myCommunities = []; renderCommunityFilter(); return; }
    const { data, error } = await sbRpc('community_my_communities', {}, true);
    if (error || !Array.isArray(data)) { myCommunities = []; }
    else { myCommunities = data; }
    renderCommunityFilter();
    updateCommunityNavUI();
}

// feeder_id -> which communities it publishes into. RLS already limits this to
// communities the caller can see, so no extra filtering is needed here: a
// private community's rows simply don't come back for non-members.
async function loadCommunityFeederIndex(force) {
    if (communityFeederIndex && !force) return communityFeederIndex;
    try {
        // Paged rather than `limit=10000`, which the 1000-row response cap made
        // a no-op. A truncated index doesn't degrade gracefully: any community
        // whose memberships fell past the cut has no entry, and
        // communityFilterExcludes then excludes everything for it — the feed
        // just reads empty.
        const rows = await fetchAllRows(
            `${SUPABASE_URL}/rest/v1/community_feeders?select=community_id,feeder_id`
            + `&status=eq.approved&order=community_id`, hasAuthSession());
        if (!rows) return (communityFeederIndex = new Map());
        const idx = new Map();
        rows.forEach(r => {
            if (!idx.has(r.community_id)) idx.set(r.community_id, new Set());
            idx.get(r.community_id).add(r.feeder_id);
        });
        communityFeederIndex = idx;
    } catch {
        communityFeederIndex = new Map();
    }
    return communityFeederIndex;
}

// ── Feed scope filter ────────────────────────────────────

// Called from applyClientFilters in community-core.js. Returns true to DROP the
// detection. Fails open — if the index hasn't loaded, show everything rather
// than blanking the feed.
// The feeder ids in the selected community, or null when no community is
// selected. Lets other views respect the scope without reaching into this
// file's internals — the map uses it to avoid plotting every feeder on the
// platform while you're looking at one community.
function communityScopeFeederIds() {
    if (!selectedCommunity || !communityFeederIndex) return null;
    // An EMPTY set, not null. A community with no approved feeders has no entry
    // in the index, and returning null there told every caller "no scope
    // selected" — so selecting an empty community showed the entire feed.
    // Null must mean "cannot scope"; empty must mean "scopes to nothing".
    return communityFeederIndex.get(selectedCommunity) || new Set();
}

function communityFilterExcludes(d) {
    if (!selectedCommunity) return false;
    // Index not loaded yet — fail open rather than blanking the feed on a race.
    if (!communityFeederIndex) return false;
    const members = communityFeederIndex.get(selectedCommunity);
    // No entry means the community genuinely has no approved feeders. That is
    // an answer, not a failure: exclude everything. Previously this fell open
    // and an empty community displayed the whole feed — a scope filter that
    // shows MORE than asked for when it doesn't recognise its own target.
    if (!members) return true;
    return !members.has(d.feeder_id);
}

function renderCommunityFilter() {
    const group = document.getElementById('community-filter-group');
    const sel   = document.getElementById('community-filter');
    if (!group || !sel) return;

    // Nothing to scope by unless you belong to something. Signed-out visitors
    // see the public feed and no picker at all.
    if (!myCommunities.length) {
        group.style.display = 'none';
        selectedCommunity = '';
        return;
    }

    group.style.display = '';
    const prev = sel.value;
    sel.innerHTML = '<option value="">All I can see</option>' +
        myCommunities.map(c =>
            `<option value="${esc(c.id)}">${esc(c.name)}${c.visibility === 'private' ? ' 🔒' : ''}</option>`
        ).join('');
    sel.value = prev && myCommunities.some(c => c.id === prev) ? prev : '';
    selectedCommunity = sel.value;
}

async function onCommunityFilterChange(value) {
    selectedCommunity = value || '';
    await loadCommunityFeederIndex();
    await scopeDropdownsToCommunity(true);
    if (typeof refilter === 'function') await refilter();
}

// feeder_id -> display_name, for the roster-based Feeder dropdown. Cached
// across community switches; feeder names change rarely and a stale one is
// cosmetic.
const communityFeederNames = new Map();

async function loadCommunityFeederNames(feederIds) {
    const missing = feederIds.filter(id => !communityFeederNames.has(id));
    if (!missing.length) return;
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?id=in.(${missing.join(',')})&select=id,display_name`,
            { headers: sbHeaders(hasAuthSession()) }
        );
        if (!res.ok) return;
        (await res.json()).forEach(f => {
            if (f.id && f.display_name) communityFeederNames.set(f.id, f.display_name);
        });
    } catch {
        // Leave the map short; the caller falls back to the detections-derived list.
    }
}

// Build the Feeder dropdown from the community's ROSTER rather than from
// whatever happens to be in the current results.
//
// The detections-derived list is period-filtered, so a feeder silently appears
// and disappears as you switch between Today and All — for a teacher, "the
// classroom feeder vanished" reads as a fault rather than as "it was quiet
// today". A community's feeders are a stable fact about the community, so the
// roster is the honest list, with quiet ones marked instead of hidden.
//
// Only used when a specific community is selected. On the public feed the
// roster is hundreds of feeders and the detections-derived list is genuinely
// more useful.
//
// Returns false when the roster isn't resolvable, so the caller can fall back.
function populateFeederDropdownFromRoster(inScope) {
    const sel = document.getElementById('feeder-filter');
    if (!sel || !communityFeederIndex) return false;

    // Empty set rather than bailing out: a community with no feeders should
    // render an EMPTY roster. Returning false here fell back to the
    // detections-derived list, which is every feeder in the feed — the exact
    // opposite of what selecting an empty community should show.
    const ids = communityFeederIndex.get(selectedCommunity) || new Set();

    const names = [...ids]
        .map(id => communityFeederNames.get(id))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    // Members exist but none of their names resolved — that IS a failure (the
    // lookup didn't complete), so fall back rather than show a misleadingly
    // empty roster.
    if (ids.size && !names.length) return false;

    // display_name is the filter's value (applyClientFilters matches on
    // d.feeders.display_name), so the "(no detections)" hint goes in the option
    // TEXT only — putting it in the value would silently match nothing.
    const active = new Set(inScope.map(d => d.feeders?.display_name).filter(Boolean));
    const prev = sel.value;
    sel.innerHTML = '<option value="">All feeders</option>' +
        names.map(n =>
            `<option value="${esc(n)}">${esc(n)}${active.has(n) ? '' : ' (no detections)'}</option>`
        ).join('');
    if (names.includes(prev)) sel.value = prev;
    return true;
}

// A community is a SCOPE, not merely another filter: once you are looking at
// one, the other pickers should describe that community rather than the whole
// feed. Without this the Feeder dropdown still lists every feeder on the
// platform, including ones that cannot possibly appear in the current results.
//
// fromCommunityChange separates the two callers, which differ in two ways:
// loadFeed has already populated the dropdowns from the full set and must not
// silently drop the operator's filters on a periodic refresh, while an actual
// community change has populated nothing and owns both restoring the lists
// when the scope is cleared and dropping selections that no longer exist.
async function scopeDropdownsToCommunity(fromCommunityChange) {
    if (typeof allDetections === 'undefined') return;
    // Same hazard as the populate calls in loadFeed: these rosters are derived
    // from the loaded detections, and the server now narrows those to the
    // selected species/rarity/feeder. Deriving a species list from rows already
    // filtered to one species would strand the user on that species.
    if (typeof serverFilterParams === 'function' && serverFilterParams().params) return;

    if (!selectedCommunity) {
        // Back to "All I can see". Returning early here is what left the
        // narrowed roster in place when switching away from a community:
        // loadFeed repopulates from the full set on its own, but the dropdown
        // change has nothing else that would.
        if (fromCommunityChange) {
            if (typeof populateFeederDropdown === 'function') populateFeederDropdown(allDetections);
            if (typeof populateFeedSpeciesDropdown === 'function') populateFeedSpeciesDropdown(allDetections);
            if (typeof populateMapSpeciesDropdown === 'function') populateMapSpeciesDropdown(allDetections);
        }
        return;
    }

    const inScope = allDetections.filter(d => !communityFilterExcludes(d));

    const ids = communityFeederIndex ? communityFeederIndex.get(selectedCommunity) : null;
    if (ids && ids.size) await loadCommunityFeederNames([...ids]);

    const feederSel = document.getElementById('feeder-filter');
    const prevFeeder = feederSel ? feederSel.value : '';
    // Roster first; fall back to the detections-derived list if the roster
    // isn't resolvable (no index yet, or the names fetch failed).
    if (!populateFeederDropdownFromRoster(inScope)
        && typeof populateFeederDropdown === 'function') {
        populateFeederDropdown(inScope);
    }
    if (typeof populateFeedSpeciesDropdown === 'function') populateFeedSpeciesDropdown(inScope);
    if (typeof populateMapSpeciesDropdown === 'function') populateMapSpeciesDropdown(inScope);

    if (!fromCommunityChange) return;

    if (feederSel && prevFeeder &&
        ![...feederSel.options].some(o => o.value === prevFeeder)) {
        feederSel.value = '';
    }
    // populateFeedSpeciesDropdown deliberately leaves selectedSpecies alone, so
    // clear it here rather than there — otherwise a species absent from this
    // community stays applied and filters everything out.
    if (selectedSpecies && !inScope.some(d => d.species === selectedSpecies)) {
        selectedSpecies = '';
        const speciesSel = document.getElementById('species-filter');
        if (speciesSel) speciesSel.value = '';
    }
}

// ── Navbar ───────────────────────────────────────────────

function updateCommunityNavUI() {
    const btn = document.getElementById('navbar-communities-btn');
    if (!btn) return;
    // Only owners and moderators have anything to do in the panel.
    const canManage = myCommunities.some(c => c.role === 'owner' || c.role === 'moderator');
    btn.style.display = canManage ? '' : 'none';
}

// ── Owner / moderator panel ──────────────────────────────

function openCommunityPanel() {
    const modal = document.getElementById('community-panel-modal');
    if (!modal) return;

    if (!hasAuthSession()) {
        showToast('Community management needs an email sign-in — use "Sign In", not Mod login.');
        return;
    }

    const sel = document.getElementById('community-panel-select');
    const manageable = myCommunities.filter(c => c.role === 'owner' || c.role === 'moderator');
    sel.innerHTML = manageable.map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.role)})</option>`
    ).join('');

    modal.classList.add('open');
    if (manageable.length) refreshCommunityPanel();
}

function closeCommunityPanel() {
    document.getElementById('community-panel-modal')?.classList.remove('open');
}

async function refreshCommunityPanel() {
    const cid  = document.getElementById('community-panel-select').value;
    const list = document.getElementById('community-pending-list');
    if (!cid || !list) return;

    // Moderators can approve feeders and invite viewers, but only the owner can
    // mint another moderator — that keeps a compromised teacher account from
    // being an escalation path.
    const isOwner = communityRoleIn(cid) === 'owner';
    const roleSel = document.getElementById('community-invite-role');
    if (roleSel) {
        roleSel.querySelectorAll('option[value="moderator"]')
               .forEach(o => o.disabled = !isOwner);
        if (!isOwner) roleSel.value = 'viewer';
    }

    renderCommunityCode(cid);
    refreshCommunityMembers();   // independent list; let it load in parallel

    list.innerHTML = '<li>Loading…</li>';
    // The full roster, not just the approval queue — pending first. One list
    // rather than two, so a pending feeder doesn't appear twice.
    const { data, error } = await sbRpc('community_feeders_list', { p_community_id: cid }, true);
    if (error) {
        list.innerHTML = `<li style="color:#e74c3c">${esc(error.message || 'Failed to load')}</li>`;
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<li style="color:var(--color-gray-500)">No feeders have joined this community yet.</li>';
        return;
    }

    list.innerHTML = data.map(f => {
        const name = esc(f.display_name || 'Unnamed feeder');
        const meta = [
            f.status === 'pending'
                ? 'requested ' + fmtDetectedAt(f.requested_at)
                : f.status === 'approved' ? 'publishing' : 'declined',
            // Whether the feeder is ALSO on the public feed is the thing an
            // owner most needs to know and can't otherwise see: being in this
            // private community does not make it private.
            f.is_public ? '🌐 also public' : '🔒 private only',
            f.app_version ? 'v' + f.app_version : '',
        ].filter(Boolean).join(' · ');

        const actions = f.status === 'pending'
            ? `<button onclick="decideFeeder('${esc(cid)}','${esc(f.feeder_id)}','approved')">Approve</button>
               <button class="mod-remove-btn" onclick="decideFeeder('${esc(cid)}','${esc(f.feeder_id)}','rejected')">Reject</button>`
            : f.status === 'approved'
                ? `<button class="mod-remove-btn" onclick="removeFeederFromCommunity('${esc(cid)}','${esc(f.feeder_id)}','${esc(f.display_name || 'this feeder')}')">Remove</button>`
                : `<button onclick="decideFeeder('${esc(cid)}','${esc(f.feeder_id)}','approved')">Approve</button>`;

        return `
            <li>
                <div class="mod-user-info">
                    <strong>${name}</strong>
                    <span style="font-size:0.75rem;color:var(--color-gray-500);">${esc(meta)}</span>
                </div>
                <span>${actions}</span>
            </li>`;
    }).join('');
}

// Show the join code for the selected community.
//
// The code is the community's slug, and it was previously visible only in the
// one-line confirmation shown at creation — dismiss that and the only way back
// to it was a SQL query. A private community cannot be joined without it, so
// it belongs where the owner already is.
function renderCommunityCode(communityId) {
    const el = document.getElementById('community-code-line');
    if (!el) return;

    const c = myCommunities.find(x => x.id === communityId);
    if (!c) { el.innerHTML = ''; return; }

    el.innerHTML = `
        <span style="color:var(--color-gray-500);">Join code:</span>
        <code style="background:var(--bg-page);padding:2px 6px;border-radius:4px;">${esc(c.slug)}</code>
        <button onclick="copyCommunityCode('${esc(c.slug)}')"
                style="margin-left:0.4rem;font-size:0.75rem;">Copy</button>
        <span style="color:var(--color-gray-500);">
            — feeder owners enter this in Settings → Community
        </span>`;
}

async function copyCommunityCode(slug) {
    try {
        await navigator.clipboard.writeText(slug);
        showToast(`Copied "${slug}"`);
    } catch {
        // Clipboard access needs a secure context and can be refused; the code
        // is on screen either way, so say so rather than failing silently.
        showToast(`Copy failed — the code is ${slug}`);
    }
}

async function refreshCommunityMembers() {
    const cid  = document.getElementById('community-panel-select').value;
    const list = document.getElementById('community-member-list');
    if (!cid || !list) return;

    const isOwner = communityRoleIn(cid) === 'owner';
    list.innerHTML = '<li>Loading…</li>';

    const { data, error } = await sbRpc('community_members_list', { p_community_id: cid }, true);
    if (error) {
        list.innerHTML = `<li style="color:#e74c3c">${esc(error.message || 'Failed to load')}</li>`;
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<li style="color:var(--color-gray-500)">Nobody has been invited yet.</li>';
        return;
    }

    list.innerHTML = data.map(m => {
        const invited = m.kind === 'invite';
        const meta = invited
            ? `invited as ${m.role} · hasn't signed in yet`
            : `${m.role}${m.email && m.email !== m.label ? ' · ' + m.email : ''}`;

        // The owner can't be removed, and only an owner may remove a moderator
        // — the server enforces both; this just avoids offering a button that
        // will fail.
        let action = '';
        if (invited) {
            action = `<button class="mod-remove-btn" onclick="revokeInviteFor('${esc(cid)}','${esc(m.id)}')">Revoke</button>`;
        } else if (m.role === 'owner') {
            action = '<span style="font-size:0.75rem;color:var(--color-gray-500);">owner</span>';
        } else if (m.role !== 'moderator' || isOwner) {
            action = `<button class="mod-remove-btn" onclick="removeCommunityMember('${esc(cid)}','${esc(m.id)}','${esc(m.label)}')">Remove</button>`;
        }

        return `
            <li>
                <div class="mod-user-info">
                    <strong>${esc(m.label)}</strong>
                    <span style="font-size:0.75rem;color:var(--color-gray-500);">${esc(meta)}</span>
                </div>
                <span>${action}</span>
            </li>`;
    }).join('');
}

async function removeCommunityMember(communityId, userId, label) {
    if (!confirm(
        `Remove ${label} from this community?\n\n` +
        'They immediately lose access to its feeders and sightings. Their account, ' +
        'life list and comments are untouched, and you can invite them again.\n\nContinue?'
    )) return;

    const { error } = await sbRpc('community_remove_member', {
        p_community_id: communityId,
        p_user_id:      userId,
    }, true);
    if (error) { showToast('Error: ' + (error.message || 'remove failed')); return; }
    showToast(`Removed ${label}.`);
    await refreshCommunityMembers();
}

async function revokeInviteFor(communityId, email) {
    if (!confirm(`Revoke the invite for ${email}?\n\nThey won't gain access when they next sign in.`)) return;

    const { error } = await sbRpc('community_revoke_invite', {
        p_community_id: communityId,
        p_email:        email,
    }, true);
    if (error) { showToast('Error: ' + (error.message || 'revoke failed')); return; }
    showToast(`Invite for ${email} revoked.`);
    await refreshCommunityMembers();
}

async function removeFeederFromCommunity(communityId, feederId, displayName) {
    if (!confirm(
        `Remove "${displayName}" from this community?\n\n` +
        'It stops publishing here and its sightings disappear for members. ' +
        'If this was its only community it becomes invisible on the site entirely — ' +
        'nothing is deleted, and it can request to join again.\n\nContinue?'
    )) return;

    const { error } = await sbRpc('community_remove_feeder', {
        p_community_id: communityId,
        p_feeder_id:    feederId,
    }, true);
    if (error) { showToast('Error: ' + (error.message || 'remove failed')); return; }

    showToast(`Removed "${displayName}".`);
    await loadCommunityFeederIndex(true);
    await refreshCommunityPanel();
    if (typeof invalidateDropdownCache === 'function') invalidateDropdownCache();
    if (typeof loadFeed === 'function') loadFeed();
}

async function decideFeeder(communityId, feederId, decision) {
    const { error } = await sbRpc('community_decide_feeder', {
        p_community_id: communityId,
        p_feeder_id:    feederId,
        p_decision:     decision,
    }, true);
    if (error) { showToast('Error: ' + (error.message || decision + ' failed')); return; }
    showToast(decision === 'approved' ? 'Feeder approved.' : 'Feeder rejected.');
    // Membership changed, so the feeder→community index and the feed are stale.
    await loadCommunityFeederIndex(true);
    await refreshCommunityPanel();
}

async function inviteToCommunity() {
    const cid   = document.getElementById('community-panel-select').value;
    const email = document.getElementById('community-invite-email').value.trim();
    const role  = document.getElementById('community-invite-role').value;
    const status = document.getElementById('community-invite-status');
    if (!cid || !email) { showToast('An email address is required'); return; }

    const { error } = await sbRpc('community_invite', {
        p_community_id: cid, p_email: email, p_role: role,
    }, true);
    if (error) {
        status.style.color = '#e74c3c';
        status.textContent = 'Error: ' + (error.message || 'invite failed');
        status.style.display = 'block';
        return;
    }
    document.getElementById('community-invite-email').value = '';
    await refreshCommunityMembers();
    status.style.color = '#2eaa4f';
    // No email is sent. Invites are keyed by address and redeemed by
    // community_redeem_invites() on the recipient's next sign-in, so all they
    // have to do is sign in with this address — nothing to forward, and no
    // token to leak.
    status.textContent = `${email} invited as ${role}. They get access the next time they sign in with that address.`;
    status.style.display = 'block';
}

async function revokeCommunityInvite() {
    const cid   = document.getElementById('community-panel-select').value;
    const email = document.getElementById('community-invite-email').value.trim();
    if (!cid || !email) { showToast('Enter the address to revoke'); return; }
    if (!confirm(`Revoke the invite for ${email}?`)) return;

    const { data, error } = await sbRpc('community_revoke_invite', {
        p_community_id: cid, p_email: email,
    }, true);
    if (error) { showToast('Error: ' + (error.message || 'revoke failed')); return; }
    showToast(data ? `Invite for ${email} revoked.` : 'No pending invite for that address.');
    document.getElementById('community-invite-email').value = '';
}

// ── Sign-out ─────────────────────────────────────────────
//
// Signing out clears the token, but everything already fetched stays in memory:
// myCommunities keeps the scope filter populated with private communities,
// communityFeederIndex keeps the feeder→community mapping, allDetections still
// holds the private rows, and signedUrlCache still holds working media links.
// The sign-out handler then calls renderFeed(), which redraws all of it.
//
// Nothing here was fetched without authorization, so this is not a server-side
// hole — a visitor who never signed in sees none of it. But on a shared
// classroom machine "the teacher signed out and the school's feed is still on
// screen" is exactly the failure this feature exists to prevent.
//
// Callers must also refetch the feed, so allDetections is rebuilt as anon.
function clearCommunityState() {
    myCommunities = [];
    communityFeederIndex = null;
    selectedCommunity = '';
    signedUrlCache.clear();
    communityFeederNames.clear();
    const sel = document.getElementById('community-filter');
    if (sel) sel.value = '';
    renderCommunityFilter();
    updateCommunityNavUI();
    closeCommunityPanel();
}

// ── Private media ────────────────────────────────────────
//
// Media for a private feeder lives in a non-public bucket, so there is no
// readable URL. The server writes a marker — private://bucket/path — and the
// browser exchanges it for a short-lived signed URL. Supabase evaluates storage
// RLS when signing, so only a member of a community that feeder publishes into
// can produce a working link; that check is the entire enforcement.
//
// Resolution happens in ONE pass right after each load, rewriting image_url and
// video_url in place. Every render site downstream — feed cards, detail modal,
// gallery, slideshow, lightbox, map popups, CSV — then works unchanged, which
// is the difference between touching one function and touching a dozen.

const PRIVATE_URL_PREFIX  = 'private://';
const SIGNED_URL_TTL_SECS = 7200;   // 2h: long enough for a slideshow left open

// path -> { url, expiresAt }. Keyed by the full marker so the 30s auto-refresh
// doesn't re-sign the same objects every tick.
const signedUrlCache = new Map();

function isPrivateMedia(u) {
    return typeof u === 'string' && u.startsWith(PRIVATE_URL_PREFIX);
}

async function signPrivateMedia(detections) {
    if (!Array.isArray(detections) || !detections.length) return;

    const now = Date.now();
    const wanted = new Set();
    for (const d of detections) {
        if (isPrivateMedia(d.image_url)) wanted.add(d.image_url);
        if (isPrivateMedia(d.video_url)) wanted.add(d.video_url);
    }
    if (!wanted.size) return;

    // Signed-out visitors never receive private rows (RLS filters them), so
    // reaching here without a session means something upstream changed. Blank
    // the markers rather than letting a "private://…" land in an <img src>.
    if (!hasAuthSession()) {
        for (const d of detections) {
            if (isPrivateMedia(d.image_url)) d.image_url = null;
            if (isPrivateMedia(d.video_url)) d.video_url = null;
        }
        return;
    }

    // Group the not-yet-cached markers by bucket — Supabase signs in batches of
    // paths per bucket.
    const byBucket = new Map();
    for (const marker of wanted) {
        const hit = signedUrlCache.get(marker);
        if (hit && hit.expiresAt > now) continue;
        const rest   = marker.slice(PRIVATE_URL_PREFIX.length);
        const slash  = rest.indexOf('/');
        if (slash < 1) continue;
        const bucket = rest.slice(0, slash);
        const path   = rest.slice(slash + 1);
        if (!byBucket.has(bucket)) byBucket.set(bucket, []);
        byBucket.get(bucket).push({ marker, path });
    }

    for (const [bucket, items] of byBucket) {
        try {
            const res = await fetch(
                `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
                {
                    method: 'POST',
                    headers: sbHeaders(true),
                    body: JSON.stringify({
                        expiresIn: SIGNED_URL_TTL_SECS,
                        paths: items.map(i => i.path),
                    }),
                }
            );
            if (!res.ok) continue;
            const rows = await res.json();
            if (!Array.isArray(rows)) continue;

            rows.forEach((r, i) => {
                // signedURL comes back relative, e.g. /object/sign/bucket/x?token=…
                if (!r || !r.signedURL) return;
                const item = items[i];
                if (!item) return;
                signedUrlCache.set(item.marker, {
                    url: `${SUPABASE_URL}/storage/v1${r.signedURL}`,
                    // Expire the cache entry early so a link is never handed to
                    // an <img> in the last minutes of its life.
                    expiresAt: now + (SIGNED_URL_TTL_SECS - 300) * 1000,
                });
            });
        } catch {
            // Leave these markers unresolved; the loop below blanks them.
        }
    }

    for (const d of detections) {
        if (isPrivateMedia(d.image_url)) {
            const hit = signedUrlCache.get(d.image_url);
            d.image_url = hit && hit.expiresAt > now ? hit.url : null;
        }
        if (isPrivateMedia(d.video_url)) {
            const hit = signedUrlCache.get(d.video_url);
            d.video_url = hit && hit.expiresAt > now ? hit.url : null;
        }
    }
}

// ── Redeem on sign-in ────────────────────────────────────
//
// The other half of the email-keyed invite design: an invited person usually
// has no auth.users row when the invite is created, so the membership can only
// be materialized once they actually show up. Call this after every successful
// sign-in. Cheap and idempotent when there's nothing to claim.
async function redeemCommunityInvites() {
    if (!hasAuthSession()) return;
    const { data, error } = await sbRpc('community_redeem_invites', {}, true);
    if (error) return;
    if (data && data.claimed > 0) {
        showToast(`You've been added to ${data.claimed} communit${data.claimed === 1 ? 'y' : 'ies'}.`);
    }
    await loadMyCommunities();
}

// ── Admin: create a community ────────────────────────────
//
// Creation stays admin-only rather than self-serve: open creation invites name
// squatting, and every school is a sales conversation anyway.
//
// Authenticated with moderator credentials rather than a JWT, matching
// moderator_add_user and friends — the admin identity lives in the `moderators`
// table and has no Supabase Auth session. The OWNER, by contrast, must be a
// real auth.users row, because community ownership is enforced by RLS through
// auth.uid(). Hence the owner-email field: the admin hands the community to the
// teacher who will actually run it.
async function createCommunityFromAdmin() {
    const name       = document.getElementById('community-create-name').value.trim();
    const slug       = document.getElementById('community-create-slug').value.trim().toLowerCase();
    const visibility = document.getElementById('community-create-visibility').value;
    const ownerEmail = document.getElementById('community-create-owner').value.trim();
    const status     = document.getElementById('community-create-status');

    const fail = msg => {
        status.style.color = '#e74c3c';
        status.textContent = msg;
        status.style.display = 'block';
    };

    if (!name || !slug || !ownerEmail) { showToast('Name, code and owner email are required'); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) {
        fail('Code must be lowercase letters, numbers and hyphens only.');
        return;
    }

    const { email, password } = getModCreds();
    const { data, error } = await sbRpc('community_admin_create', {
        p_email:       email,
        p_password:    password,
        p_slug:        slug,
        p_name:        name,
        p_visibility:  visibility,
        p_owner_email: ownerEmail,
    }, false);

    if (error) {
        // The most common failure by far: the intended owner has never signed
        // in, so there's no auth.users row to point at. Say so plainly.
        fail('Error: ' + (error.message || 'create failed'));
        return;
    }

    status.style.color = '#2eaa4f';
    status.textContent = `Created "${name}". Feeder owners join with the code: ${slug}`;
    status.style.display = 'block';
    document.getElementById('community-create-name').value  = '';
    document.getElementById('community-create-slug').value  = '';
    document.getElementById('community-create-owner').value = '';
    await refreshCommunityAdminList();
    await loadMyCommunities();
}

// ── Admin: the community roster ──────────────────────────

// Self-wiring: this file owns both the button hook and the function, so the
// section works whenever THIS file is current, regardless of what version of
// community-auth.js the CDN happens to be serving. The inline
// onclick="openAdminPanel()" still runs; this listener fires alongside it.
document.getElementById('navbar-admin-btn')
    ?.addEventListener('click', () => { refreshCommunityAdminList(); });

async function refreshCommunityAdminList() {
    const list = document.getElementById('community-admin-list');
    if (!list) return;

    const { email, password } = getModCreds();
    if (!email) { list.innerHTML = ''; return; }

    list.innerHTML = '<li style="color:var(--color-gray-500)">Loading…</li>';

    // Everything below is wrapped: an exception here used to leave the section
    // sitting on "Loading…" forever, which is indistinguishable from a hung
    // request and tells the operator nothing.
    let data, error;
    try {
        ({ data, error } = await sbRpc('community_admin_list',
            { p_email: email, p_password: password }, false));
    } catch (err) {
        list.innerHTML = `<li style="color:#e74c3c">${esc(err.message || 'Request failed')}</li>`;
        return;
    }

    if (error) {
        list.innerHTML = `<li style="color:#e74c3c">${esc(error.message || 'Failed to load')}</li>`;
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<li style="color:var(--color-gray-500)">No communities yet.</li>';
        return;
    }

    list.innerHTML = data.map(c => {
        const counts = `${c.feeder_count} feeder${c.feeder_count === 1 ? '' : 's'} · ` +
                       `${c.member_count} member${c.member_count === 1 ? '' : 's'}`;
        const meta = `${c.visibility === 'private' ? '🔒 private' : '🌐 public'} · code ${c.slug} · ${counts}`;

        // Delete is offered ONLY for an empty community, and never for the
        // built-in public feed. The server enforces both; this keeps a button
        // that is guaranteed to fail off the screen.
        const action = (c.slug !== 'public' && c.feeder_count === 0)
            ? `<button class="mod-remove-btn" onclick="deleteCommunityAsAdmin('${esc(c.id)}','${esc(c.name)}')">Delete</button>`
            : `<span style="font-size:0.75rem;color:var(--color-gray-500);">${
                   c.slug === 'public' ? 'built-in' : 'has feeders'}</span>`;

        return `
            <li>
                <div class="mod-user-info">
                    <strong>${esc(c.name)}</strong>
                    <span style="font-size:0.75rem;color:var(--color-gray-500);">${esc(meta)}</span>
                </div>
                <span>${action}</span>
            </li>`;
    }).join('');
}

async function deleteCommunityAsAdmin(communityId, name) {
    if (!confirm(
        `Delete the community "${name}"?\n\n` +
        'Its members and any outstanding invites are removed with it. No feeders, ' +
        'detections, photos or user accounts are touched.\n\nThis cannot be undone.'
    )) return;

    const { email, password } = getModCreds();
    const { error } = await sbRpc('community_admin_delete', {
        p_email: email, p_password: password, p_community_id: communityId,
    }, false);

    if (error) { showToast('Error: ' + (error.message || 'delete failed')); return; }

    showToast(`Deleted "${name}".`);
    await refreshCommunityAdminList();
    await loadMyCommunities();   // it may have been in the viewer's own list
}

// Suggest a slug from the typed name, but let the admin override it — the slug
// is what feeder owners type in, so it wants to be short and memorable.
function suggestCommunitySlug() {
    const nameEl = document.getElementById('community-create-name');
    const slugEl = document.getElementById('community-create-slug');
    if (!nameEl || !slugEl || slugEl.dataset.touched === '1') return;
    slugEl.value = nameEl.value.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
