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
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/community_feeders?select=community_id,feeder_id&status=eq.approved&limit=10000`,
            { headers: sbHeaders(hasAuthSession()) }
        );
        if (!res.ok) return (communityFeederIndex = new Map());
        const rows = await res.json();
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
function communityFilterExcludes(d) {
    if (!selectedCommunity) return false;
    if (!communityFeederIndex) return false;
    const members = communityFeederIndex.get(selectedCommunity);
    if (!members) return false;
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
    if (typeof refilter === 'function') await refilter();
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

    list.innerHTML = '<li>Loading…</li>';
    const { data, error } = await sbRpc('community_pending_feeders', { p_community_id: cid }, true);
    if (error) {
        list.innerHTML = `<li style="color:#e74c3c">${esc(error.message || 'Failed to load')}</li>`;
        return;
    }
    if (!Array.isArray(data) || !data.length) {
        list.innerHTML = '<li style="color:var(--color-gray-500)">No feeders waiting for approval.</li>';
        return;
    }
    list.innerHTML = data.map(f => `
        <li>
            <div class="mod-user-info">
                <strong>${esc(f.display_name || 'Unnamed feeder')}</strong>
                <span style="font-size:0.75rem;color:var(--color-gray-500);">
                    requested ${esc(fmtDetectedAt(f.requested_at))}${f.app_version ? ' · v' + esc(f.app_version) : ''}
                </span>
            </div>
            <span>
                <button onclick="decideFeeder('${esc(cid)}','${esc(f.feeder_id)}','approved')">Approve</button>
                <button class="mod-remove-btn" onclick="decideFeeder('${esc(cid)}','${esc(f.feeder_id)}','rejected')">Reject</button>
            </span>
        </li>`).join('');
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
    await loadMyCommunities();
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
