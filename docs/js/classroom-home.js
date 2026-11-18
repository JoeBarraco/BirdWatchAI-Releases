// BirdWatchAI Home Classroom — the Classroom for a family
//
// A parent with a BirdWatchAI feeder runs the same lessons a school does,
// for their own children, on a TV or a tablet. Each child is a "class" with
// their own grade band. Server: supabase/setup-home-classroom.sql, whose
// header says why a Home Classroom is a private one-family community rather
// than a classroom with no community (everything else then just works:
// access, terms, privacy, the lessons themselves).
//
// What this file does on top of the school Classroom:
//   * offers "Start a Home Classroom" (7-day trial) to anyone signed in
//     who has no classroom yet;
//   * walks the parent through connecting their feeder, which only the
//     BirdWatchAI app can do (a feeder proves it is theirs with its device
//     key), and approving it here with one press;
//   * shows the trial or term, with a box to enter a code;
//   * says "child" where a school says "class", and leaves out the parts
//     of school that mean nothing at home (the school challenge, staff).

// Price, decided 2026-11-18: $39 a year for up to four children, after a
// 7-day free trial. The Gumroad product is bwa-home-classroom (see the
// webhook's SCHOOL_PRODUCTS). CH_BUY_READY stays false until that product
// exists on Gumroad, so nobody is sent to a page that is not there yet;
// until then the banner states the price and how to get a code.
const CH_PRICE = '$39 a year';
const CH_BUY_URL = 'https://birdbrainllc.gumroad.com/l/bwa-home-classroom';
const CH_BUY_READY = true;
// Decided 2026-11-18: a 7-day trial, with no grace after it. The server's
// home_classroom_trial_days() is the real one; this is only the words.
const CH_TRIAL_DAYS = 7;

function chBuyHtml() {
    return CH_BUY_READY
        ? `<a class="classroom-btn-primary ch-buy" href="${CH_BUY_URL}" target="_blank" rel="noopener">Get a year, ${CH_PRICE.replace(' a year', '')}</a>`
        : `<span class="classroom-muted">${CH_PRICE}. Write to support@birdwatchai.com for a code.</span>`;
}

function chIsHome(communityId) {
    const id = communityId || (typeof classroomCommunityId !== 'undefined' ? classroomCommunityId : '');
    const c = (typeof myCommunities !== 'undefined' && Array.isArray(myCommunities))
        ? myCommunities.find(x => x && x.id === id) : null;
    return !!(c && c.is_home);
}

function chHomeCommunity() {
    return (typeof myCommunities !== 'undefined' && Array.isArray(myCommunities))
        ? myCommunities.find(x => x && x.is_home && x.role === 'owner') : null;
}

// ── For someone with no classroom yet ────────────────────

/** What the panel shows a signed-in person who is nobody's teacher. */
function chPitchHtml() {
    return `
      <div class="ch-pitch">
        <h3>🏡 Home Classroom</h3>
        <p>Turn your bird feeder into lessons for your children. Every question is built from what
           <em>your</em> feeder saw this week: which bird came most, how many on Tuesday, whose song is this.
           Counting, charts and science for ages 5 to 14, with a reading-aloud voice and Spanish for the
           youngest.</p>
        <ul>
            <li>One “class” per child, each at their own level (K–2, 3–5 or 6–8)</li>
            <li>Play on the TV or a laptop; siblings can answer on their own phones or tablets</li>
            <li>A journal of your year, a certificate for the fridge, and a bird count you can send to eBird</li>
            <li>Nothing about your children is stored: no accounts for them, no names unless you type one</li>
        </ul>
        <p><strong>Free for ${CH_TRIAL_DAYS} days, then ${CH_PRICE}</strong> for up to four children. No card needed to start.
           No feeder of your own? Learn from public BirdWatchAI feeders. Have one? Connect it whenever you like.</p>
        <label class="ch-name">What shall we call it?
            <input type="text" id="ch-name" maxlength="80" placeholder="e.g. The Lopez Kitchen Window"></label>
        <button class="classroom-btn-primary big" id="ch-start-btn" onclick="chStart()">Start my free week</button>
        ${CH_BUY_READY ? `<p class="ch-buy-now">Already sure? <a href="${CH_BUY_URL}" target="_blank" rel="noopener">Buy a year for ${CH_PRICE.replace(' a year', '')}</a>,
           then start your Home Classroom here and type the code from the email into the box at the top.</p>` : ''}
        <p class="classroom-muted ch-teacher-note">A teacher? Your school’s Classroom appears here once a moderator
           of your school’s community makes you a teacher.</p>
      </div>`;
}

async function chStart() {
    const btn = document.getElementById('ch-start-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Setting it up…'; }
    const name = (document.getElementById('ch-name') || {}).value || '';
    const { data, error } = await sbRpc('home_classroom_start', { p_name: name }, true);
    if (error || !data) {
        showToast((error && error.message) || 'Could not start a Home Classroom.');
        if (btn) { btn.disabled = false; btn.textContent = 'Start my free week'; }
        return;
    }
    if (typeof loadMyCommunities === 'function') await loadMyCommunities();
    classroomCommunityId = data.community_id;
    if (typeof openClassroomPanel === 'function') openClassroomPanel();
    const sel = document.getElementById('classroom-community-select');
    if (sel) { sel.value = data.community_id; classroomCommunityId = data.community_id; }
    if (typeof refreshClassroomPanel === 'function') await refreshClassroomPanel();
    // The offer may have been open in the right-hand pane (a teacher starting
    // one for their own family); it has done its job.
    if (typeof classroomLeftPick !== 'undefined' && classroomLeftPick.kind === 'home') classroomLeftPick = { kind: 'class' };
    if (typeof hideClassroomHistory === 'function') hideClassroomHistory();
    if (typeof renderClassroomList === 'function') renderClassroomList();
    showToast(data.trial === false
        ? 'Your Home Classroom is ready. Enter a code to start lessons.'
        : 'Your Home Classroom is ready. Next: add a child.');
}

/**
 * A teacher or school owner can have a Home Classroom too, for their own
 * children. They never see the pitch (the panel opens on their school), so
 * the class list carries one row for it until they have one; once they do,
 * the community picker at the top switches between school and home.
 */
function chHomeRowHtml() {
    if (chHomeCommunity()) return '';
    const on = typeof classroomPickIs === 'function' && classroomPickIs('home');
    return `<button type="button" class="classroom-row classroom-row-act ch-home-row${on ? ' on' : ''}"
                onclick="pickClassroomAction('home')">
            <span class="classroom-row-name">🏡 Home Classroom</span>
            <span class="classroom-row-meta">Lessons from your own feeder, for your own children</span>
        </button>`;
}

function chShowPitchInPane() {
    const box = document.getElementById('classroom-history');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = chPitchHtml().replace(/<p class="classroom-muted ch-teacher-note">[\s\S]*?<\/p>/, '');
}

// ── Inside a Home Classroom ──────────────────────────────

/**
 * Runs after every panel refresh. Renders the family's own banner (trial
 * or term, a code box, and the connect-your-feeder steps when no feeder is
 * connected yet) and swaps the school words for family ones.
 */
async function chAfterRefresh() {
    document.body.classList.toggle('ch-home', chIsHome());
    const h = document.getElementById('classroom-panel-h');
    if (h) h.textContent = chIsHome() ? 'Home Classroom' : 'Community Classroom';
    const intro = document.getElementById('classroom-panel-intro');
    if (intro && !intro.dataset.school) intro.dataset.school = intro.textContent.trim();
    if (intro) {
        intro.textContent = chIsHome()
            ? 'Put a question about your feeder on the TV, ask your child, and tap their answer. '
              + 'Each child is a “class” with their own level. Nothing about your children is stored.'
            : intro.dataset.school;
    }
    if (!chIsHome()) return;
    const title = document.getElementById('classroom-pane-title');
    if (title) title.textContent = title.textContent.replace(/^Classes/, 'Children');
    await chRenderBanner();
}

async function chRenderBanner() {
    const box = document.getElementById('classroom-term-banner');
    if (!box) return;
    const s = typeof classroomSchool !== 'undefined' ? classroomSchool : null;
    const c = (myCommunities || []).find(x => x.id === classroomCommunityId) || {};

    // The term: trial days left, the paid year, or stopped.
    let term = '';
    if (s && !s.perpetual) {
        const ends = s.expires_at ? new Date(s.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
        term = s.state === 'active'
            ? `<strong>Your Home Classroom runs until ${esc(ends)}</strong>${s.days_left != null && s.days_left <= 30 ? ` (${s.days_left} day${s.days_left === 1 ? '' : 's'} left)` : ''}.`
            : s.state === 'grace'
            ? `<strong>Your Home Classroom ended on ${esc(ends)}.</strong> Lessons keep working for a little while.`
            : '<strong>Your Home Classroom needs a code to start lessons.</strong> Everything you have done is still here.';
    }

    // Feeders: connected, waiting for approval, or none yet.
    const approved = (typeof classroomFeederOpts !== 'undefined' ? classroomFeederOpts : []);
    const { data: pending } = await sbRpc('community_pending_feeders', { p_community_id: classroomCommunityId }, true);
    const waiting = Array.isArray(pending) ? pending : [];

    // Optional: a family can learn from public feeders alone. Open when a
    // feeder is waiting to be approved, folded away otherwise.
    const connect = approved.length ? '' : `
        <details class="ch-connect"${waiting.length ? ' open' : ''}>
            <summary class="classroom-group-title">${waiting.length ? 'Your feeder is waiting to be approved'
                : 'Have your own BirdWatchAI feeder? Connect it (optional)'}</summary>
            ${waiting.length ? `
                <p>Your feeder has asked to join. Approve it and the lessons can start:</p>
                ${waiting.map(f => `<div class="ch-pending"><strong>${esc(f.display_name || 'A feeder')}</strong>
                    <button class="classroom-btn-primary" onclick="chApprove('${escJs(f.feeder_id)}')">Approve</button></div>`).join('')}`
            : `<ol>
                <li>On the computer your bird camera is connected to, open the <strong>BirdWatchAI</strong> app.</li>
                <li>Go to <strong>Settings → Community → Communities</strong>.</li>
                <li>Under <strong>Join a private community by code</strong>, type
                    <code class="ch-code">${esc(c.slug || '')}</code>
                    <button class="classroom-btn" onclick="chCopy('${escJs(c.slug || '')}')">📋 Copy</button>
                    and click <strong>Request to join</strong>.</li>
                <li>Come back here and press <button class="classroom-btn" onclick="refreshClassroomPanel()">Check again</button>,
                    then <strong>Approve</strong> it.</li>
               </ol>
               <p class="classroom-muted">Joining your Home Classroom does not make your feeder public or private: that is still
                  set in the app. Lessons only ever show your feeder’s data to you.</p>`}
        </details>
        ${waiting.length ? '' : '<p class="classroom-muted ch-nofeeder">No feeder? Add a child and pick public feeders to learn from.</p>'}`;

    const codeBox = s && !s.perpetual ? `
        <div class="ch-codebox">
            ${chBuyHtml()}
            <input type="text" id="ch-code" maxlength="20" placeholder="Have a code? BWH-…" autocomplete="off">
            <button class="classroom-btn" onclick="chApplyCode()">Apply</button>
        </div>` : '';

    box.style.display = '';
    box.className = 'classroom-term ch-banner' + (s && s.state === 'lapsed' ? ' lapsed' : '');
    const logoCtl = typeof chLogoHtml === 'function' ? chLogoHtml() : '';
    box.innerHTML = `${term ? `<div class="ch-term"><span>${term}</span>${codeBox}</div>` : ''}
        ${logoCtl ? `<div class="ch-logo-row">${logoCtl}</div>` : ''}${connect}`;
}

async function chApprove(feederId) {
    const { error } = await sbRpc('community_decide_feeder',
        { p_community_id: classroomCommunityId, p_feeder_id: feederId, p_decision: 'approved' }, true);
    if (error) { showToast(error.message || 'Could not approve it.'); return; }
    showToast('Feeder connected. Now add a child and start a lesson.');
    await refreshClassroomPanel();
}

async function chApplyCode() {
    const code = ((document.getElementById('ch-code') || {}).value || '').trim();
    if (!code) { showToast('Type the code from your purchase email.'); return; }
    const { data, error } = await sbRpc('community_apply_school_code',
        { p_code: code, p_community_id: classroomCommunityId }, true);
    if (error) { showToast(error.message || 'That code did not work.'); return; }
    const until = data && data.expires_at
        ? new Date(data.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    showToast(until ? `Thank you! Your Home Classroom runs until ${until}.` : 'Code applied.');
    await refreshClassroomPanel();
}

async function chCopy(t) {
    try { await navigator.clipboard.writeText(t); showToast('Copied.'); }
    catch { prompt('Copy this:', t); }
}

/** The left-column rows, reworded and pruned for a family. */
function chSchoolRows(rows) {
    if (!chIsHome()) return rows;
    return rows
        .filter(r => r.kind !== 'challenge' && r.kind !== 'feedback')
        .map(r => r.kind === 'new'
            ? { ...r, label: 'Add a child', meta: r.disabled ? r.meta : 'A name or nickname, and their grade' }
            : r);
}

// ── ?home=1 — the homepage's "Start your free week" lands here ──────────
//
// Opens Classroom on the Home Classroom: the offer for someone with no
// classroom, the Home Classroom row's offer for a teacher, or their Home
// Classroom itself if they already have one. Signed out, it asks them to
// sign in first and finishes the job when they have (updateClassroomNavUI
// runs again on every sign-in, and calls this).
let chHomeLinkDone = false;
let chHomeLinkAsked = false;

function chFollowHomeLink() {
    if (chHomeLinkDone) return;
    let wanted = false;
    try { wanted = new URLSearchParams(location.search).get('home') === '1'; } catch { /* no */ }
    if (!wanted) { chHomeLinkDone = true; return; }
    const signedIn = typeof hasAuthSession === 'function' && hasAuthSession();
    if (!signedIn) {
        if (!chHomeLinkAsked && typeof openUserLogin === 'function') {
            chHomeLinkAsked = true;
            openUserLogin();
            showToast('Sign in or create a free account to start your Home Classroom.');
        }
        return;
    }
    chHomeLinkDone = true;
    if (typeof openClassroomPanel !== 'function') return;
    const mine = chHomeCommunity();
    openClassroomPanel();
    if (mine) {
        const sel = document.getElementById('classroom-community-select');
        if (sel) sel.value = mine.id;
        classroomCommunityId = mine.id;
        if (typeof refreshClassroomPanel === 'function') refreshClassroomPanel();
    } else if (typeof classroomCommunities === 'function' && classroomCommunities().length) {
        // A teacher: their school opens first; put the offer beside it.
        setTimeout(() => { if (typeof pickClassroomAction === 'function') pickClassroomAction('home'); }, 600);
    }
}

// Signed out, nothing calls updateClassroomNavUI on load, so check once the
// page has settled. Four seconds, not sooner: a returning visitor's saved
// sign-in is restored asynchronously, and asking someone who IS signed in to
// sign in would be worse than waiting. Signed in, the membership refresh
// gets there first and this does nothing.
window.addEventListener('load', () => {
    setTimeout(() => {
        if (!chHomeLinkDone && !(typeof hasAuthSession === 'function' && hasAuthSession())) chFollowHomeLink();
    }, 4000);
});
