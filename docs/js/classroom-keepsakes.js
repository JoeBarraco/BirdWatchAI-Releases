// BirdWatchAI Classroom — things a class keeps
//
// Three pages built from lessons the class has already had, each one on
// screen first and then printed (the browser's own print dialog is also its
// PDF writer, the same as Previous lessons):
//
//   🏠 Take-home card  — one lesson, for a child to take home: the bird of
//                        the day, two or three things the class worked out,
//                        a question to talk about at home, and a QR to the
//                        feeder when the feeder is public.
//   📔 Class journal   — the school year: every species in the order it
//                        first turned up, lessons month by month, and every
//                        prediction with what the birds actually did.
//   🏅 Certificate     — the term, on one landscape page, for the wall.
//
// NOTHING ABOUT A CHILD IS ON ANY OF THEM. The class is the unit, as it is
// everywhere else in Classroom mode: join-code nicknames are deleted when a
// lesson ends, and these pages could not name a child if they wanted to.
// The certificate's "awarded to" line is free text the teacher types, used
// for that one printout and kept nowhere.
//
// Loaded after community-classroom.js, whose helpers it uses (esc, sbRpc,
// cmSchoolYear, cmSpeciesName, speciesFact and the rest). Server side:
// supabase/setup-classroom-journal.sql (classroom_journal,
// classroom_year_firsts).

// ── Shared ───────────────────────────────────────────────

/**
 * The lesson that has just ended, kept so its take-home card can be made
 * from the end screen. classroomSession is cleared as the lesson ends, and
 * the card wants exactly what was on the board.
 */
let classroomLastLesson = null;

function ckRoom(id) {
    return (typeof classroomList !== 'undefined' ? classroomList : []).find(r => r.id === id) || null;
}

function ckSchoolLogo() {
    const c = (typeof myCommunities !== 'undefined' && Array.isArray(myCommunities))
        ? myCommunities.find(x => x && x.id === classroomCommunityId) : null;
    return c && typeof c.logo_url === 'string' && /^https:\/\//i.test(c.logo_url) ? c.logo_url : null;
}

function ckDate(d, opts) {
    return new Date(d).toLocaleDateString('en-US', opts || { month: 'long', day: 'numeric', year: 'numeric' });
}

function ckFileName(parts) {
    return parts.map(p => String(p || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean).join(' - ');
}

function ckChoiceLabel(q, i) {
    const c = Array.isArray(q.choices) ? q.choices[i] : null;
    if (i == null || c == null) return '';
    return c.label != null ? String(c.label) : String(c);
}

function ckPhotoOk(u) {
    return typeof u === 'string' && /^https:\/\//i.test(u)
        && !(typeof isPrivateMedia === 'function' && isPrivateMedia(u));
}

/** The pane on the right of the panel, which Previous lessons also uses. */
function ckPane() {
    if (typeof hideClassroomReview === 'function') hideClassroomReview();
    if (typeof closeClassroomForm === 'function') closeClassroomForm();
    const box = document.getElementById('classroom-history');
    if (!box) return null;
    box.style.display = '';
    return box;
}

/**
 * Print one keepsake. Copied to a top-level element first, for the reason
 * printClassroomHistory gives: the panel is position:fixed, and Chrome
 * repeats fixed content on every printed page.
 */
function ckPrint(sourceId, title, landscape) {
    const src = document.getElementById(sourceId);
    if (!src) return;
    document.getElementById('cc-print-root')?.remove();
    const root = document.createElement('div');
    root.id = 'cc-print-root';
    root.innerHTML = src.outerHTML;
    root.querySelectorAll('.ck-noprint, button').forEach(el => el.remove());
    // Inputs print as their value, not as a box with a cursor in it.
    root.querySelectorAll('input').forEach(el => {
        const span = document.createElement('span');
        span.textContent = el.value;
        span.className = el.className;
        el.replaceWith(span);
    });
    document.body.appendChild(root);
    document.body.classList.add('cc-printing');
    if (landscape) document.body.classList.add('cc-print-landscape');

    const oldTitle = document.title;
    document.title = title;
    let done = false;
    const restore = () => {
        if (done) return;
        done = true;
        document.body.classList.remove('cc-printing', 'cc-print-landscape');
        root.remove();
        document.title = oldTitle;
        window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    // Photos are lazy by default and a print snapshot does not wait for
    // them; give them a moment rather than printing empty frames.
    const imgs = [...root.querySelectorAll('img')].filter(i => !i.complete);
    const go = () => { window.print(); setTimeout(restore, 3000); };
    if (!imgs.length) { go(); return; }
    let left = imgs.length;
    const one = () => { if (--left === 0) go(); };
    imgs.forEach(i => { i.addEventListener('load', one); i.addEventListener('error', one); });
    setTimeout(() => { if (left > 0) { left = 0; go(); } }, 2500);
}

/**
 * The feeder's public page, or null when the feeder is not public.
 *
 * Asked anonymously on purpose: the card goes home to families who are not
 * signed in, so the only link worth printing is one that works for them.
 */
async function ckPublicFeederUrl(feederId) {
    if (!feederId) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/feeders?id=eq.${encodeURIComponent(feederId)}`
                              + '&is_public=eq.true&select=display_name', { headers: sbHeaders(false) });
        if (!res.ok) return null;
        const rows = await res.json();
        if (!rows.length || !rows[0].display_name) return null;
        const u = new URL(location.href);
        u.search = '?feeder=' + encodeURIComponent(rows[0].display_name);
        u.hash = '';
        return u.toString();
    } catch { return null; }
}

/**
 * Each species' first sighting in a window, folded onto common names, birds
 * only. One entry per bird: the earliest first sighting of any name it goes
 * by, the visits of all of them, and the clearest photo the server found.
 */
async function ckFirsts(feederIds, from, to) {
    if (!feederIds.length) return [];
    const { data, error } = await sbRpc('classroom_year_firsts', {
        p_feeder_ids: feederIds,
        p_from: from.toISOString(),
        p_to:   to.toISOString(),
        p_exclude: [...CM_NOT_BIRDS.keys()],
    }, true);
    if (error || !Array.isArray(data)) return null;
    const by = new Map();
    for (const r of data) {
        if (!cmIsBird(r.sp)) continue;
        const sp = cmSpeciesName(r.sp);
        const cur = by.get(sp) || { sp, first: null, n: 0, photo: null, best: 0 };
        const t = new Date(r.first_at);
        if (!cur.first || t < cur.first) cur.first = t;
        cur.n += Number(r.n) || 0;
        // The photo of whichever name the bird was seen under most.
        if (ckPhotoOk(r.photo) && (Number(r.n) || 0) > cur.best) { cur.photo = r.photo; cur.best = Number(r.n) || 0; }
        by.set(sp, cur);
    }
    return [...by.values()].sort((a, b) => a.first - b.first);
}

function ckPhotoHtml(url, alt, lazy) {
    return `<div class="ck-photo"><img src="${esc(url)}" alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ''}
                 onerror="this.parentNode.remove()"></div>`;
}

function ckFeederIds(room) {
    if (room.home_feeder_id) return [room.home_feeder_id];
    return (room.partners || []).map(p => p.feeder_id).filter(Boolean);
}

// ── 🏠 Take-home card ────────────────────────────────────

// One of these goes home with each card, picked by the date so every card
// from one lesson says the same thing and the next lesson says another.
const CK_ASK_AT_HOME = {
    'k-2': [
        'Can you find a bird outside today? What color is it?',
        'Which bird would you like to see at our feeder? Draw it for your teacher!',
        'Count the birds you see on the way home. Was it more than five?',
        'Make the sound of a bird you know. Can your family guess which one?',
        'Birds eat seeds. What else do you think birds like to eat?',
    ],
    '3-5': [
        'Ask someone at home which bird they see most. Is it the same as our feeder’s top bird?',
        'Look out of a window for five minutes. Guess first, then count: how many birds did you see?',
        'Why might birds visit our feeder more at some times of day than others?',
        'Find a bird whose name is also a color or a sound. How many can your family think of?',
        'Where do you think our feeder birds sleep at night? Look it up together.',
    ],
    '6-8': [
        'Our feeder is one spot in one place. What might a feeder across town see differently, and why?',
        'Pick a bird from today. Where does it spend the winter? Find out together.',
        'Is a busy day at the feeder good news for the birds? Talk it over at home.',
        'If you set up a feeder at home, what would you measure first, and how?',
        'A camera saw these birds. What might a camera miss that a person would notice?',
    ],
};

function ckAskAtHome(band, when) {
    const list = CK_ASK_AT_HOME[band] || CK_ASK_AT_HOME['3-5'];
    const d = new Date(when || Date.now());
    const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
    return list[day % list.length];
}

/**
 * Up to three things the class worked out, in the order they were asked.
 *
 * Only questions with a right answer that the class answered, and only ones
 * that make sense on paper: a prompt that leans on the photo ("which bird
 * is this?") is useless without it, so prompts that point at a picture or
 * clip are left out.
 */
function ckCardQuestions(questions) {
    const leansOnScreen = /\b(this (bird|photo|picture|clip|chart|graph)|the (photo|picture|clip|video|chart|graph|map|board)|watch|listen|look at|shown|below|above)\b/i;
    const ok = (questions || []).filter(q =>
        q.correct_index != null && q.class_index != null
        && q.prompt && q.prompt.length <= 180
        && !leansOnScreen.test(q.prompt)
        && ckChoiceLabel(q, q.correct_index));
    // Right answers first if there are more than three to choose from — a
    // card that goes home is a thing to be proud of — then back in order.
    const pick = ok.length <= 3 ? ok
        : [...ok].sort((a, b) => (b.is_correct === true) - (a.is_correct === true)).slice(0, 3);
    return pick.sort((a, b) => ok.indexOf(a) - ok.indexOf(b));
}

/**
 * Called from the end-of-lesson screen. Remembers the lesson first, because
 * the end screen clears classroomSession.
 */
function ckRememberLesson(S) {
    if (!S || !S.room) return;
    const top = S.source && Array.isArray(S.source.species) ? S.source.species.find(x => cmIsBird(x.species)) : null;
    classroomLastLesson = {
        roomId: S.room.id,
        when: new Date(),
        questions: (S.questions || []).map(q => ({
            prompt: q.prompt, choices: q.choices,
            correct_index: q.correct_index, class_index: q.class_index,
            is_correct: q.correct_index != null && q.class_index === q.correct_index,
        })),
        bird: top ? { name: top.species, photo: cmSpeciesPhoto(S.source, top.species) } : null,
        feederId: S.source && !S.source.isPool ? S.source.feederId : S.room.home_feeder_id,
    };
}

/** The end screen's button: the card goes up on the stage, ready to print. */
async function showClassroomTakeHomeOnStage() {
    const L = classroomLastLesson;
    const stage = document.getElementById('classroom-stage');
    if (!L || !stage) return;
    const room = ckRoom(L.roomId);
    if (!room) return;
    stage.innerHTML = '<div class="classroom-stage-loading">Making the take-home card…</div>';
    const html = await ckCardHtml(room, L);
    stage.innerHTML = `
        <div class="ck-stage-wrap">
            ${html}
            <div class="ck-actions ck-noprint">
                <button class="classroom-btn-primary" onclick="ckPrint('ck-card', ${esc(JSON.stringify(ckCardTitle(room, L.when)))})">🖨 Print / Save as PDF</button>
                <button class="classroom-btn" onclick="closeClassroomStage()">Done</button>
            </div>
        </div>`;
}

/** The panel's button: the class's most recent lesson. */
async function showClassroomTakeHome(roomId) {
    const room = ckRoom(roomId);
    const box = ckPane();
    if (!room || !box) return;
    box.innerHTML = '<div class="classroom-muted">Making the take-home card…</div>';

    let L = classroomLastLesson && classroomLastLesson.roomId === roomId ? classroomLastLesson : null;
    if (!L) {
        const { data, error } = await sbRpc('classroom_session_history', { p_classroom_id: roomId, p_limit: 1 }, true);
        const lessons = Array.isArray(data) ? data : ((data && data.lessons) || []);
        const last = lessons.find(s => (s.questions || []).length);
        if (error || !last) {
            box.innerHTML = `<div class="classroom-muted">${error ? esc(error.message || 'Could not load the last lesson.')
                : 'No lessons yet. Teach one, and its take-home card appears here.'}</div>
                <button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>`;
            return;
        }
        // The bird of the day, after the fact: the bird seen most at the
        // feeder in the fortnight before the lesson, which is the window the
        // lesson itself was built from.
        const when = new Date(last.started_at);
        const from = new Date(when.getTime() - CLASSROOM_WINDOW_DAYS * 864e5);
        const firsts = await ckFirsts(ckFeederIds(room), from, new Date(when.getTime() + 864e5));
        const top = (firsts || []).slice().sort((a, b) => b.n - a.n)[0];
        L = {
            roomId, when, questions: last.questions,
            bird: top ? { name: top.sp, photo: top.photo } : null,
            feederId: room.home_feeder_id,
        };
    }

    const html = await ckCardHtml(room, L);
    box.innerHTML = `
        <h4 class="classroom-h ck-noprint">Take-home card</h4>
        <p class="classroom-muted ck-noprint">From the lesson on ${esc(ckDate(L.when))}. One per child: print as
           many copies as there are children. Nothing about any child is on it.</p>
        <div class="classroom-hexport ck-noprint">
            <button class="classroom-btn" onclick="ckPrint('ck-card', ${esc(JSON.stringify(ckCardTitle(room, L.when)))})">🖨 Print / Save as PDF</button>
        </div>
        ${html}
        <button class="classroom-btn ck-noprint" onclick="hideClassroomHistory()">Close</button>`;
}

function ckCardTitle(room, when) {
    const d = new Date(when);
    return ckFileName([room.name, `take-home ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`]);
}

async function ckCardHtml(room, L) {
    const band = room.grade_band || '3-5';
    const k2 = band === 'k-2';
    const school = cmHistoryCommunityName();
    const logo = ckSchoolLogo();
    const qs = ckCardQuestions(L.questions);
    const fact = L.bird ? speciesFact(L.bird.name, band) : '';
    const url = await ckPublicFeederUrl(L.feederId);
    const qr = url && typeof bwQr !== 'undefined' && bwQr ? bwQr.svg(url, { label: 'Our bird feeder' }) : '';

    const qHtml = qs.map(q => {
        const right = ckChoiceLabel(q, q.correct_index);
        const ours  = ckChoiceLabel(q, q.class_index);
        return `<li>
            <div class="ck-q">${esc(q.prompt)}</div>
            <div class="ck-a">${q.is_correct
                ? `${k2 ? 'We said' : 'Our answer'}: <strong>${esc(right)}</strong> ✓`
                : `${k2 ? 'We guessed' : 'We said'} ${esc(ours)}. ${k2 ? 'It was' : 'The answer was'} <strong>${esc(right)}</strong>.`}</div>
        </li>`;
    }).join('');

    return `
    <div id="ck-card" class="ck-card">
        <div class="ck-card-head">
            ${logo ? `<img class="ck-logo" src="${esc(logo)}" alt="" onerror="this.remove()">` : ''}
            <div>
                <div class="ck-kicker">Today in ${esc(room.name)}${school ? ` · ${esc(school)}` : ''}</div>
                <div class="ck-date">${esc(ckDate(L.when, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
            </div>
        </div>
        ${L.bird ? `
        <div class="ck-bird">
            ${ckPhotoOk(L.bird.photo) ? ckPhotoHtml(L.bird.photo, L.bird.name) : ''}
            <div>
                <div class="ck-label">${k2 ? 'Our bird of the day' : 'Bird of the day at our feeder'}</div>
                <div class="ck-bird-name">${esc(L.bird.name)}</div>
                ${fact ? `<p class="ck-fact">${esc(fact)}</p>` : ''}
            </div>
        </div>` : ''}
        ${qHtml ? `
        <div class="ck-section">
            <div class="ck-label">${k2 ? 'What we found out' : 'What we worked out'}</div>
            <ol class="ck-qs">${qHtml}</ol>
        </div>` : ''}
        <div class="ck-section ck-home">
            <div class="ck-label">${k2 ? 'Talk about it at home' : 'Ask at home'}</div>
            <p>${esc(ckAskAtHome(band, L.when))}</p>
        </div>
        <div class="ck-card-foot">
            ${qr ? `<div class="ck-qr">${qr}<span>See our feeder live</span></div>` : ''}
            <div class="ck-brand">Our class watches a real bird feeder with BirdWatchAI.
                The camera counts the birds; the class asks the questions.</div>
        </div>
    </div>`;
}

// ── 📔 Class journal ─────────────────────────────────────

async function ckLoadYear(room, from, to) {
    const [j, firsts] = await Promise.all([
        sbRpc('classroom_journal', { p_classroom_id: room.id, p_from: from.toISOString(), p_to: to.toISOString() }, true),
        ckFirsts(ckFeederIds(room), from, to),
    ]);
    if (j.error) return { error: j.error.message || 'Could not load the journal.' };
    if (j.data == null) return { error: 'The journal is not set up on this site yet.' };
    return { j: j.data, firsts: firsts || [] };
}

async function showClassroomJournal(roomId) {
    const room = ckRoom(roomId);
    const box = ckPane();
    if (!room || !box) return;
    box.innerHTML = '<div class="classroom-muted">Reading the year…</div>';

    const yr = cmSchoolYear();
    const to = new Date(Math.min(Date.now() + 864e5, yr.end.getTime()));
    const res = await ckLoadYear(room, yr.start, to);
    if (res.error) {
        box.innerHTML = `<div class="classroom-error">${esc(res.error)}</div>
            <button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>`;
        return;
    }
    const { j, firsts } = res;
    const k2 = room.grade_band === 'k-2';
    const school = cmHistoryCommunityName();
    const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthName = k => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long' }); };
    const thisMonth = monthKey(new Date());

    // Months from the first with anything in it, so a class that started in
    // October does not open on two empty rows.
    const newBy = new Map();
    firsts.forEach(f => { const k = monthKey(f.first); newBy.set(k, (newBy.get(k) || []).concat(f.sp)); });
    const lessonBy = new Map((j.by_month || []).map(m => [m.m, m]));
    const keys = [...new Set([...newBy.keys(), ...lessonBy.keys()])].sort();
    const monthRows = keys.map(k => {
        const m = lessonBy.get(k) || { lessons: 0, asked: 0, correct: 0 };
        const nb = newBy.get(k) || [];
        return `<tr>
            <th>${esc(monthName(k))}</th>
            <td>${m.lessons || '—'}</td>
            <td>${m.asked ? `${m.correct} of ${m.asked}` : '—'}</td>
            <td>${nb.length ? esc(nb.join(', ')) : '<span class="classroom-muted">none new</span>'}</td>
        </tr>`;
    }).join('');

    const birds = firsts.map(f => `
        <div class="ck-jbird">
            ${f.photo ? ckPhotoHtml(f.photo, f.sp, true) : '<div class="ck-jbird-none">🐦</div>'}
            <div class="ck-jbird-name">${esc(f.sp)}${monthKey(f.first) === thisMonth ? ' <span class="ck-new">new</span>' : ''}</div>
            <div class="ck-jbird-meta">First seen ${esc(ckDate(f.first, { month: 'short', day: 'numeric' }))} · ${f.n.toLocaleString('en-US')} visit${f.n === 1 ? '' : 's'}</div>
        </div>`).join('');

    // The same question asked in two lessons is one prediction to a class.
    // Keep the latest of each prompt, which is also the one most likely to
    // have settled.
    const seenP = new Map();
    (j.predictions || []).forEach(p => seenP.set(p.prompt, p));
    const preds = [...seenP.values()].reverse().map(p => {
        const ours = ckChoiceLabel(p, p.class_index);
        const right = ckChoiceLabel(p, p.correct_index);
        const what = p.pending
            ? '<span class="ck-wait">⏳ Still waiting for the birds</span>'
            : p.is_correct
                ? `<span class="ck-yes">✓ Right! It was ${esc(right)}${p.resolved_actual != null ? ` (${esc(String(Math.round(p.resolved_actual)))})` : ''}</span>`
                : `<span class="ck-no">It was ${esc(right || 'something else')}${p.resolved_actual != null ? ` (${esc(String(Math.round(p.resolved_actual)))})` : ''}</span>`;
        return `<li><div class="ck-q">${esc(p.prompt)}</div>
            <div class="ck-a">${esc(ckDate(p.asked_at, { month: 'short', day: 'numeric' }))}: we said <strong>${esc(ours || '—')}</strong>. ${what}</div></li>`;
    }).join('');

    box.innerHTML = `
        <h4 class="classroom-h ck-noprint">Class journal</h4>
        <div class="classroom-hexport ck-noprint">
            <button class="classroom-btn" onclick="ckPrint('ck-journal', ${esc(JSON.stringify(ckFileName([school, room.name, 'journal ' + yr.label])))})">🖨 Print / Save as PDF</button>
        </div>
        <div id="ck-journal" class="ck-journal">
            <div class="ck-jhead">
                <div class="ck-kicker">${esc(school)}</div>
                <h3>📔 ${esc(room.name)}’s bird journal</h3>
                <div class="classroom-muted">School year ${esc(yr.label)} · ${esc(room.home_feeder_name || 'our feeder')} · up to ${esc(ckDate(new Date()))}</div>
            </div>
            <div class="classroom-hsummary">
                <div class="classroom-hstat"><strong>${firsts.length}</strong><span>kinds of bird this year</span></div>
                <div class="classroom-hstat"><strong>${j.lessons}</strong><span>lesson${j.lessons === 1 ? '' : 's'}</span></div>
                <div class="classroom-hstat"><strong>${j.asked ? `${j.correct} of ${j.asked}` : '—'}</strong><span>questions ${k2 ? 'we got right' : 'answered right'}</span></div>
                <div class="classroom-hstat"><strong>${j.best_run || 0}</strong><span>right in a row, our best</span></div>
            </div>

            <h4 class="ck-jh">Our birds, in the order they came</h4>
            ${birds ? `<div class="ck-jbirds">${birds}</div>` : '<p class="classroom-muted">No birds at the feeder yet this school year.</p>'}

            ${monthRows ? `
            <h4 class="ck-jh">Month by month</h4>
            <table class="ck-jtable">
                <thead><tr><th></th><th>Lessons</th><th>Right</th><th>New birds</th></tr></thead>
                <tbody>${monthRows}</tbody>
            </table>` : ''}

            <h4 class="ck-jh">What we predicted</h4>
            ${preds ? `<ol class="ck-qs">${preds}</ol>`
                    : '<p class="classroom-muted">No predictions yet. When a lesson asks the class to predict, it is written down here, and so is what the birds did.</p>'}
        </div>
        <button class="classroom-btn ck-noprint" onclick="hideClassroomHistory()">Close</button>`;
}

// ── 🏅 Certificate ───────────────────────────────────────

/**
 * The terms a certificate can cover. The school year begins in August
 * (cmSchoolYear); the first term runs to the end of December and the
 * second from January, which is how most US calendars split.
 */
function ckTerms() {
    const yr = cmSchoolYear();
    const y = yr.start.getFullYear();
    return {
        year:   { label: `School year ${yr.label}`, from: yr.start, to: yr.end },
        fall:   { label: `Fall ${y}`, from: yr.start, to: new Date(y + 1, 0, 1) },
        spring: { label: `Spring ${y + 1}`, from: new Date(y + 1, 0, 1), to: yr.end },
    };
}

let ckCert = { roomId: null, term: 'year', to: '', data: null };

async function showClassroomCertificate(roomId, term) {
    const room = ckRoom(roomId);
    const box = ckPane();
    if (!room || !box) return;
    const terms = ckTerms();
    if (!term) term = new Date() >= terms.spring.from ? 'year' : 'fall';
    if (ckCert.roomId !== roomId) ckCert = { roomId, term, to: room.name, data: null };
    ckCert.term = term;
    box.innerHTML = '<div class="classroom-muted">Adding up the term…</div>';

    const t = terms[term];
    const res = await ckLoadYear(room, t.from, t.to);
    if (res.error) {
        box.innerHTML = `<div class="classroom-error">${esc(res.error)}</div>
            <button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>`;
        return;
    }
    ckCert.data = res;
    const { j, firsts } = res;
    const top = firsts.slice().sort((a, b) => b.n - a.n)[0];
    const school = cmHistoryCommunityName();
    const teacher = cmHistoryTeacherName(room);
    const logo = ckSchoolLogo();
    const pct = j.asked ? Math.round(100 * j.correct / j.asked) : null;

    const termOpts = Object.entries(terms).map(([k, v]) =>
        `<option value="${k}"${k === term ? ' selected' : ''}>${esc(v.label)}</option>`).join('');

    box.innerHTML = `
        <h4 class="classroom-h ck-noprint">Certificate</h4>
        <div class="ck-certopts ck-noprint">
            <label>Covers <select onchange="showClassroomCertificate('${escJs(roomId)}', this.value)">${termOpts}</select></label>
            <label>Awarded to <input type="text" id="ck-cert-to-input" maxlength="80" value="${esc(ckCert.to)}"
                   oninput="ckCert.to = this.value; document.getElementById('ck-cert-to').textContent = this.value || ' '"></label>
            <button class="classroom-btn" onclick="ckPrint('ck-cert', ${esc(JSON.stringify(ckFileName([school, room.name, 'certificate ' + t.label])))}, true)">🖨 Print / Save as PDF</button>
        </div>
        <p class="classroom-muted ck-noprint">Prints on one landscape page. The name you type is used for this printout only and is not saved.</p>
        <div id="ck-cert" class="ck-cert">
            <div class="ck-cert-inner">
                ${logo ? `<img class="ck-cert-logo" src="${esc(logo)}" alt="" onerror="this.remove()">` : '<div class="ck-cert-logo ck-cert-emoji">🐦</div>'}
                <div class="ck-cert-kicker">Certificate of Bird Watching</div>
                <div class="ck-cert-sub">is proudly awarded to</div>
                <div class="ck-cert-to" id="ck-cert-to">${esc(ckCert.to || ' ')}</div>
                <div class="ck-cert-sub">${school ? `${esc(school)} · ` : ''}${esc(t.label)}</div>
                <p class="ck-cert-for">for watching the birds at ${esc(room.home_feeder_name || 'our feeder')} and asking good questions about them.</p>
                <div class="ck-cert-stats">
                    <div><strong>${firsts.length}</strong><span>kinds of bird spotted</span></div>
                    <div><strong>${j.lessons}</strong><span>lesson${j.lessons === 1 ? '' : 's'}</span></div>
                    <div><strong>${j.correct}</strong><span>question${j.correct === 1 ? '' : 's'} answered right${pct != null ? ` (${pct}%)` : ''}</span></div>
                    <div><strong>${j.best_run || 0}</strong><span>right in a row</span></div>
                </div>
                ${top ? `<p class="ck-cert-top">Most frequent visitor: <strong>${esc(top.sp)}</strong>, ${top.n.toLocaleString('en-US')} visit${top.n === 1 ? '' : 's'}</p>` : ''}
                <div class="ck-cert-sign">
                    <div><span class="ck-line"></span>${esc(teacher || 'Teacher')}</div>
                    <div><span class="ck-line"></span>${esc(ckDate(new Date()))}</div>
                </div>
            </div>
        </div>
        <button class="classroom-btn ck-noprint" onclick="hideClassroomHistory()">Close</button>`;
}
