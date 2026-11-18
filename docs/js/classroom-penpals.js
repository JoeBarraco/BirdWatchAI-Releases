// BirdWatchAI Classroom — pen-pal classes at two schools
//
// Two classes, two schools, two feeders, one week to compare. A teacher
// makes an invite code; a teacher at another school types it in. From then
// on both classes' lessons can include questions about the two feeders side
// by side, and the ✉️ Pen-pal pane shows the week's comparison.
//
// Server: supabase/setup-classroom-penpals.sql. What crosses between the
// schools is AGGREGATES ONLY (counts per day and per species, an average
// temperature, latitude to the whole degree, and the other class's name and
// school), never a photo, a feeder, a coordinate or a person, which is why
// a private school feeder can take part.
//
// Loaded after community-classroom.js and BEFORE classroom-alignment.js,
// because the templates below join CLASSROOM_TEMPLATES and the alignment
// self-check reads that list when it loads.

// ── Data ─────────────────────────────────────────────────

/** A feeder to compare: the class's own, or the public ones it learns from. */
function ccPenpalHasFeeder(room) {
    return !!(room && (room.home_feeder_id || (room.partners || []).length));
}

const CC_PENPAL_DAYS = 7;

function ccPenpalTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; }
    catch { return 'America/New_York'; }
}

/**
 * The week, both sides, shaped for the templates; null if the class has no
 * pen-pal or anything goes wrong. Never throws and never blocks a lesson.
 */
async function ccPenpalLoad(room) {
    try {
        // A class with no feeder of its own pairs on the public feeders it
        // learns from (setup-classroom-penpals-public.sql).
        if (!ccPenpalHasFeeder(room)) return null;
        const to = new Date();
        const from = new Date(to.getTime() - CC_PENPAL_DAYS * 864e5);
        const { data, error } = await sbRpc('classroom_penpal_week', {
            p_classroom_id: room.id,
            p_from: from.toISOString(),
            p_to: to.toISOString(),
            p_exclude: [...CM_NOT_BIRDS.keys()],
            p_tz: ccPenpalTz(),
        }, true);
        if (error || !data || !data.ours || !data.theirs) return null;
        return { ours: ccPenpalSide(data.ours, from, to), theirs: ccPenpalSide(data.theirs, from, to) };
    } catch {
        return null;
    }
}

/** One side: species folded onto common names, every day of the window present. */
function ccPenpalSide(x, from, to) {
    const sp = new Map();
    (x.species || []).forEach(r => {
        if (!cmIsBird(r.sp)) return;
        const k = cmSpeciesName(r.sp);
        sp.set(k, (sp.get(k) || 0) + (Number(r.n) || 0));
    });
    const species = [...sp.entries()].map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const byDay = new Map((x.days || []).map(d => [String(d.d).slice(0, 10), Number(d.n) || 0]));
    const days = [];
    for (let t = new Date(from); t < to; t = new Date(t.getTime() + 864e5)) {
        const k = cmDayKey(t);
        days.push({ day: k, n: byDay.get(k) || 0 });
    }
    return {
        name: x.name, school: x.school, band: x.grade_band,
        total: species.reduce((a, b) => a + b.n, 0),
        species, days,
        temp: x.avg_temp == null ? null : Number(x.avg_temp),
        lat: x.lat == null ? null : Number(x.lat),
    };
}

/** "Birch School’s feeder", or the class name if the school has none. */
function ccPenpalTheirs(pp) {
    return `${pp.theirs.school || pp.theirs.name}’s feeder`;
}

// ── Questions ────────────────────────────────────────────
//
// Each sits out unless the class has a pen-pal with a live week, and each
// has its own floor so a comparison is never a coin toss. Same contract as
// every other template: return null to sit the lesson out.

const CC_PENPAL_TEMPLATES = [
{
    // Collect, sort, compare by counting (MA.K.DP.1.1) and compare what two
    // groups saw with the same tools (SC.2.N.1.2 / SC.3.N.1.2).
    id: 'penpal-more-visits',
    category: 'comparison',
    title: 'Our feeder or theirs?',
    bands: ['k-2', '3-5'],
    build({ room, band, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp) return null;
        const a = pp.ours.total, b = pp.theirs.total;
        if (a < 5 || b < 5 || Math.abs(a - b) < Math.max(3, 0.15 * Math.max(a, b))) return null;
        const theirs = ccPenpalTheirs(pp);
        const ours = 'Our feeder';
        const built = cmChoices(a > b ? ours : theirs, [a > b ? theirs : ours, 'About the same'], rng);
        if (!built) return null;
        const k2 = band === 'k-2';
        return {
            prompt: k2 ? 'Which feeder had more bird visits this week?'
                       : `Our pen-pal class watches ${theirs}. Which feeder had more bird visits this week?`,
            ...built,
            chart: cmChart('Bird visits this week', [
                { label: ours, value: a, key: 'ours' },
                { label: theirs, value: b, key: 'theirs' },
            ], { band, kind: 'bars', plain: true, showValues: true }),
            explain: `Our feeder had ${a} visits and ${theirs} had ${b}. `
                   + (k2 ? `That is ${Math.abs(a - b)} more at ${a > b ? 'ours' : 'theirs'}.`
                         : `${a > b ? 'Ours' : 'Theirs'} had ${Math.abs(a - b)} more. Same kind of camera, same week, two different places.`),
        };
    },
},
{
    id: 'penpal-both-saw',
    category: 'comparison',
    title: 'A bird at both feeders',
    bands: ['k-2', '3-5'],
    build({ room, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp) return null;
        const ours = new Map(pp.ours.species.map(s => [s.name, s.n]));
        const theirs = new Map(pp.theirs.species.map(s => [s.name, s.n]));
        const both = pp.ours.species.filter(s => theirs.has(s.name))
            .sort((x, y) => (y.n + theirs.get(y.name)) - (x.n + theirs.get(x.name)));
        if (!both.length) return null;
        const answer = both[0].name;
        // Wrong answers: birds only one feeder saw, then common feeder birds
        // neither did. Never another shared bird, or two answers are right.
        const oneSide = [...pp.ours.species, ...pp.theirs.species]
            .map(s => s.name).filter(n => !(ours.has(n) && theirs.has(n)));
        const neither = COMMON_FEEDER_SPECIES.filter(n => !ours.has(n) && !theirs.has(n));
        const built = cmChoices(answer, [...new Set(oneSide), ...cmShuffle(neither, rng)], rng);
        if (!built || built.choices.length < 3) return null;
        const pen = pp.theirs.school || pp.theirs.name;
        return {
            prompt: `Which bird came to our feeder AND to ${pen}’s feeder this week?`,
            ...built,
            about_bird: answer,
            explain: `The ${answer} visited both: ${ours.get(answer)} time${ours.get(answer) === 1 ? '' : 's'} here `
                   + `and ${theirs.get(answer)} at ${pen}.`
                   + (both.length > 1 ? ` Both feeders also saw ${both.slice(1, 4).map(s => s.name).join(', ')}.` : ''),
        };
    },
},
{
    // The pen-pal question with the most science in it: same tools, two
    // groups, a difference, and now find a reason (SC.3.N.1.2).
    id: 'penpal-only-theirs',
    category: 'comparison',
    title: 'Their bird, not ours',
    bands: ['3-5', '6-8'],
    build({ room, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp) return null;
        const ours = new Set(pp.ours.species.map(s => s.name));
        const only = pp.theirs.species.filter(s => !ours.has(s.name) && s.n >= 2);
        if (!only.length) return null;
        const pick = only[0];
        const built = cmChoices(pick.name, pp.ours.species.map(s => s.name), rng);
        if (!built || built.choices.length < 3) return null;
        const pen = pp.theirs.school || pp.theirs.name;
        const latNote = pp.ours.lat != null && pp.theirs.lat != null && Math.abs(pp.ours.lat - pp.theirs.lat) >= 2
            ? ` Their feeder is about ${Math.abs(pp.ours.lat - pp.theirs.lat)}° of latitude ${pp.theirs.lat > pp.ours.lat ? 'north' : 'south'} of ours, which is one reason worth testing.`
            : '';
        return {
            prompt: `Which bird visited ${pen}’s feeder this week but never came to ours?`,
            ...built,
            about_bird: pick.name,
            explain: `The ${pick.name} came ${pick.n} times at ${pen} and not once here. `
                   + 'Same kind of camera, same week. So why? Different trees and food nearby, '
                   + 'a different climate, or just a bird that has not found us yet.' + latNote
                   + ' Ask your pen-pals what is around their feeder.',
        };
    },
},
{
    // SS.5.G.1.2: use latitude to locate places. Whole degrees only, which
    // is all the server sends and plenty for "which is further north".
    id: 'penpal-north',
    category: 'comparison',
    title: 'Further north',
    bands: ['3-5'],
    build({ room, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp || pp.ours.lat == null || pp.theirs.lat == null) return null;
        const a = pp.ours.lat, b = pp.theirs.lat;
        if (Math.abs(a - b) < 2 || a < 0 || b < 0) return null;
        const pen = `${pp.theirs.school || pp.theirs.name}’s feeder`;
        const built = cmChoices(a > b ? 'Our feeder' : pen, [a > b ? pen : 'Our feeder', 'They are just as far north'], rng);
        if (!built) return null;
        return {
            prompt: `Our feeder is at about ${a}° north. ${pen} is at about ${b}° north. Which feeder is further north?`,
            ...built,
            explain: `Latitude counts degrees north of the equator, so the bigger number is further north: `
                   + `${Math.max(a, b)}° beats ${Math.min(a, b)}°. Each degree is about 69 miles, so the feeders are `
                   + `roughly ${Math.round(Math.abs(a - b) * 69 / 10) * 10} miles apart north to south.`,
        };
    },
},
{
    id: 'penpal-warmer',
    category: 'comparison',
    title: 'Warmer at whose feeder?',
    bands: ['3-5', '6-8'],
    build({ room, band, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp || pp.ours.temp == null || pp.theirs.temp == null) return null;
        const a = pp.ours.temp, b = pp.theirs.temp;
        if (Math.abs(a - b) < 5) return null;
        const pen = `${pp.theirs.school || pp.theirs.name}’s feeder`;
        const built = cmChoices(a > b ? 'Our feeder' : pen, [a > b ? pen : 'Our feeder', 'About the same'], rng);
        if (!built) return null;
        return {
            prompt: 'The feeder cameras record the temperature with every visit. Which feeder was warmer on average this week?',
            ...built,
            chart: cmChart('Average temperature during visits (°F)', [
                { label: 'Our feeder', value: Math.round(a), key: 'ours' },
                { label: pen, value: Math.round(b), key: 'theirs' },
            ], { band, kind: 'hbars', plain: true, showValues: true }),
            explain: `About ${Math.round(a)}°F here and ${Math.round(b)}°F there, ${Math.round(Math.abs(a - b))} degrees apart. `
                   + 'Do the birds care? Compare which birds each feeder saw this week.',
        };
    },
},
{
    // MA.7.DP.1.2: compare two data sets by a measure of variability. The
    // range is the one a seventh-grader can compute off a list in a minute.
    id: 'penpal-steadier',
    category: 'comparison',
    title: 'Steadier week',
    bands: ['6-8'],
    build({ room, rng }) {
        const pp = room && room.cc_penpal;
        if (!pp) return null;
        const full = d => d.days.slice(-CC_PENPAL_DAYS);
        const A = full(pp.ours), B = full(pp.theirs);
        if (A.filter(d => d.n).length < 4 || B.filter(d => d.n).length < 4) return null;
        const range = xs => Math.max(...xs.map(d => d.n)) - Math.min(...xs.map(d => d.n));
        const mean = xs => xs.reduce((s, d) => s + d.n, 0) / xs.length;
        const ra = range(A), rb = range(B);
        // Only when the averages are close. A feeder with ten times the
        // visits has the bigger range for that reason alone, and a question
        // whose answer is just "the busier one" teaches nothing about spread.
        const ma = mean(A), mb = mean(B);
        if (Math.abs(ma - mb) > 0.35 * Math.max(ma, mb)) return null;
        if (Math.abs(ra - rb) < Math.max(3, 0.25 * Math.max(ra, rb))) return null;
        const pen = `${pp.theirs.school || pp.theirs.name}’s feeder`;
        const built = cmChoices(ra > rb ? 'Our feeder' : pen, [ra > rb ? pen : 'Our feeder', 'They varied the same amount'], rng);
        if (!built) return null;
        const list = xs => xs.map(d => d.n).join(', ');
        return {
            prompt: `Daily visits this week. Ours: ${list(A)}. ${pen}: ${list(B)}. Which feeder’s visits varied MORE from day to day?`,
            ...built,
            explain: `Range = highest minus lowest. Ours: ${Math.max(...A.map(d => d.n))} − ${Math.min(...A.map(d => d.n))} = ${ra}. `
                   + `Theirs: ${Math.max(...B.map(d => d.n))} − ${Math.min(...B.map(d => d.n))} = ${rb}. `
                   + `The means were ${mean(A).toFixed(1)} and ${mean(B).toFixed(1)}: a similar average can hide a very different week.`,
        };
    },
},
];

if (typeof CLASSROOM_TEMPLATES !== 'undefined') CLASSROOM_TEMPLATES.push(...CC_PENPAL_TEMPLATES);

// ── The pane ─────────────────────────────────────────────

async function showClassroomPenpal(roomId) {
    const room = (typeof classroomList !== 'undefined' ? classroomList : []).find(r => r.id === roomId);
    const box = typeof ckPane === 'function' ? ckPane() : document.getElementById('classroom-history');
    if (!room || !box) return;
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Checking for a pen-pal class…</div>';

    const { data: st, error } = await sbRpc('classroom_penpal_status', { p_classroom_id: roomId }, true);
    if (error || !st) {
        box.innerHTML = `<div class="classroom-error">${esc((error && error.message) || 'Pen-pal classes are not set up on this site yet.')}</div>
            <button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>`;
        return;
    }

    const home = typeof chIsHome === 'function' && chIsHome();
    const intro = `<p class="classroom-muted">${home
        ? 'Pair up with another family or a class anywhere (grandparents with a feeder are perfect).'
        : 'Pair this class with a class at another school.'} Each lesson can
        then compare the two feeders: whose was busier, which birds came to both, which came to theirs and not
        ours, and why. Only totals cross between the schools: never a photo, a feeder’s location or a child’s name.</p>`;
    const id = escJs(roomId);
    let body = '';

    if (st.state === 'none') {
        body = `${intro}
            <div class="cc-pp-two">
                <div class="classroom-box">
                    <div class="classroom-group-title">Start a pairing</div>
                    <p class="classroom-muted">Make a code and send it to the other teacher.</p>
                    <button class="classroom-btn-primary" onclick="ccPenpalInvite('${id}')"${ccPenpalHasFeeder(room) ? '' : ' disabled title="Pick a feeder for this class first (Edit)"'}>Make an invite code</button>
                </div>
                <div class="classroom-box">
                    <div class="classroom-group-title">Got a code?</div>
                    <p class="classroom-muted">Type the code another teacher sent you.</p>
                    <input type="text" id="cc-pp-code" maxlength="12" placeholder="ABCD EFGH" autocomplete="off"
                           onkeydown="if (event.key === 'Enter') ccPenpalAccept('${id}')">
                    <button class="classroom-btn-primary" onclick="ccPenpalAccept('${id}')"${ccPenpalHasFeeder(room) ? '' : ' disabled title="Pick a feeder for this class first (Edit)"'}>Pair up</button>
                </div>
            </div>`;
    } else if (st.state === 'invited') {
        const code = String(st.code || '');
        body = `${intro}
            <div class="classroom-box">
                <div class="classroom-group-title">Waiting for the other class</div>
                <p>Send this code to the teacher at the other school. They open Classroom, pick their class, press
                   ✉️ Pen-pal class and type it in.</p>
                <div class="cc-pp-code">${esc(code.slice(0, 4))} ${esc(code.slice(4))}</div>
                <p class="classroom-muted">Good until ${esc(new Date(st.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))}. It works once.</p>
                <button class="classroom-btn" onclick="ccPenpalCopy('${escJs(code)}')">📋 Copy code</button>
                <button class="classroom-btn" onclick="ccPenpalEnd('${id}', false)">Cancel invite</button>
            </div>`;
    } else {
        const p = st.partner || {};
        const pp = await ccPenpalLoad(room);
        room.cc_penpal = pp;
        body = `
            <div class="classroom-box">
                <div class="classroom-group-title">Paired with</div>
                <p><strong>${esc(p.name || 'Their class')}</strong> at <strong>${esc(p.school || 'another school')}</strong>
                   <span class="classroom-pill">${esc(GRADE_BAND_LABELS[p.grade_band] || p.grade_band || '')}</span></p>
                <p class="classroom-muted">Paired since ${esc(new Date(st.since).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))}.
                   Lessons now include questions about both feeders when the week gives them something to compare.</p>
            </div>
            ${pp ? ccPenpalWeekHtml(pp) : '<p class="classroom-muted">No week to compare yet.</p>'}
            <button class="classroom-btn" onclick="ccPenpalEnd('${id}', true)">End the pairing</button>`;
    }

    box.innerHTML = `<h4 class="classroom-h">✉️ Pen-pal class</h4>${body}
        <button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>`;
}

function ccPenpalWeekHtml(pp) {
    const o = pp.ours, t = pp.theirs;
    const theirsSet = new Map(t.species.map(s => [s.name, s.n]));
    const oursSet = new Map(o.species.map(s => [s.name, s.n]));
    const both = o.species.filter(s => theirsSet.has(s.name)).map(s => s.name);
    const onlyO = o.species.filter(s => !theirsSet.has(s.name)).map(s => s.name);
    const onlyT = t.species.filter(s => !oursSet.has(s.name)).map(s => s.name);
    const list = xs => xs.length ? esc(xs.join(', ')) : '<span class="classroom-muted">none</span>';
    const row = (label, a, b) => `<tr><th>${label}</th><td>${a}</td><td>${b}</td></tr>`;
    const pen = esc(t.school || t.name);
    return `
        <div class="classroom-box">
            <div class="classroom-group-title">The last ${CC_PENPAL_DAYS} days</div>
            <table class="ck-jtable cc-pp-table">
                <thead><tr><th></th><th>Our feeder</th><th>${pen}</th></tr></thead>
                <tbody>
                    ${row('Bird visits', o.total, t.total)}
                    ${row('Kinds of bird', o.species.length, t.species.length)}
                    ${row('Most common', esc(o.species[0] ? o.species[0].name : '—'), esc(t.species[0] ? t.species[0].name : '—'))}
                    ${row('Average temperature', o.temp == null ? '—' : `${Math.round(o.temp)}°F`, t.temp == null ? '—' : `${Math.round(t.temp)}°F`)}
                    ${row('Latitude', o.lat == null ? '—' : `about ${o.lat}°N`, t.lat == null ? '—' : `about ${t.lat}°N`)}
                </tbody>
            </table>
            <p><strong>Both feeders:</strong> ${list(both)}</p>
            <p><strong>Only ours:</strong> ${list(onlyO)}</p>
            <p><strong>Only ${pen}:</strong> ${list(onlyT)}</p>
        </div>`;
}

async function ccPenpalInvite(roomId) {
    const { error } = await sbRpc('classroom_penpal_invite', { p_classroom_id: roomId }, true);
    if (error) { showToast(error.message || 'Could not make a code.'); return; }
    showClassroomPenpal(roomId);
}

async function ccPenpalAccept(roomId) {
    const code = (document.getElementById('cc-pp-code') || {}).value || '';
    if (!code.trim()) { showToast('Type the code the other teacher sent you.'); return; }
    const { error } = await sbRpc('classroom_penpal_accept', { p_classroom_id: roomId, p_code: code }, true);
    if (error) { showToast(error.message || 'Could not pair.'); return; }
    showToast('Paired. Your lessons can now compare the two feeders.');
    showClassroomPenpal(roomId);
}

async function ccPenpalEnd(roomId, paired) {
    if (paired && !confirm('End the pairing for both classes? Lessons stop comparing the two feeders.')) return;
    const { error } = await sbRpc('classroom_penpal_end', { p_classroom_id: roomId }, true);
    if (error) { showToast(error.message || 'Could not end it.'); return; }
    const room = (classroomList || []).find(r => r.id === roomId);
    if (room) room.cc_penpal = null;
    showClassroomPenpal(roomId);
}

async function ccPenpalCopy(code) {
    try { await navigator.clipboard.writeText(code); showToast('Code copied.'); }
    catch { prompt('Copy this code:', code); }
}
