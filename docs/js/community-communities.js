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
    await loadCommunityKinds();
    renderCommunityFilter();
    updateCommunityNavUI();
}

/**
 * Attach each community's `kind` — 'general' or 'school'.
 *
 * Read straight off the table rather than added to community_my_communities,
 * because the communities SELECT policy already lets a member read their own
 * row: one request against a handful of ids, versus redefining a function
 * that lives in another file and would then exist in two versions.
 *
 * Defaults to 'general' when the lookup fails: school-only features stay off
 * unless something positively says otherwise, and a network error is not
 * something saying otherwise.
 *
 * ONE EXCEPTION, and it is a deployment one. If `kind` does not exist yet —
 * this file deployed before setup-community-kinds.sql was run — then every
 * community would read as 'general' and classroom mode would vanish from a
 * school that had been using it. PostgREST names that case exactly (42703,
 * undefined column), so it is detected rather than guessed, and until the
 * migration runs everything behaves as it did before this change. The branch
 * stops applying the moment the column exists.
 */
async function loadCommunityKinds() {
    myCommunities.forEach(c => { c.kind = c.kind || 'general'; });
    if (!myCommunities.length) return;
    try {
        const ids = myCommunities.map(c => c.id).join(',');
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/communities?id=in.(${ids})&select=id,kind`,
            { headers: sbHeaders(true) });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (err && err.code === '42703') {
                // Migration not applied yet — pre-change behaviour.
                myCommunities.forEach(c => { c.kind = 'school'; });
            }
            return;
        }

        const byId = new Map((await res.json()).map(r => [r.id, r.kind]));
        myCommunities.forEach(c => { c.kind = byId.get(c.id) || 'general'; });
    } catch {
        // Leave everything 'general'.
    }
}

function communityKind(communityId) {
    const c = myCommunities.find(x => x.id === communityId);
    return (c && c.kind) || 'general';
}

function communityIsSchool(communityId) {
    return communityKind(communityId) === 'school';
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
    // Any signed-in user, not just owners and moderators. Someone who has just
    // bought a community doesn't own one yet, so gating the button on already
    // having one left them holding a code with nowhere to type it. The panel
    // shows the redeem form when there is nothing to manage.
    btn.style.display = hasAuthSession() ? '' : 'none';

    // Classroom mode rides on the same lifecycle: it needs a real auth session
    // and a community the user teaches in, and both change at exactly the
    // moments this function is already called.
    if (typeof updateClassroomNavUI === 'function') updateClassroomNavUI();
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

    // With nothing to manage, the management controls are noise — show only the
    // redeem form. With something to manage, keep the form collapsed behind a
    // toggle so it doesn't push the roster down the modal.
    const hasAny = manageable.length > 0;
    const manageEls = document.getElementById('community-panel-manage');
    if (manageEls) manageEls.style.display = hasAny ? '' : 'none';
    const redeemBox = document.getElementById('community-redeem-box');
    if (redeemBox) redeemBox.style.display = hasAny ? 'none' : '';
    // The tier picker travels with the redeem form: someone with no community
    // needs both ("buy one" and "I already did"), and an existing owner sees
    // neither until they ask for them via the toggle.
    const buyBox = document.getElementById('community-buy-box');
    if (buyBox) buyBox.style.display = hasAny ? 'none' : '';
    const redeemToggle = document.getElementById('community-redeem-toggle');
    if (redeemToggle) redeemToggle.style.display = hasAny ? '' : 'none';
    const empty = document.getElementById('community-panel-empty');
    if (empty) empty.style.display = hasAny ? 'none' : '';

    // Fills the school half of the buy box, or leaves it empty while there is
    // no product to link to. Cheap, and it has to have run before the toggle
    // can reveal the box.
    renderSchoolBuyOptions();

    modal.classList.add('open');
    if (hasAny) refreshCommunityPanel();
}

/**
 * Reveal the buy + redeem pair for an owner who already has a community and
 * wants another. Both move together — showing the redeem form without the
 * prices would leave an owner hunting the storefront for the tier they need.
 */
function toggleCommunityRedeem() {
    const boxes = ['community-buy-box', 'community-redeem-box']
        .map(id => document.getElementById(id)).filter(Boolean);
    if (!boxes.length) return;
    const show = boxes[0].style.display === 'none';
    boxes.forEach(b => { b.style.display = show ? '' : 'none'; });
}

// ── Redeem an unlock code → create a community ────────────

/**
 * Turn a purchased unlock code into a community, with the buyer as owner.
 *
 * All the validation that matters lives in community_redeem_unlock_code: slug
 * shape, reserved words, collisions, and the single-use claim are all checked
 * server-side inside one transaction. The client checks nothing that the server
 * doesn't re-check — a client-side gate here would only decide which error the
 * user sees first, and a bad slug must never consume the code.
 */
async function redeemCommunityUnlockCode() {
    const code       = document.getElementById('community-redeem-code').value.trim();
    const name       = document.getElementById('community-redeem-name').value.trim();
    const slug       = document.getElementById('community-redeem-slug').value.trim().toLowerCase();
    const visibility = document.getElementById('community-redeem-visibility').value;
    const status     = document.getElementById('community-redeem-status');
    const btn        = document.getElementById('community-redeem-btn');

    const say = (msg, ok) => {
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
        status.textContent = msg;
        status.style.display = 'block';
    };

    if (!code || !name || !slug) {
        say('Unlock code, name and web address are all required.', false);
        return;
    }

    // Guard against a double-click spending the code twice. The server would
    // refuse the second attempt anyway, but the user would see "already used"
    // about their own successful purchase, which reads like a bug.
    btn.disabled = true;
    say('Creating…', true);

    const { data, error } = await sbRpc('community_redeem_unlock_code', {
        p_code:       code,
        p_slug:       slug,
        p_name:       name,
        p_visibility: visibility,
    }, true);

    if (error) {
        btn.disabled = false;
        say(error.message || 'Could not create the community.', false);
        return;
    }

    say(`Created "${name}". Feeder owners join with the code: ${slug}`, true);
    document.getElementById('community-redeem-code').value = '';
    document.getElementById('community-redeem-name').value = '';
    document.getElementById('community-redeem-slug').value = '';

    // Reload memberships so the panel switches from "no communities" to
    // managing the new one, and the nav reflects it.
    await loadMyCommunities();
    updateCommunityNavUI();
    closeCommunityPanel();
    openCommunityPanel();
    btn.disabled = false;
}

function closeCommunityPanel() {
    document.getElementById('community-panel-modal')?.classList.remove('open');
}

async function refreshCommunityPanel() {
    const cid  = document.getElementById('community-panel-select').value;
    const list = document.getElementById('community-pending-list');
    if (!cid || !list) return;

    // Reset belongs to the owner alone — it removes every feeder and every other
    // member, which a delegated moderator shouldn't be able to do to the owner's
    // purchase. Hidden here for clarity; community_owner_reset is what enforces
    // it. Collapsed on every community switch, so the form is never left open
    // with a different community's name prefilled.
    const resetSection = document.getElementById('community-reset-section');
    if (resetSection) {
        resetSection.style.display = communityRoleIn(cid) === 'owner' ? '' : 'none';
        const resetBox = document.getElementById('community-reset-box');
        if (resetBox) resetBox.style.display = 'none';
    }

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
    renderCommunityStats(cid);   // independent; let it load in parallel
    refreshCommunityMembers();   // ditto

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
                // The name goes in a data- attribute, NOT interpolated into the
                // onclick. esc() turns ' into &#39;, the HTML parser decodes it
                // back to ' when it parses the attribute, and the JS the browser
                // then evaluates is  fn('id','id','Joe's Feeder')  — a syntax
                // error, so the button silently did nothing for every feeder
                // with an apostrophe in its name. Attribute values have no such
                // problem, and this matches the data-feeder-name pattern used in
                // community-views.js.
                ? `<button class="mod-remove-btn" data-community-id="${esc(cid)}"
                           data-feeder-id="${esc(f.feeder_id)}"
                           data-feeder-name="${esc(f.display_name || 'this feeder')}"
                           onclick="removeFeederFromCommunity(this)">Remove</button>`
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

/**
 * Show or hide every school-only control for the community in the panel.
 *
 * Called whenever the selected community changes. The teacher options are
 * removed from the DOM rather than disabled: an option that cannot be chosen
 * still invites the question "why not?", and the honest answer is that this
 * community is not a school, which the toggle above now says.
 */
function syncCommunitySchoolUI(cid) {
    const school = communityIsSchool(cid);
    const isOwner = communityRoleIn(cid) === 'owner';

    ['community-invite-role', 'community-bulk-role'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const had = sel.value;
        const opt = [...sel.options].find(o => o.value === 'teacher');
        if (school && !opt) {
            const o = document.createElement('option');
            o.value = 'teacher';
            o.textContent = id === 'community-bulk-role' ? 'Invite all as Teacher' : 'Teacher';
            sel.insertBefore(o, sel.options[1] || null);
        } else if (!school && opt) {
            opt.remove();
        }
        if ([...sel.options].some(o => o.value === had)) sel.value = had;
    });

    const row = document.getElementById('community-school-row');
    if (row) row.style.display = isOwner ? '' : 'none';
    const box = document.getElementById('community-school-check');
    if (box) box.checked = school;
    const note = document.getElementById('community-school-note');
    if (note) {
        note.textContent = school
            ? 'Teachers and classrooms are available in this community.'
            : 'Classrooms and the teacher role, for a school. Needs a '
            + 'subscription code.';
    }

    // The term arrives from the server, so it cannot be part of this
    // synchronous pass. Clear what the last community left on screen first —
    // otherwise one community's expiry date is briefly shown under another
    // community's name.
    communitySchoolTerm = null;
    renderCommunitySchoolTerm();
    if (isOwner) refreshCommunitySchoolTerm(cid);
}

// ── Where a school is bought ─────────────────────────────────────────────
//
// Everything on this site is bought through GUMROAD. Stripe handles the
// desktop software licences and nothing else, so a community — school or
// otherwise — is a Gumroad link, exactly like the three tier links written
// into community.html and like every purchase on the landing page.
//
// The school products are listed HERE rather than in the markup because they
// do not exist yet. An entry with no `url` renders nothing at all, so the
// school options are simply absent from the page until there is something to
// sell, and turning them on later is one line each with no HTML to touch and
// no risk of shipping a dead link.
//
// Two different purchases, and conflating them is the mistake that costs a
// customer a year:
//
//   community — creates a community that is ALREADY a school, with the
//               Classroom term running. For somebody starting from nothing.
//               Mints a BWC- code, redeemed on the create-a-community form.
//
//   renewal   — adds Classroom to a community that already exists, or
//               extends one. Mints a BWS- code, applied in the community's
//               own settings.
//
// The webhook maps its Gumroad permalinks in SCHOOL_PRODUCTS
// (supabase/functions/gumroad-license-webhook/index.ts). When you create the
// products, both ends need the permalink: that file to mint the right code,
// this one to link to the right page.
const SCHOOL_BUY = {
    community: [
        { size: 'Up to 5 feeders',   price: '', url: '' },
        { size: 'Up to 25 feeders',  price: '', url: '' },
        { size: 'Up to 100 feeders', price: '', url: '' },
    ],
    renewal: { price: '', url: '' },
};

/**
 * The school tiers inside the buy box, or nothing.
 *
 * Deliberately a separate block from the plain tiers rather than three more
 * rows in the same list. A school costs more and renews annually, and a
 * price sitting in a list headed "one-time purchase" would be read as
 * one-time whatever the small print said.
 */
function renderSchoolBuyOptions() {
    const box = document.getElementById('community-school-tiers');
    if (!box) return;

    const live = SCHOOL_BUY.community.filter(t => t.url);
    if (!live.length) { box.innerHTML = ''; return; }

    box.innerHTML = `
        <h4 style="font-size:0.9rem;margin:0.9rem 0 0.35rem;color:var(--color-gray-900);">
            🎓 For a school
        </h4>
        <p style="font-size:0.78rem;color:var(--color-gray-500);margin:0 0 0.6rem;line-height:1.45;">
            Everything above, plus Classroom — questions about your own feeders on
            the projector, for a whole class. Renewed yearly; the rest of the
            community is still a one-time purchase.
        </p>
        <div class="community-tier-list">
            ${live.map(t => `
                <a class="community-tier" href="${esc(t.url)}" target="_blank" rel="noopener">
                    <span class="community-tier-size">${esc(t.size)}</span>
                    <span class="community-tier-price">${esc(t.price)}</span>
                </a>`).join('')}
        </div>
        <p style="font-size:0.72rem;color:var(--color-gray-500);margin:0.6rem 0 0;line-height:1.45;">
            Already have a community? Don't buy another — add Classroom to the one
            you have from its own settings instead.
        </p>`;
}

/**
 * The "I don't have a code" half of the renewal box.
 *
 * Without it an owner whose term has run out is asked for a code and given
 * nowhere to get one, which is the single most likely moment for somebody to
 * give up on renewing.
 */
function renderCommunitySchoolBuy() {
    const box = document.getElementById('community-school-buy');
    if (!box) return;

    const r = SCHOOL_BUY.renewal;
    if (!r.url) { box.innerHTML = ''; return; }

    const t = communitySchoolTerm;
    // "Add" before there is a term, "Renew" once there is one. The same link
    // either way — the product is the same — but an owner who has never had
    // Classroom should not be invited to "renew" it.
    const verb = (t && (t.expires_at || t.perpetual)) ? 'Renew' : 'Add';

    box.innerHTML = `No code? <a href="${esc(r.url)}" target="_blank" rel="noopener"
        style="color:var(--color-primary);font-weight:600;">${verb} Classroom${
        r.price ? ` — ${esc(r.price)}` : ''}</a>. The code is emailed to you,
        then paste it above.`;
}

// ── The school subscription, owner side ──────────────────────────────────
//
// School mode is a dated term bought with an unlock code. The checkbox stays
// — an owner may still turn classrooms off and on inside a term they have
// paid for — but it no longer GRANTS anything, and community_set_kind
// refuses it without a live term.
//
// Shape: { state, expires_at, grace_ends_at, days_left, perpetual, can_start }
// state is not_school | perpetual | active | grace | lapsed.

let communitySchoolTerm = null;

/**
 * Fetch the term for one community.
 *
 * A database without setup-school-subscription.sql has no
 * community_school_status, and PostgREST answers PGRST202. That is not an
 * error worth showing anybody: it means this deployment has not been
 * migrated yet, in which case school mode is still the free checkbox it
 * always was and there is no term to render. Leave the UI exactly as it was.
 */
async function refreshCommunitySchoolTerm(cid) {
    const { data, error } = await sbRpc('community_school_status',
        { p_community_id: cid }, true);

    // Another community may have been selected while this was in flight.
    if (document.getElementById('community-panel-select')?.value !== cid) return;

    if (error) {
        communitySchoolTerm = null;
        renderCommunitySchoolTerm();
        return;
    }
    communitySchoolTerm = data && typeof data === 'object' ? data : null;
    renderCommunitySchoolTerm();
}

function communitySchoolTermText(t) {
    const on = iso => new Date(iso).toLocaleDateString(undefined,
        { year: 'numeric', month: 'long', day: 'numeric' });

    if (t.perpetual) {
        return ['ok', 'Classroom mode is included on this community permanently.'];
    }
    if (t.state === 'active') {
        const d = t.days_left;
        // Counted in days near the end and dated otherwise: "renews in 243
        // days" is a number nobody can act on, while "in 12 days" is.
        return ['ok', d !== null && d <= 45
            ? `Classroom subscription ends in ${d} day${d === 1 ? '' : 's'} — ${on(t.expires_at)}.`
            : `Classroom subscription runs until ${on(t.expires_at)}.`];
    }
    if (t.state === 'grace') {
        return ['warn', `Classroom subscription ended on ${on(t.expires_at)}. `
            + `Lessons keep working until ${on(t.grace_ends_at)}.`];
    }
    if (t.state === 'lapsed' && t.expires_at) {
        return ['bad', `Classroom subscription ended on ${on(t.expires_at)}. `
            + 'Lessons and new classes are paused; results are untouched.'];
    }
    return ['', ''];
}

/**
 * Show the term, and the code box when it can do something.
 *
 * The code box is offered to a school whatever its state — renewing early
 * stacks onto the end date rather than throwing the remainder away — and to
 * a community that is not a school yet, because applying a code is now the
 * only way to become one. It is hidden only for a perpetual community, where
 * a code would be spent for nothing; the server refuses that case too.
 */
function renderCommunitySchoolTerm() {
    const box  = document.getElementById('community-school-term');
    const row  = document.getElementById('community-school-code-row');
    const chk  = document.getElementById('community-school-check');
    const t    = communitySchoolTerm;

    if (!box || !row) return;

    // Before the branches: the buy link is wanted in every state, including
    // the one where the term is unknown.
    renderCommunitySchoolBuy();

    if (!t) {
        box.style.display = 'none';
        box.textContent = '';
        row.style.display = 'none';
        if (chk) { chk.disabled = false; chk.title = ''; }
        return;
    }

    const [tone, text] = communitySchoolTermText(t);
    box.textContent = text;
    box.style.cssText = 'font-size:0.78rem;line-height:1.45;margin-top:0.4rem;'
        + (tone === 'bad'  ? 'color:#c0392b;' :
           tone === 'warn' ? 'color:#c97a00;' : 'color:var(--color-gray-500);')
        + (text ? '' : 'display:none;');

    row.style.display = t.perpetual ? 'none' : '';

    // Ticking the box without a term now fails server-side. Saying so before
    // the click is better than a toast afterwards, and it points at the one
    // control that would fix it, which is directly underneath.
    //
    // The test mirrors community_set_kind exactly — perpetual, or inside the
    // grace window — rather than reading `state`, because state says
    // 'not_school' for a paid-up community whose owner has merely switched
    // classrooms off, and that owner must be able to switch them back on.
    // Never disabled while it is checked: turning school mode OFF is free
    // and must stay possible whatever the subscription says.
    if (chk) {
        const entitled = t.perpetual
            || (t.grace_ends_at && Date.now() < new Date(t.grace_ends_at).getTime());
        chk.disabled = !entitled && !chk.checked;
        chk.title = chk.disabled ? 'Apply a subscription code to turn this on' : '';
    }
}

/**
 * Apply an unlock code to the selected community.
 *
 * The server validates everything that matters and only claims the code once
 * it is sure — a code typed into the wrong community comes back as an error
 * with the code still unspent.
 */
async function applySchoolCode() {
    const cid   = document.getElementById('community-panel-select')?.value;
    const input = document.getElementById('community-school-code');
    const out   = document.getElementById('community-school-code-status');
    if (!cid || !input || !out) return;

    const code = input.value.trim().toUpperCase();
    if (!code) {
        out.style.color = '#c0392b';
        out.textContent = 'Enter the code from your subscription email.';
        return;
    }

    out.style.color = 'var(--color-gray-500)';
    out.textContent = 'Checking…';

    const { data, error } = await sbRpc('community_apply_school_code',
        { p_code: code, p_community_id: cid }, true);

    if (error) {
        out.style.color = '#c0392b';
        out.textContent = error.message || 'That code could not be applied.';
        return;
    }

    input.value = '';
    out.style.color = 'var(--color-primary)';
    const until = data && data.expires_at
        ? new Date(data.expires_at).toLocaleDateString(undefined,
            { year: 'numeric', month: 'long', day: 'numeric' })
        : null;
    out.textContent = until
        ? `Applied. Classroom mode runs until ${until}.`
        : 'Applied.';

    // The code may have turned this community INTO a school, so the cached
    // kind is stale and every school-only control on the panel is wrong
    // until it is refreshed.
    const c = myCommunities.find(x => x.id === cid);
    if (c) c.kind = 'school';
    syncCommunitySchoolUI(cid);
}

/**
 * Owner toggles school mode.
 *
 * The server refuses to turn it off while classrooms exist, so the checkbox
 * is put back if it does — a tick that silently did nothing would read as the
 * setting having been saved.
 */
async function toggleCommunitySchool(el) {
    const cid = document.getElementById('community-panel-select').value;
    const want = el.checked ? 'school' : 'general';
    el.disabled = true;

    const { data, error } = await sbRpc('community_set_kind',
        { p_community_id: cid, p_kind: want }, true);
    el.disabled = false;

    if (error) {
        el.checked = !el.checked;
        showToast(error.message || 'Could not change this setting.');
        return;
    }

    const c = myCommunities.find(x => x.id === cid);
    if (c) c.kind = want;

    if (want === 'general' && data && data.teachers_remaining) {
        showToast(`School mode off. ${data.teachers_remaining} person(s) still have `
                + 'the teacher role here and can be changed in the list below.');
    } else {
        showToast(want === 'school' ? 'Classrooms are now available here.' : 'School mode off.');
    }

    syncCommunitySchoolUI(cid);
    if (typeof updateClassroomNavUI === 'function') updateClassroomNavUI();
    await refreshCommunityMembers();
}

async function refreshCommunityMembers() {
    const cid  = document.getElementById('community-panel-select').value;
    syncCommunitySchoolUI(cid);
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
            // Role picker + Remove. Promoting somebody who has already signed in
            // used to be impossible — the only way to set a role was to invite
            // the address with it — which left a school that added its staff
            // first with no way to say which of them teach.
            //
            // 'moderator' is offered to the owner alone, matching the server:
            // community_set_member_role refuses it from a moderator, and an
            // option that always errors is worse than no option.
            const opts = ['viewer']
                .concat(communityIsSchool(cid) ? ['teacher'] : [])
                .concat(isOwner ? ['moderator'] : [])
                .map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r}</option>`)
                .join('');
            action = `<select class="community-role-select" title="Change role"
                              onchange="setCommunityMemberRole('${esc(cid)}','${esc(m.id)}',this)">${opts}</select>`
                   + `<button class="mod-remove-btn" onclick="removeCommunityMember('${esc(cid)}','${esc(m.id)}','${escJs(m.label)}')">Remove</button>`;
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

/**
 * Change an existing member's role.
 *
 * Takes the <select> element so the previous value is to hand: on failure the
 * picker has to be put back, or it sits there claiming a role the server
 * refused to grant.
 */
async function setCommunityMemberRole(communityId, userId, el) {
    const role = el.value;
    const { error } = await sbRpc('community_set_member_role', {
        p_community_id: communityId,
        p_user_id:      userId,
        p_role:         role,
    }, true);
    if (error) {
        showToast('Error: ' + (error.message || 'could not change role'));
        await refreshCommunityMembers();
        return;
    }
    showToast(`Role set to ${role}.`);
    await refreshCommunityMembers();
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

/**
 * Remove an approved feeder from a community.
 *
 * Takes the button element rather than three strings: the name used to be
 * interpolated into the inline onclick, which broke on any apostrophe (see the
 * comment at the call site). Reading it off data- attributes has no escaping
 * hazard at all.
 */
async function removeFeederFromCommunity(el) {
    const communityId = el?.dataset?.communityId;
    const feederId    = el?.dataset?.feederId;
    const displayName = el?.dataset?.feederName || 'this feeder';
    if (!communityId || !feederId) return;

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

/**
 * Invite somebody, and tell them.
 *
 * Invites are keyed by email and redeemed on the invitee's next sign-in, so
 * there has never been a link to send — which quietly meant nobody was ever
 * told they had been invited at all. Four teachers sat as pending invites for
 * three days with no way of knowing, because the only mechanism was somebody
 * mentioning it to them.
 *
 * The community-invite-email edge function now creates the invite AND sends a
 * notification. It still carries no token, no password and no sign-in link:
 * it names the community and the address to sign in with, so forwarding it to
 * the wrong person grants them nothing.
 *
 * Both paths, because an invite must not depend on mail working:
 *   - the function does the invite itself, so its own permission check is the
 *     RPC's, and it cannot be used to mail people you could not invite;
 *   - if the function is unreachable, fall back to the RPC directly. The
 *     invite lands and the panel says plainly that no email went out, which
 *     is the old behaviour and still works.
 */
async function inviteToCommunity() {
    const cid   = document.getElementById('community-panel-select').value;
    const email = document.getElementById('community-invite-email').value.trim();
    const role  = document.getElementById('community-invite-role').value;
    const status = document.getElementById('community-invite-status');
    if (!cid || !email) { showToast('An email address is required'); return; }

    const say = (msg, ok) => {
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
        status.textContent = msg;
        status.style.display = 'block';
    };
    say('Inviting…', true);

    let invited = false, emailed = false, failure = null;

    try {
        const functionsUrl = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
        const res = await fetch(`${functionsUrl}/community-invite-email`, {
            method: 'POST',
            headers: sbHeaders(true),          // the caller's own JWT: the function invites AS them
            body: JSON.stringify({ community_id: cid, email, role }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.success) {
            invited = true;
            emailed = !!body.email_sent;
        } else if (body && body.error) {
            // A refusal from community_invite — wrong role, not a school,
            // not allowed. Real and worth showing; do not retry it.
            say('Error: ' + body.error, false);
            return;
        } else {
            failure = 'function';
        }
    } catch (e) {
        failure = 'unreachable';
    }

    if (!invited) {
        const { error } = await sbRpc('community_invite', {
            p_community_id: cid, p_email: email, p_role: role,
        }, true);
        if (error) { say('Error: ' + (error.message || 'invite failed'), false); return; }
        invited = true;
    }

    document.getElementById('community-invite-email').value = '';
    await refreshCommunityMembers();

    say(emailed
        ? `${email} invited as ${role}, and emailed. They are added the first time they sign in with that address.`
        : `${email} invited as ${role}, but no email went out${failure ? '' : ' (mail failed)'}. `
        + 'Tell them to sign in with that address — that is all it takes.', emailed);
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
    // A classroom session outlives a sign-out otherwise: the stage is a
    // full-screen element, not a modal, so nothing else here would take it
    // down — and it would keep writing answers with a token that has gone.
    if (typeof clearClassroomState === 'function') clearClassroomState();
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
        // A private feeder's logo is a marker like its photos. Many rows share
        // one feeder, so this is a handful of distinct markers however long the
        // feed is, and the Set collapses them to one signing request.
        if (isPrivateMedia(d.feeders?.logo_url)) wanted.add(d.feeders.logo_url);
    }
    if (!wanted.size) return;

    // Signed-out visitors never receive private rows (RLS filters them), so
    // reaching here without a session means something upstream changed. Blank
    // the markers rather than letting a "private://…" land in an <img src>.
    if (!hasAuthSession()) {
        for (const d of detections) {
            if (isPrivateMedia(d.image_url)) d.image_url = null;
            if (isPrivateMedia(d.video_url)) d.video_url = null;
            if (isPrivateMedia(d.feeders?.logo_url)) d.feeders.logo_url = null;
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
        if (isPrivateMedia(d.feeders?.logo_url)) {
            const hit = signedUrlCache.get(d.feeders.logo_url);
            d.feeders.logo_url = hit && hit.expiresAt > now ? hit.url : null;
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

    const token = getModToken();
    const { data, error } = await sbRpc('community_admin_create', {
        p_token:       token,
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

    const token = getModToken();
    if (!token) { list.innerHTML = ''; return; }

    list.innerHTML = '<li style="color:var(--color-gray-500)">Loading…</li>';

    // Everything below is wrapped: an exception here used to leave the section
    // sitting on "Loading…" forever, which is indistinguishable from a hung
    // request and tells the operator nothing.
    let data, error;
    try {
        ({ data, error } = await sbRpc('community_admin_list',
            { p_token: token }, false));
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
        // Approved out of the tier's allowance, not the raw row count — the raw
        // count includes pending and rejected and so disagreed with the cap.
        // Falls back to the old field when the DB predates the extended RPC.
        const used  = c.approved_count ?? c.feeder_count ?? 0;
        const limit = c.feeder_limit;
        const feeders = limit
            ? `${used}/${limit} feeders`
            : `${used} feeder${used === 1 ? '' : 's'}`;
        const pending = c.pending_count ? ` (+${c.pending_count} pending)` : '';

        const bits = [
            c.visibility === 'private' ? '🔒 private' : '🌐 public',
            c.tier ? `${c.tier} plan` : null,
            feeders + pending,
            `${c.member_count} member${c.member_count === 1 ? '' : 's'}`,
            `code ${c.slug}`,
            // The thing support requests actually need: who to reply to.
            c.owner_email ? `owner ${c.owner_email}` : 'no owner',
        ].filter(Boolean);
        const meta = bits.join(' · ');

        // Delete is offered ONLY for an empty community, and never for the
        // built-in public feed. The server enforces both; this keeps a button
        // that is guaranteed to fail off the screen.
        const action = (c.slug !== 'public' && (c.feeder_count ?? 0) === 0)
            ? `<button class="mod-remove-btn" onclick="deleteCommunityAsAdmin('${esc(c.id)}','${escJs(c.name)}')">Delete</button>`
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

    const token = getModToken();
    const { error } = await sbRpc('community_admin_delete', {
        p_token: token, p_community_id: communityId,
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

// ── Bulk invite: paste a roster ───────────────────────────

function toggleCommunityBulk() {
    const box = document.getElementById('community-bulk-box');
    if (!box) return;
    box.style.display = box.style.display === 'none' ? '' : 'none';
    if (box.style.display !== 'none') document.getElementById('community-bulk-emails')?.focus();
}

/**
 * Invite everything in the textarea in one call.
 *
 * Splitting happens here rather than server-side because "one per line, or
 * commas, or semicolons" is a presentation concern — the RPC takes a clean
 * text[]. Everything that decides whether an address is ACCEPTED stays in
 * community_invite_bulk: validity, duplicates, existing members, and the
 * owner-only rule for inviting moderators.
 */
async function bulkInviteToCommunity() {
    const communityId = document.getElementById('community-panel-select')?.value;
    const raw    = document.getElementById('community-bulk-emails').value;
    const role   = document.getElementById('community-bulk-role').value;
    const status = document.getElementById('community-bulk-status');
    const btn    = document.getElementById('community-bulk-btn');

    const say = (html, ok) => {
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
        status.innerHTML = html;
        status.style.display = 'block';
    };

    if (!communityId) { say('Pick a community first.', false); return; }

    const emails = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!emails.length) { say('Paste at least one address.', false); return; }
    if (emails.length > 1000) {
        say(`That's ${emails.length} addresses — paste up to 1000 at a time.`, false);
        return;
    }

    btn.disabled = true;
    say(`Inviting ${emails.length}…`, true);

    const { data, error } = await sbRpc('community_invite_bulk', {
        p_community_id: communityId,
        p_emails:       emails,
        p_role:         role,
    }, true);

    btn.disabled = false;

    if (error) { say(error.message || 'Bulk invite failed.', false); return; }

    // One line per outcome, and the rejected addresses listed — a bare count
    // leaves the owner unable to find the typo in a 400-line paste.
    const rows = Array.isArray(data) ? data : [];
    const by = rows.reduce((a, r) => ((a[r.status] = a[r.status] || []).push(r.email), a), {});
    const n = k => (by[k] || []).length;

    const parts = [];
    if (n('invited'))        parts.push(`<strong>${n('invited')} invited</strong>`);
    if (n('already_member')) parts.push(`${n('already_member')} already a member`);
    if (n('duplicate'))      parts.push(`${n('duplicate')} duplicate`);
    if (n('invalid'))        parts.push(`${n('invalid')} not a valid address`);

    let html = parts.join(' · ');
    for (const bad of ['invalid', 'already_member']) {
        if (n(bad)) {
            const label = bad === 'invalid' ? 'Not sent' : 'Already members';
            html += `<div style="margin-top:0.35rem;font-size:0.75rem;color:var(--color-gray-500);">`
                  + `${label}: ${by[bad].map(esc).join(', ')}</div>`;
        }
    }
    say(html, n('invited') > 0);

    if (n('invited')) {
        document.getElementById('community-bulk-emails').value = '';
        await refreshCommunityMembers();
    }
}

// ── Reset a community ─────────────────────────────────────
//
// Owner only. community_owner_reset refuses a moderator, and the section is
// hidden for one — but the server is the authority, not the hidden div.
//
// There is deliberately no delete. Removing a feeder from its only community
// makes it invisible on the site; after a reset that's recoverable because the
// community still exists and its owner can re-approve, and after a delete it
// isn't. An owner who genuinely wants out asks support.

function toggleCommunityReset() {
    const box = document.getElementById('community-reset-box');
    if (!box) return;
    const show = box.style.display === 'none';
    box.style.display = show ? '' : 'none';
    if (!show) return;

    // Prefill with what it is now, so "just rename it" doesn't mean retyping
    // the address from memory — and getting it wrong changes the join code
    // every feeder owner was given.
    const id = document.getElementById('community-panel-select')?.value;
    const c  = myCommunities.find(x => x.id === id);
    if (c) {
        document.getElementById('community-reset-name').value = c.name || '';
        document.getElementById('community-reset-slug').value = c.slug || '';
        const vis = document.getElementById('community-reset-visibility');
        if (c.visibility) vis.value = c.visibility;
    }
    document.getElementById('community-reset-confirm').checked = false;
    syncCommunityResetBtn();
}

/** The confirm checkbox gates the button — this is destructive to other people's feeders. */
function syncCommunityResetBtn() {
    const ok  = document.getElementById('community-reset-confirm')?.checked;
    const btn = document.getElementById('community-reset-btn');
    if (!btn) return;
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '0.5';
}

async function resetCommunity() {
    const communityId = document.getElementById('community-panel-select')?.value;
    const name   = document.getElementById('community-reset-name').value.trim();
    const slug   = document.getElementById('community-reset-slug').value.trim().toLowerCase();
    const vis    = document.getElementById('community-reset-visibility').value;
    const status = document.getElementById('community-reset-status');
    const btn    = document.getElementById('community-reset-btn');

    const say = (msg, ok) => {
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
        status.textContent = msg;
        status.style.display = 'block';
    };

    if (!communityId) { say('Pick a community first.', false); return; }
    if (!name || !slug) { say('Name and web address are both required.', false); return; }

    btn.disabled = true;
    say('Resetting…', true);

    const { data, error } = await sbRpc('community_owner_reset', {
        p_community_id: communityId,
        p_new_name:     name,
        p_new_slug:     slug,
        p_visibility:   vis,
    }, true);

    if (error) {
        // A rejected address clears nothing server-side, so re-enabling is safe.
        btn.disabled = false;
        syncCommunityResetBtn();
        say(error.message || 'Reset failed.', false);
        return;
    }

    // Report what actually went, rather than a bare "done" — the owner needs to
    // know how many people to tell.
    const d = data || {};
    say(`Reset. Removed ${d.feeders_removed ?? 0} feeder(s), `
      + `${d.members_removed ?? 0} member(s), `
      + `${d.invites_cleared ?? 0} invite(s). New address: ${d.slug ?? slug}`, true);

    document.getElementById('community-reset-confirm').checked = false;
    syncCommunityResetBtn();

    // The name and slug changed, so the picker and the feed's scope filter are
    // both stale.
    await loadMyCommunities();
    await loadCommunityFeederIndex(true);
    await refreshCommunityPanel();
}

// ── Panel stats strip ─────────────────────────────────────

/**
 * Tier, feeder usage and visibility, at the top of the manage panel.
 *
 * Reads community_tier_status rather than counting client-side: the cap that
 * matters is the one Postgres enforces on approval, and a count derived from
 * the rendered list would drift from it the moment a page went stale.
 *
 * Fails quiet. This is a summary of things shown in full below, so a failed
 * request should leave the strip empty rather than replace the panel with an
 * error the owner can't act on.
 */
async function renderCommunityStats(communityId) {
    const bar = document.getElementById('community-stats-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!communityId) return;

    const c = myCommunities.find(x => x.id === communityId);

    const { data, error } = await sbRpc('community_tier_status',
        { p_community_id: communityId }, true);
    if (error) return;

    // The RPC RETURNS TABLE, so PostgREST hands back an array of one row.
    const s = Array.isArray(data) ? data[0] : data;
    if (!s) return;

    const used  = Number(s.approved_count) || 0;
    const limit = Number(s.feeder_limit) || 0;
    const pct   = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

    // Warn before the owner hits a failed approval, not after.
    const state = limit > 0 && used >= limit ? 'is-full'
                : limit > 0 && used >= limit - 1 ? 'is-nearly'
                : '';

    const tierLabel = { small: 'Small', medium: 'Medium', large: 'Large' }[s.tier] || s.tier || '—';

    const cell = (label, value, extra = '', cls = '') => `
        <div class="community-stat ${cls}">
            <span class="community-stat-label">${esc(label)}</span>
            <span class="community-stat-value">${value}</span>
            ${extra}
        </div>`;

    bar.innerHTML = [
        cell('Feeders', `${used} / ${limit}`,
             `<span class="community-stat-bar"><span style="width:${pct}%"></span></span>`, state),
        cell('Pending', String(Number(s.pending_count) || 0)),
        cell('Plan', tierLabel),
        cell('Visibility', c?.visibility === 'private' ? '🔒 Private' : '🌐 Public'),
    ].join('');

    if (state === 'is-full') {
        bar.insertAdjacentHTML('beforeend',
            `<div class="community-stat is-full" style="grid-column:1/-1;">
                <span class="community-stat-label">At capacity</span>
                <span class="community-stat-value" style="white-space:normal;font-size:0.8rem;font-weight:500;">
                    Remove a feeder to approve another, or buy a larger community.
                </span>
             </div>`);
    }
}
