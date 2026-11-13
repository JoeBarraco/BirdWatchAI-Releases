// BirdWatchAI Community Feed — Classroom Mode (phase 1)
//
// A classroom is a community-level entity: a home feeder, optional partner
// feeders, a grade band and a teacher. The teacher puts a question on the
// projector, polls the room by hand, and taps the class's answer. There are no
// student accounts and no student devices in phase 1 — that is phase 2.
//
// Design notes: "BirdWatch AI – Classroom Mode (design notes)", §7 (classroom
// at the community level), §8 (roles and permissions), §9A (teacher-led
// voting), §14 step 1.
// Schema + RLS: supabase/setup-classrooms.sql
//
// Three pieces live here:
//
//   1. Classroom data — detections for the home feeder (and partners), rolled
//      up into the shape the question templates want.
//   2. The template engine — ~15 starter templates across the design notes'
//      six categories, each with grade-band variants, with every slot and
//      every answer filled from live detection data.
//   3. The teacher panel and the projector stage.
//
// WHY THE QUESTIONS ARE BUILT IN THE BROWSER
// The answers are derived client-side, which means they are visible to anyone
// who opens devtools on the machine running the session. In teacher-led mode
// that is the teacher's own projector laptop and nobody else's, so there is
// nothing to leak to. It also keeps the template set editable without a
// migration, which matters while the starter set is still being tuned against
// what the feeders actually see. Phase 2 puts student devices in the room and
// the answer check has to move server-side with it — classroom_session_record
// already stores the correct index, so that is a change to where build()
// runs, not to what it produces.

// ── State ────────────────────────────────────────────────

let classroomCommunityId = '';     // community currently selected in the panel
let classroomList        = [];     // classrooms in that community
let classroomFeederOpts  = [];     // [{id, display_name}] approved feeders there
let classroomEditingId   = null;   // classroom being edited, or null for "new"
// Staff who may be given a classroom: owner, moderator, teacher. Only loaded
// when the signed-in user is an owner or moderator, because only they can
// reassign one — and community_members_list refuses anybody else anyway.
let classroomStaff       = [];

// The running session. Null when the stage is closed.
let classroomSession = null;       // {id, room, questions, index, revealed, asked, correct}

// Window the question engine looks back over. 14 days so a week-over-week
// template has something to compare against; individual templates narrow it.
const CLASSROOM_WINDOW_DAYS = 14;

// Below this many detections in the window, the home feeder cannot carry a
// lesson and the engine falls back to a partner feeder (design notes §5).
// Picked from what a working feeder produces: the Roland Park courtyard logged
// nothing at all for weeks, while an established feeder logs this before lunch.
const CLASSROOM_MIN_ROWS = 12;

const CLASSROOM_QUESTIONS_PER_SESSION = 8;

const GRADE_BAND_LABELS = {
    'k-2': 'K–2',
    '3-5': 'Grades 3–5',
    '6-8': 'Grades 6–8',
};

// ── Access ───────────────────────────────────────────────

// Communities where the signed-in user may run a classroom. Teachers included
// — that is the whole point of the role (design notes §8).
function classroomCommunities() {
    if (typeof myCommunities === 'undefined') return [];
    return myCommunities.filter(c =>
        c.role === 'owner' || c.role === 'moderator' || c.role === 'teacher');
}

// My role in the community the panel is currently showing.
function classroomMyRole() {
    if (typeof myCommunities === 'undefined') return null;
    const c = myCommunities.find(x => x.id === classroomCommunityId);
    return c ? c.role : null;
}

function classroomCanAssign() {
    const r = classroomMyRole();
    return r === 'owner' || r === 'moderator';
}

function classroomMyUserId() {
    return (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
}

function updateClassroomNavUI() {
    const btn = document.getElementById('navbar-classroom-btn');
    if (!btn) return;
    const show = typeof hasAuthSession === 'function' && hasAuthSession()
              && classroomCommunities().length > 0;
    btn.style.display = show ? '' : 'none';

    // This runs whenever memberships change, which is the first moment a
    // ?classroom= link can actually be resolved — before it, there is nothing
    // to look the id up in.
    if (show) followClassroomDeepLink();
}

// One shot per page load: a teacher who closes the panel should not have it
// reopen under them on the next membership refresh.
let classroomDeepLinkDone = false;

/**
 * Open the panel on the classroom named in ?classroom=…
 *
 * The id does not say which community it belongs to, so this asks each
 * community the user can teach in. That is one request per community, and a
 * teacher has one.
 */
async function followClassroomDeepLink() {
    if (classroomDeepLinkDone) return;
    const wanted = new URLSearchParams(location.search).get('classroom');
    if (!wanted) { classroomDeepLinkDone = true; return; }
    classroomDeepLinkDone = true;

    for (const c of classroomCommunities()) {
        const { data, error } = await sbRpc('classroom_list', { p_community_id: c.id }, true);
        if (error || !Array.isArray(data)) continue;
        if (!data.some(r => r.id === wanted)) continue;

        classroomCommunityId = c.id;
        openClassroomPanel();
        const sel = document.getElementById('classroom-community-select');
        if (sel) sel.value = c.id;
        await refreshClassroomPanel();
        highlightClassroom(wanted);
        return;
    }

    // Reached only when the link points at a classroom this account cannot
    // see — deleted, or belonging to somebody else. Say so plainly rather
    // than opening an empty panel and letting them wonder.
    showToast('That classroom link is not one this account can open.');
}

function highlightClassroom(id) {
    const card = document.querySelector(`.classroom-card[data-room="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('linked');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Dates and small helpers ──────────────────────────────
//
// Everything is in the browser's local time on purpose: the class is in the
// room, and "which day was busiest" has to mean the day the children were
// there, not a UTC day that starts mid-afternoon.

function cmDayKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const p = n => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function cmDayStart(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function cmDayLabel(dayKey, withDate) {
    const dt = cmDayStart(dayKey);
    const today = cmDayKey(new Date());
    const yest  = cmDayKey(new Date(Date.now() - 86400000));
    if (dayKey === today) return 'today';
    if (dayKey === yest)  return 'yesterday';
    const name = dt.toLocaleDateString(undefined, { weekday: 'long' });
    return withDate
        ? `${name}, ${dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : name;
}

// "on Sunday", but "today" and "yesterday" — those already read as adverbs and
// "came on yesterday" is the kind of thing a class reads aloud and laughs at.
function cmWhenPhrase(dayKey) {
    const label = cmDayLabel(dayKey);
    return (label === 'today' || label === 'yesterday') ? label : `on ${label}`;
}

function cmHourLabel(h) {
    const ampm = h < 12 ? 'am' : 'pm';
    const h12  = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ampm}`;
}

// Deterministic RNG. A question's choices must not reshuffle when the teacher
// clicks back, and two classes watching the same feeder on the same day should
// not see the options in a different order while comparing notes.
function cmRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
        h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function cmShuffle(arr, rng) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Build a multiple-choice question from the right answer plus distractors,
// shuffling once so correct_index tracks the move.
function cmChoices(correctLabel, distractors, rng) {
    const seen = new Set([correctLabel]);
    const opts = [correctLabel];
    for (const d of distractors) {
        if (opts.length >= 4) break;
        if (d == null || seen.has(d)) continue;
        seen.add(d);
        opts.push(d);
    }
    if (opts.length < 2) return null;
    const shuffled = cmShuffle(opts, rng);
    return { choices: shuffled.map(l => ({ label: l })),
             correct_index: shuffled.indexOf(correctLabel) };
}

// Plausible wrong numbers near a right one. Spread scales with the answer so
// "14" doesn't get offered against "97", which gives the number away without
// anyone counting anything.
function cmNumberDistractors(n, rng, count) {
    const want   = count || 3;
    const spread = Math.max(2, Math.round(n * 0.35));
    const out    = new Set();
    let guard = 0;
    while (out.size < want && guard++ < 60) {
        let delta = Math.round((rng() * 2 - 1) * spread);
        if (delta === 0) delta = rng() < 0.5 ? -1 : 1;
        const v = n + delta;
        if (v < 0 || v === n) continue;
        out.add(v);
    }
    return [...out];
}

// ── Species facts (design notes §5) ──────────────────────
//
// Only species the feeders actually see, at two reading levels. Shown on the
// reveal so an identification question ends in something learned rather than
// just a tick. Unknown species simply get no fact — a wrong or generic one is
// worse than silence in front of a class.
const SPECIES_FACTS = {
    'Northern Cardinal': {
        'k-2':  'Boy cardinals are bright red. Girl cardinals are soft brown with a little red.',
        'up':   'Cardinals do not migrate, so the same pair may defend your feeder all year. Males are red; females are warm brown with red highlights.',
    },
    'Carolina Chickadee': {
        'k-2':  'Chickadees say their own name: "chick-a-dee-dee-dee!"',
        'up':   'Chickadees add more "dee" notes to their call when a predator is more dangerous — the call carries real information.',
    },
    'Black-capped Chickadee': {
        'k-2':  'Chickadees say their own name: "chick-a-dee-dee-dee!"',
        'up':   'Chickadees hide thousands of seeds each autumn and remember where they put them.',
    },
    'Tufted Titmouse': {
        'k-2':  'The titmouse has a little grey hat called a crest that it can raise up.',
        'up':   'Titmice often grab one seed, carry it to a branch, and hammer it open while holding it with their feet.',
    },
    'Carolina Wren': {
        'k-2':  'Wrens are small and brown, and they sing very loudly for their size.',
        'up':   'A Carolina Wren pair stays together year-round, and the male sings a "teakettle-teakettle" song all seasons.',
    },
    'House Finch': {
        'k-2':  'Boy house finches have red on their heads and chests.',
        'up':   'The red on a male House Finch comes from pigments in the food he eats, so his colour reports how well he has fed.',
    },
    'American Goldfinch': {
        'k-2':  'Goldfinches turn bright yellow in summer and dull brown in winter.',
        'up':   'Goldfinches moult into drab plumage for winter and nest later than almost any other songbird, timed to thistle seed.',
    },
    'Blue Jay': {
        'k-2':  'Blue jays are loud and bossy, and they love peanuts.',
        'up':   'Blue Jays imitate hawk calls, which can clear a feeder of other birds just before the jay lands on it.',
    },
    'Mourning Dove': {
        'k-2':  'Mourning doves make a soft "coo" sound and walk on the ground.',
        'up':   'Mourning Doves feed mostly on the ground and can drink without lifting their heads, unlike most birds.',
    },
    'Downy Woodpecker': {
        'k-2':  'Woodpeckers climb up tree trunks and tap on wood with their beaks.',
        'up':   'The Downy is the smallest North American woodpecker; males have a red patch on the back of the head, females do not.',
    },
    'Red-bellied Woodpecker': {
        'k-2':  'This woodpecker has a red cap and stripes like a zebra on its back.',
        'up':   'Despite the name, the red belly is faint — the obvious red is on the head, which is why the name confuses everybody.',
    },
    'White-breasted Nuthatch': {
        'k-2':  'Nuthatches walk DOWN tree trunks head first.',
        'up':   'Nuthatches forage head-downward, which lets them spot insects in bark that birds climbing upward miss.',
    },
    'House Sparrow': {
        'k-2':  'House sparrows live close to people and like to eat in groups.',
        'up':   'House Sparrows were introduced to North America in the 1850s and now live almost everywhere people do.',
    },
    'European Starling': {
        'k-2':  'Starlings have shiny feathers with little white spots in winter.',
        'up':   'Starlings are excellent mimics and will copy other birds, car alarms, and machinery.',
    },
    'American Robin': {
        'k-2':  'Robins have orange tummies and pull worms out of the grass.',
        'up':   'Robins find worms largely by sight and sound, not smell — the head tilt is listening and looking, not sniffing.',
    },
    'Dark-eyed Junco': {
        'k-2':  'Juncos are grey on top and white underneath, like a little snowball.',
        'up':   'Juncos are often called "snowbirds" because in much of the country they only show up for the winter.',
    },
    'Northern Mockingbird': {
        'k-2':  'Mockingbirds copy the songs of other birds.',
        'up':   'A male Northern Mockingbird can learn 200 songs in a lifetime and sings them in bursts of three or more repeats.',
    },
};

// Distractor pool for identification when the feeder has only seen one or two
// species — a 3-choice question needs three plausible birds whether or not
// they have all visited.
const COMMON_FEEDER_SPECIES = Object.keys(SPECIES_FACTS);

function speciesFact(species, band) {
    const f = SPECIES_FACTS[species];
    if (!f) return '';
    return band === 'k-2' ? f['k-2'] : f['up'];
}

// ── Classroom data ───────────────────────────────────────

/**
 * Roll a feeder's detections up into everything the templates ask for.
 *
 * Computed once per feeder per session rather than per template: fifteen
 * templates each re-reducing the same few thousand rows is the kind of thing
 * that makes a projector laptop stutter between questions.
 */
function cmSummarize(feederId, name, rows, isHome) {
    const bySpecies = new Map();
    const byDay     = new Map();
    const byHour    = new Array(24).fill(0);
    const daySpec   = new Map();
    const snapshots = [];
    let tempSum = 0, tempRows = 0;
    const dayTemp = new Map();   // day -> {sum, n}

    for (const r of rows) {
        const sp = r.species || 'Unknown';
        bySpecies.set(sp, (bySpecies.get(sp) || 0) + 1);

        const dt  = new Date(r.detected_at);
        const day = cmDayKey(dt);
        byDay.set(day, (byDay.get(day) || 0) + 1);
        byHour[dt.getHours()]++;

        if (!daySpec.has(day)) daySpec.set(day, new Map());
        const dm = daySpec.get(day);
        dm.set(sp, (dm.get(sp) || 0) + 1);

        if (typeof r.temperature === 'number') {
            tempSum += r.temperature; tempRows++;
            if (!dayTemp.has(day)) dayTemp.set(day, { sum: 0, n: 0 });
            const t = dayTemp.get(day);
            t.sum += r.temperature; t.n++;
        }

        if (r.image_url && !isPrivateMedia(r.image_url)) snapshots.push(r);
    }

    // Highest confidence first: the identification question wants the clearest
    // photo of the bird, not the most recent blur.
    snapshots.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    const species = [...bySpecies.entries()]
        .map(([species, n]) => ({ species, n }))
        .sort((a, b) => b.n - a.n || a.species.localeCompare(b.species));

    const days = [...byDay.entries()]
        .map(([day, n]) => ({ day, n }))
        .sort((a, b) => a.day.localeCompare(b.day));

    return {
        feederId, name, isHome,
        rows, total: rows.length,
        species, bySpecies, days, byDay, byHour, daySpec, snapshots,
        distinct: species.length,
        avgTemp: tempRows ? tempSum / tempRows : null,
        tempCoverage: rows.length ? tempRows / rows.length : 0,
        dayTemp,
    };
}

// ── The burned-in caption (design notes §3, "guess the species") ────
//
// THE CAMERA WRITES THE ANSWER ON THE PHOTO. Every snapshot has a caption
// strip burned into the bottom of the JPEG at detection time — species in
// bold, then rarity, time and temperature. For every other question that is
// just provenance. For "which bird is this?" it is the answer key, printed
// across the bottom of the projector in 42px type.
//
// So the strip is cropped off while the class is voting, and the whole photo
// is shown again on the reveal, where the caption stops being a giveaway and
// becomes the confirmation.
//
// The geometry is a port of eraseStripArea in community-overlay.js, which is
// itself a line-for-line port of SkiaSnapshotOverlayService in the server
// repo. THREE COPIES OF THESE NUMBERS NOW EXIST; if the server's strip
// changes, this crop has to follow or the species name creeps back into view.
// Erring large is the safe direction — a little too much sky cropped costs
// nothing, a visible descender costs the question.

const CAPTION_SAFETY = 0.02;   // 2% of height on top of the computed strip

function cmCaptionCropFraction(naturalHeight) {
    const h = Number(naturalHeight) || 0;
    // Before the image reports its size, assume a generous strip rather than
    // none: showing too much is the failure that matters.
    if (!h) return 0.18;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const titleSize = clamp(h * 0.045, 16, 42);
    const metaSize  = clamp(h * 0.030, 12, 28);
    const padding   = clamp(h * 0.020, 8, 24);
    const lineGap   = padding * 0.4;
    const ERASE_FRINGE = 6;                       // matches the Skia constant

    const strip = titleSize + lineGap + metaSize + padding * 2 + ERASE_FRINGE;
    return Math.min(0.4, (strip / h) + CAPTION_SAFETY);
}

/**
 * Crop the caption off a projector snapshot once it knows its own size.
 *
 * Called from the image's onload. Sets the wrapper's aspect ratio to the
 * cropped shape and lets object-fit do the clipping, so the photo keeps its
 * proportions and simply ends above the strip — no black bar, nothing that
 * reads as a rendering fault to a room of children.
 */
function classroomFitShot(img) {
    const wrap = img.closest('.classroom-shot');
    if (!wrap || wrap.dataset.crop !== 'caption') return;

    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return;

    const frac = cmCaptionCropFraction(h);
    const keptH = Math.round(h * (1 - frac));
    wrap.style.aspectRatio = `${w} / ${keptH}`;
    // Also as a bare number: aspect-ratio alone gives the box a SHAPE but no
    // size, and a flex item with only max-* constraints and no basis collapses
    // to nothing. The width calc below needs the ratio as a multiplier.
    wrap.style.setProperty('--shot-ar', String(w / keptH));
    wrap.classList.add('cropped');
}

/**
 * Load the classroom's detections and summarize them.
 *
 * One request covering the home feeder and every partner, then split: the
 * fallback in §5 needs the partners' totals to decide whether the home feeder
 * can carry the lesson, so fetching them lazily would just mean fetching them
 * a moment later anyway.
 */
async function loadClassroomData(room) {
    const ids = [];
    if (room.home_feeder_id) ids.push(room.home_feeder_id);
    (room.partners || []).forEach(p => { if (p.feeder_id) ids.push(p.feeder_id); });
    if (!ids.length) return { home: null, partners: [], all: [] };

    const since = new Date(Date.now() - CLASSROOM_WINDOW_DAYS * 86400000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/community_detections`
              + `?select=id,feeder_id,species,confidence,detected_at,image_url,temperature,rarity`
              + `&feeder_id=in.(${ids.join(',')})`
              + `&detected_at=gte.${encodeURIComponent(since)}`
              + `&order=detected_at.desc`;

    let rows = [];
    try {
        rows = await fetchAllRows(url, hasAuthSession()) || [];
    } catch {
        rows = [];
    }

    // Snapshots on a private school feeder arrive as private:// markers and
    // need signing before they can go in an <img src>. Sign the whole set in
    // one pass, exactly as the feed does.
    if (typeof signPrivateMedia === 'function') {
        try { await signPrivateMedia(rows); } catch { /* fall through unsigned */ }
    }

    const byFeeder = new Map(ids.map(id => [id, []]));
    rows.forEach(r => { if (byFeeder.has(r.feeder_id)) byFeeder.get(r.feeder_id).push(r); });

    const nameOf = id => {
        if (id === room.home_feeder_id) return room.home_feeder_name || 'our feeder';
        const p = (room.partners || []).find(x => x.feeder_id === id);
        return (p && p.display_name) || 'a partner feeder';
    };

    const home = room.home_feeder_id
        ? cmSummarize(room.home_feeder_id, nameOf(room.home_feeder_id),
                      byFeeder.get(room.home_feeder_id) || [], true)
        : null;

    const partners = (room.partners || [])
        .filter(p => p.feeder_id)
        .map(p => cmSummarize(p.feeder_id, nameOf(p.feeder_id),
                              byFeeder.get(p.feeder_id) || [], false));

    return { home, partners, all: [home, ...partners].filter(Boolean) };
}

/**
 * Which feeder's data this session's questions come from.
 *
 * The home feeder wins whenever it can carry a lesson, because it is the one
 * the children can see out of the window — that is the entire reason the
 * school has it. A quiet home feeder falls back to the busiest partner, and
 * the caller marks every question drawn that way so the class is told where
 * the data came from (design notes §5: "label them clearly").
 */
function cmPickSource(data) {
    const { home, partners } = data;
    if (home && home.total >= CLASSROOM_MIN_ROWS) return home;

    const best = partners.slice().sort((a, b) => b.total - a.total)[0];
    if (best && best.total > (home ? home.total : 0) && best.total >= CLASSROOM_MIN_ROWS) {
        return best;
    }
    return home || best || null;
}

// Narrow a summary to the last `days` days. Templates that talk about "this
// week" must not quietly answer with a fortnight.
function cmWindow(src, days) {
    const cutoff = Date.now() - days * 86400000;
    const rows = src.rows.filter(r => new Date(r.detected_at).getTime() >= cutoff);
    return cmSummarize(src.feederId, src.name, rows, src.isHome);
}

// ── The evidence on the board (design notes §2, §3, §11) ───────────
//
// A question like "how many birds came yesterday?" with nothing but four
// numbers to choose from is a guess. With the week's data up beside it, it is
// a reading exercise — which is the thing the notes actually ask for: tally
// marks for K–2, bar charts for 3–5, trends for 6–8.
//
// So every data question carries a chart of the window it is asking about,
// and the chart DOES NOT print its values until the reveal. A bar with "12"
// written above it answers the question for the class; a bar measured against
// a labelled axis makes them read it. The numbers appear with the answer,
// where they confirm rather than give away.
//
// Two shapes, by grade band rather than by template:
//
//   dots  — one dot per visit, in rows, grouped in fives. The kindergarten
//           pictograph, and countable without any notion of an axis. Used for
//           K–2 whenever the counts are small enough to stay countable.
//   bars  — vertical bars against a gridded axis, for everyone else and for
//           K–2 when the numbers outgrow dots.

const CHART_MAX_BARS = 8;      // beyond this the labels collide on screen
const DOTS_MAX_VALUE = 20;     // a row of more than 20 dots stops being countable
const DOTS_MAX_ROWS  = 7;      // a week

/**
 * Build a chart spec from a list of {label, value}.
 *
 * `highlight` marks the bar the question is ABOUT — "how many came on
 * Sunday" highlights Sunday so nobody is hunting for which bar to read. It is
 * never set on a question whose answer IS which bar (busiest day, most common
 * species), because there it would simply point at the answer.
 */
function cmChart(caption, series, opts) {
    const o = opts || {};
    const trimmed = series.filter(s => s && isFinite(s.value)).slice(0, CHART_MAX_BARS);
    if (trimmed.length < 2) return null;

    const max = Math.max(...trimmed.map(s => s.value));
    if (max <= 0) return null;

    // Dots only where they stay countable: K–2, a week or less, and no row so
    // long that counting it is worse than reading a bar.
    const kind = (o.band === 'k-2' && max <= DOTS_MAX_VALUE && trimmed.length <= DOTS_MAX_ROWS)
        ? 'dots' : 'bars';

    return { kind, caption, series: trimmed, highlight: o.highlight || null, max };
}

// The week as one bar per day, oldest first — the shape every "per day"
// question wants, and the one the class sees often enough to get used to.
function cmDaySeries(s) {
    return s.days.map(d => ({ label: cmDayLabel(d.day), value: d.n, key: d.day }));
}

/**
 * The clearest photo this feeder has of each species, for the chart labels.
 *
 * A K-2 class is the band least able to read "Carolina Chickadee" off a chart
 * and most able to recognise the bird, so the picture is doing the real work
 * of the label for them. The best shot is the highest-confidence one, which
 * snapshots is already sorted by.
 *
 * Only this feeder's own photos — never a stock image. The point of the
 * lesson is the bird that came to THIS feeder, and a reference photo of a
 * different individual in different light quietly undoes that.
 */
function cmSpeciesPhoto(s, species) {
    const shot = s.snapshots.find(r => r.species === species);
    return shot ? shot.image_url : null;
}

function cmSpeciesSeries(s, limit) {
    return s.species.slice(0, limit || CHART_MAX_BARS)
        .map(x => ({ label: x.species, value: x.n, key: x.species,
                     image: cmSpeciesPhoto(s, x.species) }));
}

/**
 * Render a chart as inline SVG (bars) or plain elements (dots).
 *
 * Inline rather than a library: this is two shapes on a projector, the page
 * already ships no chart library, and adding one to draw eight rectangles
 * would cost more download than the whole classroom module.
 */
function classroomChartHtml(chart, revealed) {
    if (!chart) return '';
    return chart.kind === 'dots'
        ? classroomDotsHtml(chart, revealed)
        : classroomBarsHtml(chart, revealed);
}

// Pick a gridline step that lands on friendly numbers — 1, 2, 5, 10, 20, 50…
// so the class reads "ten" off the axis rather than "twelve point five".
function cmNiceStep(max) {
    const target = max / 4;                       // about four gridlines
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, target))));
    for (const m of [1, 2, 5, 10]) {
        if (pow * m >= target) return pow * m;
    }
    return pow * 10;
}

function classroomBarsHtml(chart, revealed) {
    const hasPhotos = chart.series.some(x => x.image);
    const W = 1000, H = hasPhotos ? 520 : 420;
    const padL = 70, padR = 20, padT = 30, padB = hasPhotos ? 186 : 86;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const step = cmNiceStep(chart.max);
    const top = Math.ceil(chart.max / step) * step;
    const y = v => padT + plotH - (v / top) * plotH;

    // Gridlines first, so the bars sit on top of them.
    let grid = '';
    for (let v = 0; v <= top + 0.001; v += step) {
        const yy = y(v);
        grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" class="cc-grid"/>`
             +  `<text x="${padL - 12}" y="${yy + 7}" class="cc-axis" text-anchor="end">${v}</text>`;
    }

    const n = chart.series.length;
    const slot = plotW / n;
    const barW = Math.min(slot * 0.62, 96);

    // Room under the axis for a photo, when the series has them. The labels
    // move down to make space rather than the plot shrinking, because a
    // shorter plot makes every bar harder to read against the gridlines.
    const withPhotos = chart.series.some(x => x.image);
    // SVG ids are document-global, so a fixed id would let a second chart's
    // clip paths override the first one's.
    const nonce = Math.random().toString(36).slice(2, 8);
    const thumbW = Math.min(barW * 1.5, 130);
    const thumbH = Math.round(thumbW / 1.3);        // same shape as .cc-thumb
    // The image box is drawn 19% taller than the visible rect and clipped to
    // it, so the burned-in caption falls off the bottom. A rect this shape
    // with plain "slice" would show the full height of the frame — caption
    // and all — because the source is wider than the box.
    const thumbSrcH = Math.round(thumbH * 1.19);
    const labelDrop = withPhotos ? thumbH + 12 : 0;

    const bars = chart.series.map((s, i) => {
        const cx = padL + slot * i + slot / 2;
        const h = Math.max(1, (s.value / top) * plotH);
        const on = chart.highlight && s.key === chart.highlight;
        // Long species names on a 1000-unit canvas need two lines; days and
        // hours never do.
        const label = String(s.label);
        const parts = label.length > 12 ? label.split(' ') : [label];
        const lines = parts.length > 1
            ? [parts.slice(0, -1).join(' '), parts[parts.length - 1]]
            : [label];

        // preserveAspectRatio="xMidYMin slice" is cover anchored to the TOP,
        // which crops the bottom of the frame — and the bottom of the frame is
        // where the species name is burned in. One attribute does the whole
        // job the big snapshot needs a measured aspect ratio for.
        // Each image needs its OWN clip rect — one canvas-sized clipPath
        // rounds nothing. The id carries the chart's nonce so two charts on
        // one page cannot capture each other's clip.
        const clipId = `cc${nonce}-${i}`;
        const thumb = (withPhotos && s.image)
            ? `<clipPath id="${clipId}"><rect x="${cx - thumbW / 2}" y="${H - padB + 6}"
                     width="${thumbW}" height="${thumbH}" rx="8"/></clipPath>`
            + `<image href="${esc(s.image)}" x="${cx - thumbW / 2}" y="${H - padB + 6}"
                      width="${thumbW}" height="${thumbSrcH}"
                      preserveAspectRatio="xMidYMin slice" clip-path="url(#${clipId})"/>`
            : '';

        return `<rect x="${cx - barW / 2}" y="${y(s.value)}" width="${barW}" height="${h}"
                      rx="6" class="cc-bar${on ? ' on' : ''}"/>`
             + (revealed
                 ? `<text x="${cx}" y="${y(s.value) - 10}" class="cc-val" text-anchor="middle">${s.value}</text>`
                 : '')
             + thumb
             + lines.map((ln, k) =>
                 `<text x="${cx}" y="${H - padB + 28 + labelDrop + k * 26}" class="cc-label"
                        text-anchor="middle">${esc(ln)}</text>`).join('');
    }).join('');

    return `
        <figure class="classroom-chart">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${grid}
                <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="cc-axisline"/>
                ${bars}
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

function classroomDotsHtml(chart, revealed) {
    const rows = chart.series.map(s => {
        const on = chart.highlight && s.key === chart.highlight;
        let dots = '';
        for (let i = 0; i < s.value; i++) {
            // A gap after every fifth dot: counting in fives is the point of
            // a tally, and the eye does it without being told.
            dots += `<span class="cc-dot${(i + 1) % 5 === 0 ? ' five' : ''}"></span>`;
        }
        return `
            <div class="cc-row${on ? ' on' : ''}">
                <span class="cc-row-head">
                    ${s.image ? `<span class="cc-thumb"><img src="${esc(s.image)}" alt=""></span>` : ''}
                    <span class="cc-row-label">${esc(s.label)}</span>
                </span>
                <span class="cc-dots">${dots || '<span class="cc-none">none</span>'}</span>
                ${revealed ? `<span class="cc-row-val">${s.value}</span>` : ''}
            </div>`;
    }).join('');

    const withPhotos = chart.series.some(x => x.image);

    return `
        <figure class="classroom-chart dots${withPhotos ? ' with-photos' : ''}">
            <div class="cc-rows">${rows}</div>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

// ── Question templates ───────────────────────────────────
//
// ~15 templates across the six categories in design notes §4, each declaring
// the grade bands it suits. build() returns null when the live data cannot
// answer it honestly — a template that invents a plausible-looking answer is
// worse than one that sits out the week.
//
// Every build() receives:
//   s     — the summary for the source feeder, already windowed to 7 days
//   s14   — the same feeder over the full 14 days, for week-over-week
//   band  — 'k-2' | '3-5' | '6-8'
//   rng   — seeded; use it for every shuffle and every distractor
//   feeder— display name to put in prompts

const CLASSROOM_TEMPLATES = [

// ── 1. Identification ────────────────────────────────────
{
    id: 'id-snapshot',
    category: 'identification',
    title: 'Which bird is this?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        // Confidence floor: a misidentified snapshot teaches the wrong bird,
        // and the model is the only thing standing behind the "right" answer.
        const shot = s.snapshots.find(r => (r.confidence || 0) >= 0.65 && SPECIES_FACTS[r.species])
                  || s.snapshots.find(r => (r.confidence || 0) >= 0.65);
        if (!shot) return null;

        // Distractors are drawn from THIS feeder's other visitors first. A
        // child who has watched the courtyard all term can rule out a bird
        // that has never been there without looking at the photo, which turns
        // an identification question into a memory question.
        const others = s.species.map(x => x.species).filter(sp => sp !== shot.species);
        const want   = band === 'k-2' ? 2 : 3;
        const pool   = cmShuffle(others, rng).concat(
            cmShuffle(COMMON_FEEDER_SPECIES.filter(
                sp => sp !== shot.species && !others.includes(sp)), rng));
        const built  = cmChoices(shot.species, pool.slice(0, want), rng);
        if (!built) return null;

        const when = new Date(shot.detected_at);
        return {
            prompt: band === 'k-2'
                ? 'Which bird came to our feeder?'
                : 'Which species is in this photo?',
            ...built,
            image: { url: shot.image_url, detection_id: shot.id },
            explain: `${shot.species}, photographed at ${feeder} on `
                   + `${when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}`
                   + ` at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`,
            fact: speciesFact(shot.species, band),
            detection_id: shot.id,
        };
    },
},

// ── 2. Counting ──────────────────────────────────────────
{
    id: 'most-common-week',
    category: 'counting',
    title: 'Which bird visited most?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        if (s.species.length < 2) return null;
        const top = s.species[0];
        // A tie has no single right answer, and arguing the tie-break with a
        // class is not the lesson.
        if (s.species[1].n === top.n) return null;

        const built = cmChoices(top.species,
            s.species.slice(1, band === 'k-2' ? 3 : 4).map(x => x.species), rng);
        if (!built) return null;

        return {
            prompt: band === 'k-2'
                ? 'Which bird came the most times this week?'
                : `Which species had the most visits at ${feeder} this week?`,
            ...built,
            // Never highlighted: which bar is tallest IS the answer.
            chart: cmChart('Visits by species this week', cmSpeciesSeries(s), { band }),
            explain: s.species.slice(0, 3)
                .map(x => `${x.species}: ${x.n}`).join(' · '),
            fact: speciesFact(top.species, band),
        };
    },
},
{
    id: 'total-visits',
    category: 'counting',
    title: 'How many visits?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        // K–2 counts a day, not a week: a number a class can actually tally
        // with marks on the board is the point of the exercise (§11).
        if (band === 'k-2') {
            const best = s.days.slice().sort((a, b) => b.n - a.n)[0];
            if (!best || best.n < 3 || best.n > 40) return null;
            const built = cmChoices(String(best.n),
                                    cmNumberDistractors(best.n, rng, 2).map(String), rng);
            if (!built) return null;
            return {
                prompt: `How many birds came ${cmWhenPhrase(best.day)}?`,
                ...built,
                // The whole week, with that day marked. Marking it gives away
                // nothing — the question already names the day — and saves
                // thirty children hunting for which row to count.
                chart: cmChart(`Visits each day at ${feeder}`,
                               cmDaySeries(s), { band, highlight: best.day }),
                explain: `${best.n} visits at ${feeder} on ${cmDayLabel(best.day, true)}.`,
            };
        }
        if (s.total < 10) return null;
        const built = cmChoices(String(s.total),
                                cmNumberDistractors(s.total, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many bird visits did ${feeder} record in the last 7 days?`,
            ...built,
            // No highlight: the answer is the sum of every bar, so pointing at
            // one would be pointing at the wrong thing.
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s), { band }),
            explain: `${s.total} visits across ${s.days.length} day${s.days.length === 1 ? '' : 's'}.`,
        };
    },
},
{
    id: 'species-variety',
    category: 'counting',
    title: 'How many kinds of bird?',
    bands: ['3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        if (s.distinct < 2) return null;
        const built = cmChoices(String(s.distinct),
                                cmNumberDistractors(s.distinct, rng, 3)
                                    .filter(n => n > 0).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many different species visited ${feeder} this week?`,
            ...built,
            // Here the answer is the NUMBER OF BARS, which is exactly what the
            // chart is for — count the bars, not their heights.
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s, CHART_MAX_BARS), { band }),
            explain: s.species.map(x => x.species).join(', '),
        };
    },
},

// ── 3. Comparison ────────────────────────────────────────
{
    id: 'more-or-fewer',
    category: 'comparison',
    title: 'Which bird came more?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        if (s.species.length < 2) return null;
        const [a, b] = s.species;
        if (a.n === b.n) return null;
        const shuffled = cmShuffle([a, b], rng);
        return {
            prompt: `Did more ${a.species}s or more ${b.species}s come this week?`,
            choices: shuffled.map(x => ({ label: x.species })),
            correct_index: shuffled.findIndex(x => x.species === a.species),
            chart: cmChart('Visits by species this week',
                           [a, b].map(x => ({ label: x.species, value: x.n, key: x.species,
                                              image: cmSpeciesPhoto(s, x.species) })),
                           { band: 'k-2' }),
            explain: `${a.species}: ${a.n} visits. ${b.species}: ${b.n} visits.`,
            fact: speciesFact(a.species, 'k-2'),
        };
    },
},
{
    id: 'how-many-more',
    category: 'comparison',
    title: 'How many more?',
    bands: ['3-5', '6-8'],
    build({ s, band, rng }) {
        if (s.species.length < 2) return null;
        const [a, b] = s.species;
        const diff = a.n - b.n;
        if (diff < 1) return null;
        const built = cmChoices(String(diff),
                                cmNumberDistractors(diff, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many more ${a.species} visits than ${b.species} visits were there this week?`,
            ...built,
            chart: cmChart('Visits by species this week',
                           [a, b].map(x => ({ label: x.species, value: x.n, key: x.species,
                                              image: cmSpeciesPhoto(s, x.species) })),
                           { band }),
            explain: `${a.n} − ${b.n} = ${diff}.`,
        };
    },
},
{
    id: 'week-over-week',
    category: 'comparison',
    title: 'Busier than last week?',
    bands: ['3-5', '6-8'],
    build({ s, s14, band, rng, feeder }) {
        // Needs a genuine previous week, not a feeder that only started
        // logging on Tuesday.
        const prevTotal = s14.total - s.total;
        if (s.total < 8 || prevTotal < 8) return null;
        const prevDays = s14.days.filter(d =>
            cmDayStart(d.day).getTime() < Date.now() - 7 * 86400000).length;
        if (prevDays < 4) return null;

        const answer = s.total > prevTotal ? 'More this week'
                     : s.total < prevTotal ? 'Fewer this week'
                     : 'About the same';
        const opts = cmShuffle(['More this week', 'Fewer this week', 'About the same'], rng);
        return {
            prompt: `Did ${feeder} have more or fewer visits this week than last week?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            chart: cmChart('This week against last week',
                           [{ label: 'Last week', value: prevTotal, key: 'prev' },
                            { label: 'This week', value: s.total,   key: 'now' }], { band }),
            explain: `This week: ${s.total}. Last week: ${prevTotal}.`,
        };
    },
},

// ── 4. Time ──────────────────────────────────────────────
{
    id: 'busiest-day',
    category: 'time',
    title: 'Which day was busiest?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        if (s.days.length < 3) return null;
        const sorted = s.days.slice().sort((a, b) => b.n - a.n);
        if (sorted[0].n === sorted[1].n) return null;

        const pick = sorted.slice(0, band === 'k-2' ? 3 : 4);
        const opts = cmShuffle(pick, rng);
        return {
            prompt: band === 'k-2'
                ? 'Which day did the most birds come?'
                : `Which day was busiest at ${feeder} this week?`,
            choices: opts.map(d => ({ label: cmDayLabel(d.day, true) })),
            correct_index: opts.findIndex(d => d.day === sorted[0].day),
            // Every day, in order, unmarked: finding the tallest is the work.
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s), { band }),
            explain: pick.map(d => `${cmDayLabel(d.day)}: ${d.n}`).join(' · '),
        };
    },
},
{
    id: 'morning-or-afternoon',
    category: 'time',
    title: 'Morning or afternoon?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        if (s.total < 8) return null;
        const morning   = s.byHour.slice(5, 12).reduce((a, b) => a + b, 0);
        const afternoon = s.byHour.slice(12, 18).reduce((a, b) => a + b, 0);
        if (morning + afternoon < 6) return null;
        if (morning === afternoon) return null;

        const answer = morning > afternoon ? 'Morning' : 'Afternoon';
        const opts = cmShuffle(['Morning', 'Afternoon'], rng);
        return {
            prompt: 'Did more birds come in the morning or the afternoon?',
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            chart: cmChart('When the birds came this week',
                           [{ label: 'Morning', value: morning, key: 'am' },
                            { label: 'Afternoon', value: afternoon, key: 'pm' }], { band: 'k-2' }),
            explain: `Morning: ${morning} visits. Afternoon: ${afternoon} visits.`,
        };
    },
},
{
    id: 'peak-hour',
    category: 'time',
    title: 'What hour was busiest?',
    bands: ['3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        if (s.total < 12) return null;
        const ranked = s.byHour
            .map((n, h) => ({ h, n }))
            .filter(x => x.n > 0)
            .sort((a, b) => b.n - a.n);
        if (ranked.length < 3 || ranked[0].n === ranked[1].n) return null;

        const pick = ranked.slice(0, 4);
        const opts = cmShuffle(pick, rng);
        return {
            prompt: `Which hour had the most visits at ${feeder} this week?`,
            choices: opts.map(x => ({ label: cmHourLabel(x.h) })),
            correct_index: opts.findIndex(x => x.h === ranked[0].h),
            // By clock order, not by size: sorted bars would put the answer
            // first and turn reading the chart into reading its ordering.
            chart: cmChart('Visits by hour this week',
                           s.byHour.map((n, h) => ({ label: cmHourLabel(h), value: n, key: h }))
                                   .filter(x => x.value > 0), { band }),
            explain: pick.map(x => `${cmHourLabel(x.h)}: ${x.n}`).join(' · '),
        };
    },
},

// ── 5. Fractions, percents, averages (design notes §11) ──
{
    id: 'fraction-species',
    category: 'math',
    title: 'About what fraction?',
    bands: ['3-5'],
    build({ s, band, rng }) {
        if (s.total < 12 || !s.species.length) return null;
        const top = s.species[0];
        const share = top.n / s.total;

        const bands = [
            { label: 'about half',           v: 0.5  },
            { label: 'about a quarter',      v: 0.25 },
            { label: 'about a tenth',        v: 0.1  },
            { label: 'nearly all of them',   v: 0.9  },
        ];
        const best = bands.slice().sort((a, b) =>
            Math.abs(a.v - share) - Math.abs(b.v - share))[0];
        // Only ask when one band is clearly the right one. "0.33" sits
        // between a quarter and a half, and a class that argues about which
        // is closer is arguing about the question, not the birds.
        if (Math.abs(best.v - share) > 0.09) return null;

        const opts = cmShuffle(bands.map(b => b.label), rng);
        return {
            prompt: `About what fraction of this week's visits were ${top.species}?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(best.label),
            // The named species is marked: the comparison is that bar against
            // the rest, and the answer is a ratio, not a bar.
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s), { band, highlight: top.species }),
            explain: `${top.n} of ${s.total} visits — that's ${Math.round(share * 100)}%.`,
        };
    },
},
{
    id: 'percent-species',
    category: 'math',
    title: 'What percent?',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.total < 20 || !s.species.length) return null;
        const top = s.species[0];
        const pct = Math.round((top.n / s.total) * 100);
        const built = cmChoices(`${pct}%`,
            cmNumberDistractors(pct, rng, 4)
                .filter(v => v > 0 && v <= 100)
                .slice(0, 3)
                .map(v => `${v}%`), rng);
        if (!built) return null;
        return {
            prompt: `What percent of this week's visits were ${top.species}?`,
            ...built,
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s), { band, highlight: top.species }),
            explain: `${top.n} ÷ ${s.total} = ${(top.n / s.total).toFixed(2)} → ${pct}%.`,
        };
    },
},
{
    id: 'visits-per-day',
    category: 'math',
    title: 'Average visits per day',
    bands: ['3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        if (s.days.length < 4 || s.total < 12) return null;
        const avg = Math.round(s.total / s.days.length);
        if (avg < 1) return null;
        const built = cmChoices(String(avg),
                                cmNumberDistractors(avg, rng, 3).filter(v => v > 0).map(String), rng);
        if (!built) return null;
        return {
            prompt: `On average, about how many visits per day did ${feeder} get this week?`,
            ...built,
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s), { band }),
            explain: `${s.total} visits ÷ ${s.days.length} days ≈ ${avg} per day.`,
        };
    },
},
{
    id: 'warm-or-cold',
    category: 'math',
    title: 'Weather and visits',
    bands: ['6-8'],
    build({ s, band, rng }) {
        // Needs temperature on most rows and a real spread; otherwise the
        // "answer" is noise dressed up as a finding.
        if (s.tempCoverage < 0.6 || s.dayTemp.size < 4) return null;
        const days = [...s.dayTemp.entries()]
            .map(([day, t]) => ({ day, temp: t.sum / t.n, n: s.byDay.get(day) || 0 }))
            .sort((a, b) => a.temp - b.temp);
        if (days[days.length - 1].temp - days[0].temp < 5) return null;

        const half  = Math.floor(days.length / 2);
        const cold  = days.slice(0, half);
        const warm  = days.slice(days.length - half);
        const coldAvg = cold.reduce((a, d) => a + d.n, 0) / cold.length;
        const warmAvg = warm.reduce((a, d) => a + d.n, 0) / warm.length;
        if (Math.abs(warmAvg - coldAvg) < 1) return null;

        const answer = warmAvg > coldAvg ? 'On the warmer days' : 'On the colder days';
        const opts = cmShuffle(['On the warmer days', 'On the colder days', 'No real difference'], rng);
        return {
            prompt: 'Did the feeder get more visits on the warmer days or the colder days this week?',
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            // Labelled with each day's temperature, in date order, so the
            // class has to put the two variables together themselves.
            chart: cmChart('Visits each day, with that day\u2019s temperature',
                           days.slice().sort((x, y) => x.day.localeCompare(y.day))
                               .map(d => ({ label: `${cmDayLabel(d.day)} ${Math.round(d.temp)}\u00b0`,
                                            value: d.n, key: d.day })), { band }),
            explain: `Colder half averaged ${coldAvg.toFixed(1)} visits/day `
                   + `(${cold[0].temp.toFixed(0)}–${cold[cold.length - 1].temp.toFixed(0)}°); `
                   + `warmer half averaged ${warmAvg.toFixed(1)} `
                   + `(${warm[0].temp.toFixed(0)}–${warm[warm.length - 1].temp.toFixed(0)}°).`,
        };
    },
},

// ── 6. Prediction (auto-checked later) ───────────────────
//
// These are the only questions that leave the session unscored. The class
// commits to an answer today; pending_check says what to measure and when,
// and cmResolvePendingPredictions settles it on a later visit.
{
    id: 'predict-tomorrow',
    category: 'prediction',
    title: 'More or fewer tomorrow?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder, source }) {
        const todayKey = cmDayKey(new Date());
        const todayN   = s.byDay.get(todayKey) || 0;
        // Asked before the feeder has done anything today, "more than today"
        // is a formality rather than a prediction.
        if (todayN < 3) return null;

        const tomorrowKey = cmDayKey(new Date(Date.now() + 86400000));
        const opts = cmShuffle(['More than today', 'Fewer than today', 'About the same'], rng);

        return {
            prompt: band === 'k-2'
                ? `Today ${feeder} had ${todayN} bird visits. Will tomorrow have more or fewer?`
                : `${feeder} has ${todayN} visits today. Will tomorrow have more, fewer, or about the same?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: null,            // not knowable yet
            explain: 'We will check this at the start of the next class.',
            // The run-up, with today marked. A prediction with the trend in
            // front of them is a reasoned guess; without it, it is a coin.
            chart: cmChart(`Visits each day at ${feeder}`,
                           cmDaySeries(s), { band, highlight: todayKey }),
            pending_check: {
                kind: 'visits_on_day',
                feeder_id: source.feederId,
                day: tomorrowKey,
                baseline: todayN,
                labels: opts,
            },
            // End of tomorrow, local time — the earliest moment the count is
            // final rather than half a day's worth.
            resolve_after: new Date(cmDayStart(tomorrowKey).getTime() + 86400000).toISOString(),
        };
    },
},
{
    id: 'predict-week',
    category: 'prediction',
    title: 'Visits over the next week',
    bands: ['3-5', '6-8'],
    build({ s, band, rng, feeder, source }) {
        if (s.total < 15 || s.days.length < 4) return null;
        const perDay = s.total / s.days.length;
        const est    = Math.round(perDay * 7);
        const step   = Math.max(5, Math.round(est * 0.4));

        // Four contiguous, non-overlapping bands covering 0..∞, so whatever
        // the week actually does, exactly one choice was right.
        const edges = [est - step, est, est + step];
        const buckets = [
            { label: `Fewer than ${edges[0]}`,           lo: 0,            hi: edges[0] },
            { label: `${edges[0]}–${edges[1] - 1}`,      lo: edges[0],     hi: edges[1] },
            { label: `${edges[1]}–${edges[2] - 1}`,      lo: edges[1],     hi: edges[2] },
            { label: `${edges[2]} or more`,              lo: edges[2],     hi: null },
        ];
        if (edges[0] < 1) return null;

        const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() + 1);
        const to   = new Date(from.getTime() + 7 * 86400000);
        const opts = cmShuffle(buckets, rng);

        return {
            prompt: `${feeder} averages about ${Math.round(perDay)} visits a day. `
                  + 'How many visits will it get over the next 7 days?',
            choices: opts.map(b => ({ label: b.label })),
            correct_index: null,
            explain: 'We will count the real total when the week is up.',
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s), { band }),
            pending_check: {
                kind: 'visits_window',
                feeder_id: source.feederId,
                from: from.toISOString(),
                to:   to.toISOString(),
                buckets: opts.map(b => ({ lo: b.lo, hi: b.hi })),
            },
            resolve_after: to.toISOString(),
        };
    },
},
];

/**
 * Build this session's questions.
 *
 * Every applicable template is asked for a question; the ones that cannot
 * answer honestly return null and drop out. What survives is shuffled and
 * capped, with identification first — starting a class on a photo of a bird
 * works where starting on a percentage does not.
 */
function buildClassroomQuestions(room, data) {
    const source = cmPickSource(data);
    if (!source || !source.total) return { questions: [], source: null };

    const s    = cmWindow(source, 7);
    const s14  = source;
    const band = room.grade_band || 'k-2';
    const seed = `${room.id}|${cmDayKey(new Date())}|${source.feederId}`;
    const feeder = source.name;

    const out = [];
    for (const t of CLASSROOM_TEMPLATES) {
        if (!t.bands.includes(band)) continue;
        let q = null;
        try {
            q = t.build({ s, s14, band, rng: cmRng(seed + '|' + t.id), feeder, source, room });
        } catch (e) {
            // A template that throws sits the week out rather than taking the
            // lesson down with it — but it says so. Swallowing this silently
            // is how a broken template disappears for months looking like
            // "not enough data".
            console.warn(`[classroom] template "${t.id}" failed:`, e);
            q = null;
        }
        if (!q || !q.choices || q.choices.length < 2) continue;

        out.push({
            template_id: t.id,
            category:    t.category,
            title:       t.title,
            grade_band:  band,
            scope:       source.isHome ? 'home' : 'partner',
            source_feeder_id:   source.feederId,
            source_feeder_name: source.name,
            from_partner: !source.isHome,
            ...q,
        });
    }

    const rng = cmRng(seed + '|order');
    const ident = out.filter(q => q.category === 'identification');
    const rest  = cmShuffle(out.filter(q => q.category !== 'identification'), rng);

    return {
        questions: ident.concat(rest).slice(0, CLASSROOM_QUESTIONS_PER_SESSION),
        source,
    };
}

// ── Teacher panel ────────────────────────────────────────

function openClassroomPanel() {
    const modal = document.getElementById('classroom-panel-modal');
    if (!modal) return;

    if (typeof hasAuthSession !== 'function' || !hasAuthSession()) {
        showToast('Classroom mode needs an email sign-in — use "Sign In", not Mod login.');
        return;
    }

    const mine = classroomCommunities();
    const sel  = document.getElementById('classroom-community-select');
    sel.innerHTML = mine.map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.role)})</option>`).join('');

    // A teacher almost always belongs to exactly one school, and a dropdown
    // with one entry is a control that can only be set to what it already
    // says. Hide it rather than make them look at it before every lesson.
    sel.style.display = mine.length > 1 ? '' : 'none';

    const empty = document.getElementById('classroom-panel-empty');
    if (empty) empty.style.display = mine.length ? 'none' : '';
    const body = document.getElementById('classroom-panel-body');
    if (body) body.style.display = mine.length ? '' : 'none';

    modal.classList.add('open');
    if (mine.length) {
        classroomCommunityId = sel.value;
        refreshClassroomPanel();
    }
}

function closeClassroomPanel() {
    document.getElementById('classroom-panel-modal')?.classList.remove('open');
}

async function onClassroomCommunityChange() {
    classroomCommunityId = document.getElementById('classroom-community-select').value;
    classroomEditingId = null;
    await refreshClassroomPanel();
}

async function refreshClassroomPanel() {
    const list = document.getElementById('classroom-list');
    if (!list || !classroomCommunityId) return;
    list.innerHTML = '<div class="classroom-muted">Loading…</div>';

    await loadClassroomFeederOptions();
    await loadClassroomStaff();

    // Purge nicknames and tokens left behind by a session nobody closed —
    // the lid went down, the tab was shut. §8 says student data goes at the
    // end of the lesson, and "the next time this classroom happens to run"
    // is not the end of the lesson. Fire-and-forget: it must never be able
    // to stop the panel from opening.
    sbRpc('classroom_sweep', {}, true).catch(() => {});

    const { data, error } = await sbRpc('classroom_list',
        { p_community_id: classroomCommunityId }, true);
    if (error) {
        list.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load classrooms.')}</div>`;
        return;
    }
    classroomList = Array.isArray(data) ? data : [];
    renderClassroomList();
    renderClassroomForm();
    classroomList.forEach(r => cmResolvePendingPredictions(r));
}

/**
 * The feeders a classroom may point at: approved members of this community.
 *
 * Read straight from the REST tables rather than through
 * community_feeders_list, which is owner/moderator-only — a teacher has to be
 * able to pick their own classroom's feeder without being handed the keys to
 * the roster.
 */
async function loadClassroomFeederOptions() {
    classroomFeederOpts = [];
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/community_feeders`
            + `?select=feeder_id&status=eq.approved&community_id=eq.${classroomCommunityId}`,
            { headers: sbHeaders(true) });
        if (!res.ok) return;
        const ids = (await res.json()).map(r => r.feeder_id).filter(Boolean);
        if (!ids.length) return;

        const fres = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?id=in.(${ids.join(',')})`
            + `&select=id,display_name,last_heartbeat_at&order=display_name.asc`,
            { headers: sbHeaders(true) });
        if (!fres.ok) return;
        classroomFeederOpts = await fres.json();
    } catch {
        classroomFeederOpts = [];
    }
}

/**
 * The people a classroom may be handed to.
 *
 * Owners and moderators only — classroom_update refuses a reassignment from
 * anybody else, so a teacher is never shown a picker that would only produce
 * an error. Invites are filtered out too: an address that has never signed in
 * has no user id to assign a classroom to, and it would sit in the list
 * looking like a choice.
 */
async function loadClassroomStaff() {
    classroomStaff = [];
    if (!classroomCanAssign()) return;

    const { data, error } = await sbRpc('community_members_list',
        { p_community_id: classroomCommunityId }, true);
    if (error || !Array.isArray(data)) return;

    classroomStaff = data.filter(m =>
        m.kind === 'member' && ['owner', 'moderator', 'teacher'].includes(m.role));
}

function renderClassroomList() {
    const list = document.getElementById('classroom-list');
    if (!list) return;

    if (!classroomList.length) {
        list.innerHTML = '<div class="classroom-muted">No classrooms yet. '
                       + 'Create one below — it takes a name, the feeder your class watches, '
                       + 'and a grade band.</div>';
        return;
    }

    list.innerHTML = classroomList.map(r => {
        const partners = (r.partners || []).map(p => p.display_name).filter(Boolean);
        const seen = r.home_feeder_seen_at
            ? new Date(r.home_feeder_seen_at).getTime() > Date.now() - 10 * 60 * 1000
            : false;
        const feederLine = r.home_feeder_id
            ? `<span class="classroom-dot ${seen ? 'on' : 'off'}"></span>${esc(r.home_feeder_name || 'Feeder')}`
            : '<span class="classroom-warn">No home feeder set</span>';

        return `
        <div class="classroom-card" data-room="${esc(r.id)}">
            <div class="classroom-card-head">
                <div>
                    <strong>${esc(r.name)}</strong>
                    <span class="classroom-pill">${esc(GRADE_BAND_LABELS[r.grade_band] || r.grade_band)}</span>
                </div>
                <div class="classroom-card-actions">
                    <button class="classroom-btn-primary" onclick="startClassroomSession('${esc(r.id)}','teacher_led')"
                            ${r.home_feeder_id ? '' : 'disabled title="Set a home feeder first"'}>▶ On the board</button>
                    <button class="classroom-btn-primary" onclick="startClassroomSession('${esc(r.id)}','join_code')"
                            ${r.home_feeder_id ? '' : 'disabled title="Set a home feeder first"'}>📱 With devices</button>
                    <button class="classroom-btn" onclick="editClassroom('${esc(r.id)}')">Edit</button>
                    <button class="classroom-btn" onclick="showClassroomHistory('${esc(r.id)}')">Results</button>
                    <button class="classroom-btn" onclick="copyClassroomLink('${esc(r.id)}')"
                            title="A link that opens straight into this class">🔗 Link</button>
                    <button class="classroom-btn-danger" onclick="deleteClassroom('${esc(r.id)}')">Delete</button>
                </div>
            </div>
            <div class="classroom-card-meta">
                ${feederLine}
                ${partners.length ? ` · partners: ${esc(partners.join(', '))}` : ''}
                ${r.session_count ? ` · ${r.session_count} session${r.session_count === 1 ? '' : 's'}` : ''}
                ${r.is_mine ? '' : ` · taught by ${esc(r.teacher_label)}`}
            </div>
            <div class="classroom-pending" id="classroom-pending-${esc(r.id)}"></div>
        </div>`;
    }).join('');
}

/**
 * A link that opens straight into one classroom.
 *
 * The point is the classroom PC. A teacher signs in there once, bookmarks
 * this, and from then on the lesson is one click from the desktop instead of
 * sign in, open the panel, find the class. Teachers run this between a bell
 * and thirty children sitting down; the clicks are the feature.
 *
 * It grants nothing. The id in the URL is only a pointer — every RPC behind
 * it still goes through classroom_require_manage, so a link forwarded to
 * somebody else's account opens an empty panel.
 */
function classroomLinkFor(id) {
    const u = new URL(location.href);
    u.search = '?classroom=' + encodeURIComponent(id);
    u.hash = '';
    return u.toString();
}

async function copyClassroomLink(id) {
    const url = classroomLinkFor(id);
    try {
        await navigator.clipboard.writeText(url);
        showToast('Link copied — bookmark it on the classroom computer.');
    } catch {
        // Clipboard access needs a secure context and a user gesture, and a
        // school machine may refuse it. Showing the link is still useful.
        window.prompt('Copy this link:', url);
    }
}

function renderClassroomForm() {
    const box = document.getElementById('classroom-form');
    if (!box) return;
    const editing = classroomEditingId
        ? classroomList.find(r => r.id === classroomEditingId)
        : null;

    const feederOpts = (selected) => classroomFeederOpts.map(f =>
        `<option value="${esc(f.id)}"${f.id === selected ? ' selected' : ''}>${esc(f.display_name || 'Feeder')}</option>`
    ).join('');

    // Who the classroom belongs to. A teacher gets no picker — they can only
    // ever create their own — so for them this is a plain line of text saying
    // so, rather than a disabled control that invites a support question.
    const me       = classroomMyUserId();
    const assigned = editing ? editing.teacher_user_id : me;
    // A classroom whose teacher has since left the community has an assigned
    // id that is no longer in the staff list. Without an option for them the
    // <select> would quietly fall to its first entry, and saving an unrelated
    // edit would hand somebody else's class away. Keep the departed holder as
    // an explicit, selected choice instead.
    const orphan = editing && assigned && !classroomStaff.some(m => m.id === assigned);
    const teacherOpts = classroomCanAssign() && classroomStaff.length
        ? (orphan
            ? `<option value="${esc(assigned)}" selected>${esc(editing.teacher_label || 'Current teacher')}` +
              ` — no longer in this community</option>`
            : '')
          + classroomStaff.map(m =>
              `<option value="${esc(m.id)}"${!orphan && m.id === assigned ? ' selected' : ''}>` +
              `${esc(m.label)}${m.id === me ? ' (you)' : ''} — ${esc(m.role)}</option>`).join('')
        : null;

    box.innerHTML = `
        <h4 class="classroom-h">${editing ? 'Edit classroom' : 'New classroom'}</h4>
        ${classroomFeederOpts.length ? '' :
            '<p class="classroom-warn">This community has no approved feeders yet, '
          + 'so there is nothing for a class to watch. Approve a feeder first.</p>'}
        <input type="text" id="classroom-name" maxlength="80" placeholder="Class name (e.g. Mrs. Diaz — Grade 2)"
               value="${esc(editing?.name || '')}">
        <div class="classroom-form-row">
            <label>Home feeder
                <select id="classroom-home-feeder" onchange="renderClassroomPartnerChecks()">
                    <option value="">— choose a feeder —</option>
                    ${feederOpts(editing?.home_feeder_id)}
                </select>
            </label>
            ${teacherOpts ? `<label>Taught by
                <select id="classroom-teacher">${teacherOpts}</select>
            </label>` : ''}
            <label>Grade band
                <select id="classroom-grade-band">
                    <option value="k-2"${editing?.grade_band === 'k-2' ? ' selected' : ''}>K–2 — pictures and counting</option>
                    <option value="3-5"${editing?.grade_band === '3-5' ? ' selected' : ''}>Grades 3–5 — charts and averages</option>
                    <option value="6-8"${editing?.grade_band === '6-8' ? ' selected' : ''}>Grades 6–8 — percents and trends</option>
                </select>
            </label>
        </div>
        <details class="classroom-details">
            <summary>Partner feeders (optional)</summary>
            <p class="classroom-muted">
                Used as a backup when your own feeder is quiet — questions drawn from a
                partner are labelled on screen so the class knows whose feeder they are
                looking at. Comparing feeders head-to-head comes later.
            </p>
            <div id="classroom-partners" class="classroom-checks"></div>
        </details>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="saveClassroom()">
                ${editing ? 'Save changes' : 'Create classroom'}
            </button>
            ${editing ? '<button class="classroom-btn" onclick="cancelClassroomEdit()">Cancel</button>' : ''}
        </div>
        <div id="classroom-form-status" class="classroom-status"></div>`;

    renderClassroomPartnerChecks();
}

/**
 * The partner-feeder checkboxes, minus whichever feeder is currently selected
 * as the home feeder.
 *
 * Re-rendered on every home-feeder change rather than filtered once: a
 * classroom may not partner with itself (classroom_partners_set refuses it),
 * and a checkbox that is accepted by the form and then rejected by the server
 * reads as a save that half-worked.
 */
function renderClassroomPartnerChecks() {
    const box = document.getElementById('classroom-partners');
    if (!box) return;

    const editing = classroomEditingId
        ? classroomList.find(r => r.id === classroomEditingId)
        : null;
    const home    = document.getElementById('classroom-home-feeder')?.value || '';
    // Keep ticks the teacher has already made across a home-feeder change.
    const ticked  = new Set([...box.querySelectorAll('input:checked')].map(el => el.value));
    if (!ticked.size) (editing?.partners || []).forEach(p => ticked.add(p.feeder_id));

    const boxes = classroomFeederOpts
        .filter(f => f.id !== home)
        .map(f => `
            <label class="classroom-check">
                <input type="checkbox" value="${esc(f.id)}"${ticked.has(f.id) ? ' checked' : ''}>
                ${esc(f.display_name || 'Feeder')}
            </label>`).join('');

    box.innerHTML = boxes
        || '<span class="classroom-muted">No other feeders in this community.</span>';
}

function editClassroom(id) {
    classroomEditingId = id;
    renderClassroomForm();
    document.getElementById('classroom-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelClassroomEdit() {
    classroomEditingId = null;
    renderClassroomForm();
}

async function saveClassroom() {
    const name   = document.getElementById('classroom-name').value.trim();
    const home   = document.getElementById('classroom-home-feeder').value;
    const band   = document.getElementById('classroom-grade-band').value;
    const status = document.getElementById('classroom-form-status');
    const say = (msg, ok) => {
        status.textContent = msg;
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
    };

    if (!name) { say('Give the class a name.', false); return; }
    if (!home) { say('Choose the feeder this class watches.', false); return; }

    const partners = [...document.querySelectorAll('#classroom-partners input:checked')]
        .map(el => el.value)
        .filter(id => id !== home);

    // Null when there is no picker (a teacher), which leaves the classroom
    // with whoever it already belongs to.
    const teacherEl = document.getElementById('classroom-teacher');
    const teacher   = teacherEl ? teacherEl.value : null;

    let roomId = classroomEditingId;
    if (roomId) {
        const { error } = await sbRpc('classroom_update', {
            p_classroom_id:    roomId,
            p_name:            name,
            p_home_feeder_id:  home,
            p_grade_band:      band,
            p_teacher_user_id: teacher || null,
        }, true);
        if (error) { say(error.message || 'Could not save.', false); return; }
    } else {
        const { data, error } = await sbRpc('classroom_create', {
            p_community_id:   classroomCommunityId,
            p_name:           name,
            p_home_feeder_id: home,
            p_grade_band:     band,
            p_question_scope: 'home',
        }, true);
        if (error) { say(error.message || 'Could not create.', false); return; }
        roomId = data && data.id;

        // classroom_create always makes the CREATOR the teacher — it takes no
        // teacher argument, deliberately, so that a teacher cannot mint a
        // classroom in a colleague's name. A moderator setting one up for
        // somebody else therefore hands it over immediately afterwards.
        //
        // Reported rather than swallowed if it fails: the classroom exists
        // either way, and a moderator who thinks she assigned it and did not
        // would find out when the teacher says their panel is empty.
        if (roomId && teacher && teacher !== classroomMyUserId()) {
            const { error: aerr } = await sbRpc('classroom_update', {
                p_classroom_id:    roomId,
                p_teacher_user_id: teacher,
            }, true);
            if (aerr) {
                say('Classroom created, but it is still assigned to you — '
                  + (aerr.message || 'the handover failed') + '. Use Edit to try again.', false);
                await refreshClassroomPanel();
                return;
            }
        }
    }

    if (roomId) {
        const { error } = await sbRpc('classroom_partners_set', {
            p_classroom_id: roomId,
            p_feeder_ids:   partners,
        }, true);
        // A partner-feeder failure must not read as "the classroom wasn't
        // created" — it was, and it works without partners.
        if (error) showToast('Classroom saved, but partner feeders did not: ' + (error.message || ''));
    }

    classroomEditingId = null;
    say('Saved.', true);
    await refreshClassroomPanel();
}

async function deleteClassroom(id) {
    const room = classroomList.find(r => r.id === id);
    if (!confirm(`Delete "${room ? room.name : 'this classroom'}"?\n\n`
               + 'Its sessions and saved results go too. The feeder and its photos are '
               + 'untouched.\n\nContinue?')) return;

    const { error } = await sbRpc('classroom_delete', { p_classroom_id: id }, true);
    if (error) { showToast('Error: ' + (error.message || 'delete failed')); return; }
    showToast('Classroom deleted.');
    await refreshClassroomPanel();
}

// ── Pending predictions (design notes §4 category 5) ─────

// Count a feeder's detections in a window without pulling the rows: ask for
// one row with an exact count and read the total off the content-range header.
async function cmCountDetections(feederId, fromIso, toIso) {
    const url = `${SUPABASE_URL}/rest/v1/community_detections?select=id`
              + `&feeder_id=eq.${feederId}`
              + `&detected_at=gte.${encodeURIComponent(fromIso)}`
              + `&detected_at=lt.${encodeURIComponent(toIso)}&limit=1`;
    const headers = sbHeaders(true);
    headers['Prefer'] = 'count=exact';
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Score any prediction whose answer has now become knowable, and show the
 * class what happened.
 *
 * Runs when the panel opens rather than on a timer: the natural moment to find
 * out whether Monday's guess was right is the start of the next class, which
 * is exactly when a teacher opens this.
 */
async function cmResolvePendingPredictions(room) {
    const box = document.getElementById(`classroom-pending-${room.id}`);
    if (!box) return;

    const { data, error } = await sbRpc('classroom_pending_predictions',
        { p_classroom_id: room.id }, true);
    if (error || !Array.isArray(data) || !data.length) { box.innerHTML = ''; return; }

    const now = Date.now();
    const lines = [];

    for (const p of data) {
        const ready = p.resolve_after && new Date(p.resolve_after).getTime() <= now;
        if (!ready) {
            lines.push(`<div class="classroom-pending-row">⏳ Waiting to check: `
                     + `${esc(p.prompt)}</div>`);
            continue;
        }

        const chk = p.pending_check || {};
        let actual = null, correctIndex = null;

        if (chk.kind === 'visits_on_day') {
            const start = cmDayStart(chk.day);
            actual = await cmCountDetections(chk.feeder_id, start.toISOString(),
                                             new Date(start.getTime() + 86400000).toISOString());
            if (actual == null) continue;
            const want = actual > chk.baseline ? 'More than today'
                       : actual < chk.baseline ? 'Fewer than today'
                       : 'About the same';
            // The stored labels are the shuffled order the class actually saw,
            // so the index has to come from them, not from a fresh shuffle.
            correctIndex = (chk.labels || []).indexOf(want);
            if (correctIndex < 0) correctIndex = null;
        } else if (chk.kind === 'visits_window') {
            actual = await cmCountDetections(chk.feeder_id, chk.from, chk.to);
            if (actual == null) continue;
            correctIndex = (chk.buckets || []).findIndex(b =>
                actual >= b.lo && (b.hi == null || actual < b.hi));
            if (correctIndex < 0) correctIndex = null;
        } else {
            continue;
        }

        const { error: rerr } = await sbRpc('classroom_resolve_prediction', {
            p_answer_id:     p.id,
            p_actual:        actual,
            p_correct_index: correctIndex,
        }, true);
        if (rerr) continue;

        const choices = Array.isArray(p.choices) ? p.choices : [];
        const guessed = (p.class_index != null && choices[p.class_index])
            ? choices[p.class_index].label : '—';
        const right   = (correctIndex != null && choices[correctIndex])
            ? choices[correctIndex].label : '—';
        const ok = correctIndex != null && correctIndex === p.class_index;

        lines.push(`<div class="classroom-pending-row ${ok ? 'ok' : 'miss'}">`
                 + `${ok ? '✅' : '❌'} ${esc(p.prompt)}<br>`
                 + `<span class="classroom-muted">Class said <strong>${esc(guessed)}</strong> · `
                 + `actual was ${actual} (${esc(right)})</span></div>`);
    }

    box.innerHTML = lines.join('');
}

// ── Session history ──────────────────────────────────────

async function showClassroomHistory(id) {
    const box = document.getElementById('classroom-history');
    if (!box) return;
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading results…</div>';

    const { data, error } = await sbRpc('classroom_session_history',
        { p_classroom_id: id, p_limit: 10 }, true);
    if (error) {
        box.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load results.')}</div>`;
        return;
    }
    const sessions = Array.isArray(data) ? data : [];
    if (!sessions.length) {
        box.innerHTML = '<div class="classroom-muted">No sessions yet.</div>'
                      + '<button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>';
        return;
    }

    box.innerHTML = `<h4 class="classroom-h">Recent classes</h4>` + sessions.map(s => {
        const when = new Date(s.started_at)
            .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const qs = (s.questions || []).map(q => `
            <li class="${q.pending ? 'pending' : (q.is_correct ? 'ok' : 'miss')}">
                ${q.pending ? '⏳' : (q.is_correct ? '✅' : '❌')} ${esc(q.prompt)}
            </li>`).join('');
        return `
        <div class="classroom-history-session">
            <div><strong>${esc(when)}</strong> — ${s.correct_count} of ${s.asked_count} correct</div>
            <ul class="classroom-history-qs">${qs}</ul>
        </div>`;
    }).join('') + '<button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>';
}

function hideClassroomHistory() {
    const box = document.getElementById('classroom-history');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
}

// ── The projector stage (design notes §9A) ───────────────

/**
 * Open a session: load the data, build the questions, put the first one up.
 *
 * The questions are built BEFORE the session row is created. A classroom whose
 * feeder has nothing to say should not leave an empty session in the history
 * every time a teacher tries.
 */
async function startClassroomSession(id, mode) {
    const room = classroomList.find(r => r.id === id);
    if (!room) return;
    mode = mode === 'join_code' ? 'join_code' : 'teacher_led';

    const stage = document.getElementById('classroom-stage');
    if (!stage) return;
    stage.style.display = 'flex';
    stage.innerHTML = '<div class="classroom-stage-loading">Reading the feeder…</div>';

    const data = await loadClassroomData(room);
    const { questions, source } = buildClassroomQuestions(room, data);

    if (!questions.length) {
        stage.innerHTML = `
            <div class="classroom-stage-loading">
                <h2>Not enough data yet</h2>
                <p>${esc(room.home_feeder_name || 'This feeder')} hasn't logged enough visits
                   in the last two weeks to build a lesson from.</p>
                <p class="classroom-muted">Add a partner feeder to the class as a backup,
                   or give the feeder a week to get going.</p>
                <button class="classroom-btn-primary" onclick="closeClassroomStage()">Close</button>
            </div>`;
        return;
    }

    const { data: sess, error } = await sbRpc('classroom_session_start',
        { p_classroom_id: id, p_mode: mode }, true);
    if (error) {
        stage.innerHTML = `
            <div class="classroom-stage-loading">
                <h2>Could not start the class</h2>
                <p>${esc(error.message || 'Unknown error')}</p>
                <button class="classroom-btn-primary" onclick="closeClassroomStage()">Close</button>
            </div>`;
        return;
    }

    classroomSession = {
        id: sess.id, room, source, questions, mode,
        joinCode: sess.join_code || null,
        index: 0, revealed: false, asked: 0, correct: 0,
        // Join-code only: the open question's row id, the live tally, and
        // the poll timers. Null throughout a teacher-led session.
        answerId: null, tally: null, joined: [], pollTimer: null,
    };
    closeClassroomPanel();
    document.addEventListener('keydown', classroomStageKeys);

    if (mode === 'join_code') { startClassroomLobby(); return; }
    renderClassroomStage();
}

function renderClassroomStage() {
    const stage = document.getElementById('classroom-stage');
    const S = classroomSession;
    if (!stage || !S) return;

    const q = S.questions[S.index];
    const band = GRADE_BAND_LABELS[S.room.grade_band] || S.room.grade_band;

    const joinMode = S.mode === 'join_code';

    // Vote counts per choice. Shown live while the room votes (join-code
    // mode) and kept on screen through the reveal, because "17 of you said
    // cardinal" is the part worth talking about.
    const counts = {};
    (S.tally?.votes || []).forEach(v => { counts[v.i] = v.n; });
    const mostVotes = Math.max(1, ...Object.values(counts));

    const choices = q.choices.map((c, i) => {
        let cls = 'classroom-choice';
        if (S.revealed) {
            if (q.correct_index != null && i === q.correct_index) cls += ' correct';
            if (i === q.class_index && i !== q.correct_index)     cls += ' chosen-wrong';
            if (i === q.class_index && i === q.correct_index)     cls += ' chosen';
            if (q.correct_index == null && i === q.class_index)   cls += ' chosen';
        }

        // The bar is drawn behind the label rather than beside it. A
        // separate chart would mean the room reading a question on one
        // part of the screen and its result on another; this way the
        // option fills up where it already is.
        const n = counts[i] || 0;
        const bar = joinMode
            ? `<span class="classroom-bar" style="width:${Math.round((n / mostVotes) * 100)}%"></span>`
            : '';
        const tally = joinMode ? `<span class="classroom-votes">${n}</span>` : '';

        // While the room is voting the teacher must not be able to answer
        // for them; once voting closes the same buttons become the tie
        // break, so they come back enabled with a different handler.
        const needsPick = joinMode && S.awaitingPick;
        const handler = needsPick ? `resolveClassroomTie(${i})`
                      : joinMode  ? ''
                      : `answerClassroomQuestion(${i})`;
        const dis = (S.revealed && !needsPick) || (joinMode && !needsPick);

        return `<button class="${cls}${needsPick ? ' pickable' : ''}" ${dis ? 'disabled' : ''}
                        ${handler ? `onclick="${handler}"` : ''}>
                    ${bar}
                    <span class="classroom-choice-key">${String.fromCharCode(65 + i)}</span>
                    <span class="classroom-choice-label">${esc(c.label)}</span>
                    ${tally}
                </button>`;
    }).join('');

    const reveal = !S.revealed ? '' : `
        <div class="classroom-reveal">
            ${q.correct_index == null
                ? '<div class="classroom-reveal-head pending">📌 Answer recorded — we check this next class</div>'
                : (q.class_index === q.correct_index
                    ? '<div class="classroom-reveal-head ok">✅ The class got it</div>'
                    : '<div class="classroom-reveal-head miss">❌ Not quite</div>')}
            <div class="classroom-reveal-body">${esc(q.explain || '')}</div>
            ${q.fact ? `<div class="classroom-fact">💡 ${esc(q.fact)}</div>` : ''}
        </div>`;

    const last = S.index === S.questions.length - 1;

    stage.innerHTML = `
        <div class="classroom-stage-bar">
            <div>
                <strong>${esc(S.room.name)}</strong>
                <span class="classroom-pill">${esc(band)}</span>
                ${q.from_partner
                    ? `<span class="classroom-pill partner">Partner feeder: ${esc(q.source_feeder_name)}</span>`
                    : `<span class="classroom-pill">${esc(q.source_feeder_name)}</span>`}
            </div>
            <div class="classroom-stage-bar-right">
                ${joinMode ? `<span class="classroom-code-sm">Code ${esc(S.joinCode || '—')}</span>
                              <span class="classroom-muted">${S.tally?.voted ?? 0} of ${S.tally?.joined ?? S.joined.length} voted</span>` : ''}
                <span>Question ${S.index + 1} of ${S.questions.length}</span>
                <span class="classroom-score">${S.correct} / ${S.asked}</span>
                <button class="classroom-btn" onclick="endClassroomSession()">Finish class</button>
            </div>
        </div>

        <div class="classroom-stage-body">
            ${q.image ? classroomShotHtml(q, S.revealed)
                      : classroomChartHtml(q.chart, S.revealed)}
            <h1 class="classroom-prompt">${esc(q.prompt)}</h1>
            <div class="classroom-choices ${q.choices.length > 3 ? 'four' : ''}">${choices}</div>
            ${reveal}
        </div>

        <div class="classroom-stage-foot">
            ${classroomFootControls(S, last, joinMode)}
            <button class="classroom-btn" onclick="skipClassroomQuestion()">Skip</button>
        </div>`;
}

/**
 * The one control the teacher is meant to press next.
 *
 * Teacher-led and join-code diverge only here and in where the answer comes
 * from — everything above this point is the same screen in both modes, which
 * is what the design notes ask for.
 */
function classroomFootControls(S, last, joinMode) {
    if (S.revealed) {
        return last
            ? '<button class="classroom-btn-primary big" onclick="endClassroomSession()">See the results</button>'
            : '<button class="classroom-btn-primary big" onclick="nextClassroomQuestion()">Next question →</button>';
    }
    if (!joinMode) {
        return '<span class="classroom-muted">Poll the room, then tap the class’s answer.</span>';
    }
    if (S.awaitingPick) {
        return '<span class="classroom-muted">'
             + (S.tally?.voted ? 'The room is split — tap the answer to go with.'
                               : 'Nobody voted — tap an answer, or skip.')
             + '</span>';
    }
    return '<button class="classroom-btn-primary big" onclick="closeClassroomVoting()">'
         + 'Close voting &amp; reveal</button>'
         + '<span class="classroom-muted">Devices are showing the buttons now.</span>';
}

/**
 * The snapshot, cropped while it is the question and whole once it is the
 * answer.
 *
 * The crop only applies to identification questions: those are the ones whose
 * answer is written on the photo. A counting question that happens to show a
 * picture loses nothing by keeping its caption, and cropping every photo would
 * quietly throw away the time and temperature the older grades are supposed to
 * be reading off it.
 */
function classroomShotHtml(q, revealed) {
    const hideCaption = q.category === 'identification' && !revealed;
    return `<div class="classroom-shot"${hideCaption ? ' data-crop="caption"' : ''}>`
         + `<img src="${esc(q.image.url)}" alt=""`
         + (hideCaption ? ' onload="classroomFitShot(this)"' : '') + '>'
         + '</div>';
}

/**
 * The teacher taps what the room voted for.
 *
 * Recorded immediately rather than batched at the end: a class period gets
 * interrupted, the laptop lid gets shut, and a session whose answers only
 * persist when it is formally finished loses the lesson that actually
 * happened.
 */
async function answerClassroomQuestion(i) {
    const S = classroomSession;
    if (!S || S.revealed) return;
    const q = S.questions[S.index];

    q.class_index = i;
    S.revealed = true;
    S.asked++;
    if (q.correct_index != null && i === q.correct_index) S.correct++;
    renderClassroomStage();

    const { error } = await sbRpc('classroom_session_record', {
        p_session_id: S.id,
        p_question: {
            template_id:      q.template_id,
            category:         q.category,
            grade_band:       q.grade_band,
            scope:            q.scope,
            prompt:           q.prompt,
            choices:          q.choices,
            correct_index:    q.correct_index,
            class_index:      i,
            source_feeder_id: q.source_feeder_id,
            detection_id:     q.detection_id || null,
            pending_check:    q.pending_check || null,
            resolve_after:    q.resolve_after || null,
        },
    }, true);
    // Don't tear the projector screen down over a failed write — the class is
    // mid-question. Say so quietly and carry on.
    if (error) showToast('Answer not saved: ' + (error.message || 'network error'));
}

function nextClassroomQuestion() {
    const S = classroomSession;
    if (!S) return;
    if (S.index < S.questions.length - 1) {
        S.index++;
        S.revealed = false;
        S.awaitingPick = false;
        S.tally = null;
        renderClassroomStage();
        if (S.mode === 'join_code') openClassroomQuestion();
    }
}

function skipClassroomQuestion() {
    const S = classroomSession;
    if (!S) return;
    // A skipped question in join-code mode has usually already been pushed to
    // thirty devices. Close it server-side on the way past, or the room sits
    // looking at buttons for a question that has left the board.
    if (S.mode === 'join_code' && S.answerId && !S.revealed) {
        const id = S.answerId;
        S.answerId = null;
        stopClassroomTallyPoll();
        sbRpc('classroom_question_close', { p_answer_id: id, p_class_index: null }, true);
    }
    if (S.index >= S.questions.length - 1) { endClassroomSession(); return; }
    S.index++;
    S.revealed = false;
    S.awaitingPick = false;
    S.tally = null;
    renderClassroomStage();
    if (S.mode === 'join_code') openClassroomQuestion();
}

// Keyboard: a projector laptop is usually driven from the keyboard, often from
// across the room with a presenter remote that sends arrows and digits.
function classroomStageKeys(e) {
    const S = classroomSession;
    if (!S) return;
    if (e.key === 'Escape') { endClassroomSession(); return; }
    if (!S.revealed && /^[1-9]$/.test(e.key)) {
        const i = parseInt(e.key, 10) - 1;
        if (i >= S.questions[S.index].choices.length) return;
        // In join-code mode the room answers, not the teacher — a digit only
        // means something once voting has closed on a split or empty vote.
        if (S.mode === 'join_code') {
            if (S.awaitingPick) resolveClassroomTie(i);
        } else {
            answerClassroomQuestion(i);
        }
        return;
    }
    if (S.mode === 'join_code' && !S.revealed && !S.awaitingPick
        && (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        closeClassroomVoting();
        return;
    }
    if (S.revealed && (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        if (S.index === S.questions.length - 1) endClassroomSession();
        else nextClassroomQuestion();
    }
}

async function endClassroomSession() {
    const S = classroomSession;
    if (!S) return;
    stopClassroomTallyPoll();
    const joinMode = S.mode === 'join_code';
    const { data: ended } = await sbRpc('classroom_session_end', { p_session_id: S.id }, true);

    const stage = document.getElementById('classroom-stage');
    const pending = S.questions.filter(q => q.pending_check && q.class_index != null).length;
    const purged = ended && ended.purged_participants;
    if (stage) {
        stage.innerHTML = `
            <div class="classroom-stage-loading">
                <h1>${S.correct} out of ${S.asked}</h1>
                <p>${esc(S.room.name)} — nice work.</p>
                ${pending ? `<p class="classroom-muted">${pending} prediction${pending === 1 ? '' : 's'}
                   waiting to be checked. Open the class again after the data comes in
                   and the site will score ${pending === 1 ? 'it' : 'them'} automatically.</p>` : ''}
                ${joinMode ? `<p class="classroom-muted">The code has stopped working, and
                   ${purged === 1 ? 'the one nickname and its device token have'
                                  : `${purged ? 'all ' + purged : 'every'} nickname${purged === 1 ? '' : 's'} and their device tokens have`}
                   been deleted. The questions and how the room voted are kept.</p>` : ''}
                <button class="classroom-btn-primary" onclick="closeClassroomStage()">Done</button>
            </div>`;
    }
    classroomSession = null;
    document.removeEventListener('keydown', classroomStageKeys);
}

function closeClassroomStage() {
    const stage = document.getElementById('classroom-stage');
    if (stage) { stage.style.display = 'none'; stage.innerHTML = ''; }
    stopClassroomTallyPoll();
    classroomSession = null;
    document.removeEventListener('keydown', classroomStageKeys);
    openClassroomPanel();
}

// ── Join-code mode (design notes §9B) ────────────────────
//
// The question screen above is shared with teacher-led mode. What differs is
// only where the class's answer comes from: there, the teacher taps it; here,
// the room votes on its own devices and the plurality becomes the answer.
//
// Three things never leave this machine: the correct answer, the photo, and
// anything identifying a child. classroom_poll returns the prompt and the
// choices and nothing else, and the device is told to look at the board when a
// question has a picture (design notes §15 — student devices get text and
// buttons only, so thirty phones don't each pull a snapshot over school wifi).

const CLASSROOM_POLL_MS = 1500;

/**
 * The lobby: the code goes up, the class types it in, nicknames appear.
 *
 * Deliberately a screen of its own rather than a banner over question one.
 * Getting thirty children onto a join page takes a few minutes and a couple of
 * retypes, and a teacher needs to see that everyone is in BEFORE the first
 * question goes up — once it does, anyone still typing has already missed it.
 */
function startClassroomLobby() {
    const S = classroomSession;
    if (!S) return;
    renderClassroomLobby();
    startClassroomLobbyPoll();
}

function classroomJoinUrl() {
    // Derived from the current page, so this works on the live site, on a
    // staging copy and on localhost without a build-time constant.
    const base = location.pathname.replace(/[^/]*$/, '');

    // GitHub Pages serves this repository from its root, so the published
    // site sits under /docs/ and this page is /docs/community.html. Sending a
    // class to "birdwatchai.com/docs/join.html" is asking for six-year-olds
    // to mistype it; /join/index.html redirects there for exactly this
    // reason, so show the short form whenever we are on that layout.
    if (/\/docs\/$/.test(base)) {
        return location.origin + base.replace(/docs\/$/, '') + 'join';
    }

    return location.origin + base + 'join.html';
}

function renderClassroomLobby() {
    const stage = document.getElementById('classroom-stage');
    const S = classroomSession;
    if (!stage || !S) return;

    const joined = S.joined || [];
    const url = classroomJoinUrl().replace(/^https?:\/\//, '');

    stage.innerHTML = `
        <div class="classroom-stage-bar">
            <div>
                <strong>${esc(S.room.name)}</strong>
                <span class="classroom-pill">${esc(GRADE_BAND_LABELS[S.room.grade_band] || S.room.grade_band)}</span>
            </div>
            <div class="classroom-stage-bar-right">
                <span class="classroom-muted">${joined.length} joined</span>
                <button class="classroom-btn" onclick="endClassroomSession()">Finish class</button>
            </div>
        </div>

        <div class="classroom-stage-body">
            <div class="classroom-lobby">
                <p class="classroom-lobby-step">On your device, go to</p>
                <p class="classroom-lobby-url">${esc(url)}</p>
                <p class="classroom-lobby-step">and enter the class code</p>
                <p class="classroom-code">${esc(S.joinCode || '—')}</p>
                <p class="classroom-muted">Pick any nickname. No password, no sign-in,
                   and nothing is kept after the lesson.</p>
            </div>
            <div class="classroom-nicknames">
                ${joined.length
                    ? joined.map(n => `<span class="classroom-nick">${esc(n)}</span>`).join('')
                    : '<span class="classroom-muted">Waiting for the first person to join…</span>'}
            </div>
        </div>

        <div class="classroom-stage-foot">
            <button class="classroom-btn-primary big" onclick="beginClassroomQuestions()"
                    ${joined.length ? '' : 'disabled title="Nobody has joined yet"'}>
                Start the questions →
            </button>
            <span class="classroom-muted">${S.questions.length} questions ready.</span>
        </div>`;
}

function startClassroomLobbyPoll() {
    stopClassroomTallyPoll();
    const tick = async () => {
        const S = classroomSession;
        if (!S || S.mode !== 'join_code') return;
        const { data, error } = await sbRpc('classroom_participants_list',
            { p_session_id: S.id }, true);
        if (!error && Array.isArray(data)) {
            // Re-render only when the list actually changed. A projector
            // redrawing twice a second is visible from the back of the room.
            const changed = data.length !== S.joined.length;
            S.joined = data;
            if (changed) renderClassroomLobby();
        }
    };
    tick();
    classroomSession.pollTimer = setInterval(tick, CLASSROOM_POLL_MS * 2);
}

function stopClassroomTallyPoll() {
    const S = classroomSession;
    if (S && S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
}

function beginClassroomQuestions() {
    const S = classroomSession;
    if (!S) return;
    stopClassroomTallyPoll();
    renderClassroomStage();
    openClassroomQuestion();
}

/**
 * Publish the current question to the devices and start watching the votes.
 *
 * The answer row is created here rather than at reveal time, because a vote
 * needs something to point at. classroom_question_open stores the correct
 * index server-side; classroom_poll simply never returns it.
 */
async function openClassroomQuestion() {
    const S = classroomSession;
    if (!S) return;
    const q = S.questions[S.index];

    S.answerId = null;
    S.tally = null;

    const { data, error } = await sbRpc('classroom_question_open', {
        p_session_id: S.id,
        p_question: {
            template_id:      q.template_id,
            category:         q.category,
            grade_band:       q.grade_band,
            scope:            q.scope,
            prompt:           q.prompt,
            choices:          q.choices,
            correct_index:    q.correct_index,
            source_feeder_id: q.source_feeder_id,
            detection_id:     q.detection_id || null,
            pending_check:    q.pending_check || null,
            resolve_after:    q.resolve_after || null,
        },
    }, true);

    if (error || !data) {
        showToast('Could not put that question up: ' + ((error && error.message) || 'unknown'));
        return;
    }
    S.answerId = data.id;
    startClassroomTallyPoll();
}

function startClassroomTallyPoll() {
    stopClassroomTallyPoll();
    const tick = async () => {
        const S = classroomSession;
        if (!S || !S.answerId || S.revealed) return;
        const { data, error } = await sbRpc('classroom_tally', { p_answer_id: S.answerId }, true);
        if (error || !data) return;
        // Redraw only when a vote has actually moved. Without this the bars
        // repaint every 1.5s whether or not anything changed, which on a
        // projector reads as a flicker rather than as liveness.
        const before = JSON.stringify((S.tally && S.tally.votes) || []);
        S.tally = data;
        if (JSON.stringify(data.votes || []) !== before) renderClassroomStage();
    };
    tick();
    classroomSession.pollTimer = setInterval(tick, CLASSROOM_POLL_MS);
}

/**
 * Close voting and show the answer.
 *
 * The plurality is worked out here, before the close call, for one reason: a
 * tie has no plurality, and the teacher has to break it out loud. Letting the
 * server decide and then asking it to change its mind would mean a second
 * write undoing the first one's effect on the score.
 */
async function closeClassroomVoting() {
    const S = classroomSession;
    if (!S || !S.answerId || S.revealed) return;
    stopClassroomTallyPoll();

    // One last read, so a vote cast while the teacher was reaching for the
    // button still counts.
    const { data: tally } = await sbRpc('classroom_tally', { p_answer_id: S.answerId }, true);
    if (tally) S.tally = tally;

    const votes = (S.tally && S.tally.votes) || [];
    const top = votes.reduce((a, v) => (!a || v.n > a.n ? v : a), null);
    const tied = top ? votes.filter(v => v.n === top.n).length > 1 : false;

    if (!top || tied) {
        // No votes, or a dead heat. Hand it to the teacher rather than
        // picking for the room.
        S.awaitingPick = true;
        renderClassroomStage();
        return;
    }
    await finishClassroomQuestion(top.i);
}

// The teacher breaks a tie, or answers for a room that did not vote.
async function resolveClassroomTie(i) {
    const S = classroomSession;
    if (!S || !S.awaitingPick) return;
    S.awaitingPick = false;
    await finishClassroomQuestion(i);
}

async function finishClassroomQuestion(classIndex) {
    const S = classroomSession;
    if (!S || !S.answerId) return;
    const q = S.questions[S.index];

    const { data, error } = await sbRpc('classroom_question_close', {
        p_answer_id:   S.answerId,
        p_class_index: classIndex,
    }, true);
    if (error) showToast('Could not close the vote: ' + (error.message || 'network error'));

    q.class_index = (data && data.class_index != null) ? data.class_index : classIndex;
    S.revealed = true;
    S.answerId = null;
    S.asked++;
    if (q.correct_index != null && q.class_index === q.correct_index) S.correct++;
    renderClassroomStage();
}

/**
 * Drop everything on sign-out.
 *
 * Called from clearCommunityState. The stage is a full-screen element rather
 * than a modal, so nothing else on the page would close it — a teacher who
 * signs out mid-class would be left looking at a live question backed by a
 * token that no longer exists.
 */
function clearClassroomState() {
    const stage = document.getElementById('classroom-stage');
    if (stage) { stage.style.display = 'none'; stage.innerHTML = ''; }
    stopClassroomTallyPoll();
    document.removeEventListener('keydown', classroomStageKeys);
    classroomSession     = null;
    classroomList        = [];
    classroomFeederOpts  = [];
    classroomCommunityId = '';
    classroomEditingId   = null;
    closeClassroomPanel();
    updateClassroomNavUI();
}
