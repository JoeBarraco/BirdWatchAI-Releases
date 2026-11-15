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

// Which question types the classroom being edited may ask: a Set of template
// ids, or null for "all of them". Null is not the same as a full Set only in
// what gets SAVED — an untouched classroom sends nothing and keeps whatever
// the server has, which for almost every classroom is no restriction at all.
//
// Deliberately held here rather than read back off the checkboxes: the picker
// only draws the current grade band, so a teacher who curates K-2, switches
// the band to 3-5 and saves would otherwise wipe every pick the first screen
// could not see.
let classroomPicks = null;

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
    // School communities only. A birding group or a family's two feeders has
    // no use for a Classroom button, and the server agrees — the trigger in
    // setup-community-kinds.sql refuses a classroom anywhere else, so showing
    // the button would only lead to an error.
    return myCommunities.filter(c =>
        c.kind === 'school' &&
        (c.role === 'owner' || c.role === 'moderator' || c.role === 'teacher'));
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

    // Suggest rides on the same membership. The request was that the
    // suggestion area "cover both the classroom area as well as the entire
    // community", and the classroom panel is the wrong home for the second
    // half of that — you would have to open a teaching panel to report that
    // something about the community feed is awkward. Same gate as the
    // classroom button because classroom_suggest_question is scoped to a
    // community and wants teacher, moderator or owner.
    const idea = document.getElementById('navbar-idea-btn');
    if (idea) idea.style.display = show ? '' : 'none';

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
 *
 * With &review=1 it goes one step further and opens the review list, which is
 * what the daily feedback email links to. "Open the review panel" has to put
 * the review panel on screen or it is a button that lies — it landed on the
 * community page and left you to find the classroom yourself.
 */
async function followClassroomDeepLink() {
    if (classroomDeepLinkDone) return;
    const params = new URLSearchParams(location.search);
    const wanted = params.get('classroom');
    const alsoReview = params.get('review') === '1';
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
        // After the refresh, so the room is in classroomList by the time the
        // review looks it up.
        if (alsoReview && typeof reviewClassroomQuestions === 'function') {
            await reviewClassroomQuestions(wanted);
        }
        return;
    }

    // Reached only when the link points at a classroom this account cannot
    // see — deleted, or belonging to somebody else. Say so plainly rather
    // than opening an empty panel and letting them wonder.
    showToast('That classroom link is not one this account can open.');
}

function highlightClassroom(id) {
    // Selecting IS the highlight now: the row goes active and the right-hand
    // pane fills with that class. The old version added a .linked class to a
    // card in a flat list, which no longer exists.
    if (typeof selectClassroom === 'function') selectClassroom(id);
    const row = document.querySelector(`.classroom-row[data-room="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

/**
 * The finest value a class can actually read off this chart.
 *
 * ⚠ THIS IS THE THING THAT MADE "HOW MANY?" UNANSWERABLE.
 * Flagged twice in one morning, correctly both times: "the y axis needs
 * more granularity, every 20 visits is not fine enough — the number was
 * 15 and it is really hard to tell that from the chart", and "you can't
 * see where the bar height crosses the y-axis".
 *
 * The cause is not the axis. It is that the chart's scale is set by its
 * BIGGEST bar while the question asks about a small one: a day with 15
 * visits drawn on an axis topping out at 80 sits between two gridlines
 * twenty apart, and no amount of relabelling fixes that. Nor can the
 * gridlines simply be made finer — eighty faint lines across a projected
 * plot is a grey wash, which is what cmMinorStep's own cap is about.
 *
 * So the chart is not the thing to change. The CHOICES are: options a
 * class cannot tell apart on the chart it was given are not a question.
 * This returns the resolution so the options can be spaced to beat it.
 *
 * A dots chart is one mark per visit, so it reads to the unit.
 */
function cmChartResolution(chart) {
    if (!chart || chart.kind === 'dots') return 1;
    const step  = cmNiceStep(chart.max);
    const top   = Math.ceil(chart.max / step) * step;
    const minor = cmMinorStep(top, step);
    return Math.max(1, minor || step);
}

/**
 * Numeric options a class can tell apart on the chart in front of them.
 *
 * Spaced by at least the chart's resolution, so "is that bar 13, 14, 15
 * or 16?" — four options inside one gridline gap — cannot happen. Falls
 * back to the ordinary spread when there is no chart to read.
 */
function cmChartCountChoices(answer, rng, chart, count) {
    const want = count || 3;
    const gap  = cmChartResolution(chart);
    if (gap <= 1) {
        return cmChoices(String(answer),
                         cmNumberDistractors(answer, rng, want).map(String), rng);
    }

    // Whole multiples of the gap on either side, nearest first, so the
    // options stay in the same part of the chart as the answer rather than
    // wandering off to numbers no bar is near.
    const out = [];
    for (let k = 1; out.length < want && k <= want + 2; k++) {
        for (const sign of cmShuffle([1, -1], rng)) {
            const v = answer + sign * gap * k;
            if (v >= 0 && v !== answer && !out.includes(v)) out.push(v);
            if (out.length >= want) break;
        }
    }
    if (out.length < want) return null;
    return cmChoices(String(answer), out.slice(0, want).map(String), rng);
}

/**
 * A bird seen head-on, with its line of symmetry, as a data: URI.
 *
 * Deliberately plain and deliberately NOT a photograph — see the note in
 * the art-symmetry template. Drawn with currentColor-free literal values
 * because a data: URI has no stylesheet; the palette is picked to read on
 * both the light and dark slide backgrounds.
 */
function cmSymmetryDiagram() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 260">
  <rect width="320" height="260" fill="#f4f1ea"/>
  <!-- body -->
  <ellipse cx="160" cy="165" rx="56" ry="68" fill="#8a9ab0"/>
  <!-- wings, one each side -->
  <ellipse cx="104" cy="160" rx="22" ry="52" fill="#6f8099"/>
  <ellipse cx="216" cy="160" rx="22" ry="52" fill="#6f8099"/>
  <!-- head -->
  <circle cx="160" cy="80" r="42" fill="#9aa9bd"/>
  <!-- eyes -->
  <circle cx="142" cy="74" r="7" fill="#243043"/>
  <circle cx="178" cy="74" r="7" fill="#243043"/>
  <!-- beak -->
  <path d="M160 88 L150 104 L170 104 Z" fill="#e0a23c"/>
  <!-- feet -->
  <path d="M146 232 v16 M146 248 l-9 8 M146 248 l9 8" stroke="#e0a23c"
        stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M174 232 v16 M174 248 l-9 8 M174 248 l9 8" stroke="#e0a23c"
        stroke-width="5" fill="none" stroke-linecap="round"/>
  <!-- the line itself -->
  <line x1="160" y1="18" x2="160" y2="252" stroke="#c0392b" stroke-width="3"
        stroke-dasharray="10 8"/>
</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/\s+/g, ' '));
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
        'k-2':  'The titmouse has a little gray hat called a crest that it can raise up.',
        'up':   'Titmice often grab one seed, carry it to a branch, and hammer it open while holding it with their feet.',
    },
    'Carolina Wren': {
        'k-2':  'Wrens are small and brown, and they sing very loudly for their size.',
        'up':   'A Carolina Wren pair stays together year-round, and the male sings a "teakettle-teakettle" song all seasons.',
    },
    'House Finch': {
        'k-2':  'Boy house finches have red on their heads and chests.',
        'up':   'The red on a male House Finch comes from pigments in the food he eats, so his color reports how well he has fed.',
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
        'k-2':  'Juncos are gray on top and white underneath, like a little snowball.',
        'up':   'Juncos are often called "snowbirds" because in much of the country they only show up for the winter.',
    },
    'Northern Mockingbird': {
        'k-2':  'Mockingbirds copy the songs of other birds.',
        'up':   'A male Northern Mockingbird can learn 200 songs in a lifetime and sings them in bursts of three or more repeats.',
    },
};

// ── What each bird looks like (design notes §2, the K–2 line) ──────
//
// "Color/shape matching to identify birds" is the first thing the notes ask
// for at K–2, and it is the one thing the detection data cannot supply: the
// model reports a species and a time, never a color. So this is a small
// hand-written table about the birds themselves.
//
// `color` is the ONE color a five-year-old would say if asked, not an
// ornithologically complete description — a Blue Jay is blue even though it
// is also white, black and gray. Questions below only ever ask about a color
// exactly one of the offered birds has, so "which is blue?" never has two
// defensible answers.
//
// `female` is set where the sexes differ enough that a class will notice and
// ask, which is most of the feeder regulars and a good discussion either way.
//
// Only species the feeders actually see, matching SPECIES_FACTS. A bird with
// no entry here simply never appears in a color question.
const SPECIES_LOOKS = {
    'Northern Cardinal':      { color: 'red',             female: 'soft brown with a little red', feature: 'a pointy crest on its head' },
    'Carolina Chickadee':     { color: 'black and white', feature: 'a black cap and a black bib' },
    'Black-capped Chickadee': { color: 'black and white', feature: 'a black cap and a black bib' },
    'Tufted Titmouse':        { color: 'gray',            feature: 'a little gray crest' },
    'Carolina Wren':          { color: 'brown',           feature: 'a white stripe over its eye and a tail that points up' },
    'House Finch':            { color: 'red',             female: 'streaky brown', feature: 'a red head and chest' },
    'American Goldfinch':     { color: 'yellow',          feature: 'black wings with white bars' },
    'Blue Jay':               { color: 'blue',            feature: 'a blue crest and a black necklace' },
    'Mourning Dove':          { color: 'gray',            feature: 'a long pointed tail' },
    'Downy Woodpecker':       { color: 'black and white', female: 'the same, but with no red patch', feature: 'a chisel beak for tapping wood' },
    'Red-bellied Woodpecker': { color: 'black and white', feature: 'a red cap and zebra stripes on its back' },
    'White-breasted Nuthatch':{ color: 'gray',            feature: 'walking DOWN the tree head first' },
    'House Sparrow':          { color: 'brown',           feature: 'a gray cap and a black bib' },
    'European Starling':      { color: 'black',           feature: 'shiny feathers with little white spots' },
    'American Robin':         { color: 'orange',          feature: 'an orange tummy' },
    'Dark-eyed Junco':        { color: 'gray',            feature: 'gray on top and white underneath' },
    'Northern Mockingbird':   { color: 'gray',            feature: 'white flashes in its wings when it flies' },
};

function speciesLook(species) {
    return SPECIES_LOOKS[species] || null;
}

// ── Bird words ───────────────────────────────────────────────────
//
// "All the questions can be bird themed, but don't need to come directly from
// feeder data." These need none of it, which is also what makes them the
// cheapest way to keep a daily class from meeting the same question twice:
// they work in a week when the feeder logged nothing at all.

// Collective nouns. English has an absurd number of these for birds
// specifically, most of them from 15th-century hunting manuals, and they are
// the kind of fact a nine-year-old repeats at dinner.
const BIRD_COLLECTIVES = [
    { group: 'crows',     noun: 'a murder',       others: ['a parliament', 'a gaggle', 'a charm'] },
    { group: 'owls',      noun: 'a parliament',   others: ['a murder', 'a murmuration', 'a covey'] },
    { group: 'starlings', noun: 'a murmuration',  others: ['a parliament', 'a raft', 'a charm'] },
    { group: 'geese on the ground', noun: 'a gaggle', others: ['a skein', 'a murder', 'a parliament'] },
    { group: 'geese in flight',     noun: 'a skein',  others: ['a gaggle', 'a charm', 'a covey'] },
    { group: 'finches',   noun: 'a charm',        others: ['a murder', 'a gaggle', 'a parliament'] },
    { group: 'ducks on water',      noun: 'a raft',   others: ['a skein', 'a murder', 'a charm'] },
    { group: 'quail',     noun: 'a covey',        others: ['a murder', 'a murmuration', 'a raft'] },
];

// Birds whose song has a well-known English mnemonic. Teachers use these to
// teach birding by ear, and they are genuinely how most people learn these
// songs.
const BIRD_SOUNDS = [
    { bird: 'Barred Owl',            says: 'Who cooks for you? Who cooks for you all?' },
    { bird: 'Carolina Chickadee',    says: 'chick-a-dee-dee-dee - its own name' },
    { bird: 'Eastern Towhee',        says: 'Drink your teeeea!' },
    { bird: 'White-throated Sparrow',says: 'Old Sam Peabody, Peabody, Peabody' },
    { bird: 'Killdeer',              says: 'kill-deer! - its own name' },
    { bird: 'Mourning Dove',         says: 'a sad, low coo-OO-oo-oo-oo' },
];

// ── Bird wonders ─────────────────────────────────────────────────
//
// Everything else here asks the class about data the computer already has.
// That is the whole reason the question set reads as a worksheet: the answer
// exists before the question is asked, nobody in the room knows anything the
// screen does not, and the bird is decoration on top of some arithmetic.
//
// These are the opposite. Tell the class something genuinely startling about
// a bird, hold back the most startling number in it, and ask them that. The
// bird is the subject, the hook is curiosity rather than assessment, and it
// does not matter whether that species has ever been near the feeder - a
// first-grader who has just learned that a penguin can hold its breath for
// twenty minutes is engaged in a way no bar chart achieves.
//
// Deliberately across subjects, because the request was for a question set
// that is not all maths: migration is geography, mimicry is language,
// messenger pigeons are history, and the numbers carry the maths anyway.
//
// ── ACCURACY ────────────────────────────────────────────────────
// Every other question here is true by construction: it is computed from the
// feeder's own detections, so it cannot be wrong about the world. These are
// the exception. They are curated claims, stated to children as fact, and
// they are only as good as the person who wrote them. Figures are given as
// the round numbers they are usually quoted at, and where a real record is
// held by a specific individual bird it says so rather than implying every
// bird of that species can do it. They want a once-over by someone who knows
// the subject; the flag button on every question is the route for fixing one.
const BIRD_WONDERS = [
    {
        id: 'wonder-budgie-words', subject: 'language', bands: ['3-5', '6-8'],
        bird: 'Budgerigar',
        intro: ['Some birds can copy human speech. Parrots are famous for it, but '
              + 'the record for the biggest vocabulary of any bird belongs to a '
              + 'budgie - the little blue and green pet-shop bird.',
                'A budgerigar called Puck was recorded knowing more words than any '
                + 'other bird ever tested.'],
        prompt: 'About how many words did Puck the budgie know?',
        answer: '1,700', distractors: ['17', '170', '17,000'],
        reveal: 'About 1,700. For comparison, a four-year-old child uses '
              + 'somewhere around 1,500 words.',
    },
    {
        id: 'wonder-arctic-tern', subject: 'geography', bands: ['3-5', '6-8'],
        bird: 'Arctic Tern',
        intro: ['The Arctic Tern spends its summer in the Arctic, then flies all '
              + 'the way to the Antarctic for the other summer, and back again '
              + 'every single year.',
                'It is the longest migration of any animal on Earth.'],
        prompt: 'Roughly how far does an Arctic Tern fly in one year?',
        answer: 'About 44,000 miles',
        distractors: ['About 440 miles', 'About 4,400 miles', 'About 440,000 miles'],
        reveal: 'About 44,000 miles a year. All the way around the Earth is about '
              + '25,000, so it laps the planet nearly twice. Over a whole life that '
              + 'is roughly three round trips to the Moon.',
    },
    {
        id: 'wonder-peregrine', subject: 'science', bands: ['k-2', '3-5', '6-8'],
        bird: 'Peregrine Falcon',
        intro: ['The fastest animal on the planet is not a cheetah. It is a bird.',
                'A Peregrine Falcon hunts by climbing high above its prey and then '
              + 'folding its wings and dropping.'],
        prompt: 'How fast can a Peregrine Falcon go in that dive?',
        answer: 'Over 200 mph',
        distractors: ['About 20 mph - a fast bicycle', 'About 50 mph - a car on the highway',
                      'About 100 mph - a fastball times two'],
        reveal: 'Over 200 mph. A car on the highway does about 70. It has baffles '
              + 'in its nostrils so the rushing air does not damage its lungs on '
              + 'the way down.',
    },
    {
        id: 'wonder-bee-hummingbird', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'Bee Hummingbird',
        intro: ['The smallest bird in the world lives in Cuba and is called the '
              + 'Bee Hummingbird, because people really do mistake it for a bee.',
                'It builds a nest about the size of a walnut shell.'],
        prompt: 'How long is a Bee Hummingbird from beak to tail?',
        answer: 'About 2 inches',
        distractors: ['About half an inch', 'About 6 inches - a pencil',
                      'About 12 inches - a ruler'],
        reveal: 'About 2 inches, shorter than your thumb, and it weighs less than '
              + 'a penny.',
    },
    {
        id: 'wonder-emperor-penguin', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Emperor Penguin',
        intro: ['Emperor Penguins hunt by diving under the Antarctic ice, in water '
              + 'cold enough to kill a person in minutes.',
                'They cannot breathe down there, so everything depends on how long '
              + 'they can hold their breath.'],
        prompt: 'How long can an Emperor Penguin stay underwater?',
        answer: 'Over 20 minutes', distractors: ['About 30 seconds', 'About 2 minutes', 'About 5 minutes'],
        reveal: 'Over 20 minutes, and more than 1,500 feet down - deeper than the '
              + 'Empire State Building is tall. Most people manage about a minute.',
    },
    {
        id: 'wonder-swift-airborne', subject: 'science', bands: ['6-8'],
        bird: 'Common Swift',
        intro: ['Common Swifts eat, drink and even sleep while flying. A young swift '
              + 'leaves the nest and may not touch the ground again for years.',
                'Scientists attached tiny loggers to them to find out how long they '
              + 'stay in the air without landing at all.'],
        prompt: 'How long can a Common Swift stay airborne without landing?',
        answer: 'About 10 months', distractors: ['About 10 hours', 'About 10 days', 'About 10 weeks'],
        reveal: 'About 10 months of continuous flight. They sleep by shutting down '
              + 'half the brain at a time while gliding.',
    },
    {
        id: 'wonder-woodpecker-tongue', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Woodpecker',
        intro: ['A woodpecker hammers its beak into solid wood about twenty times a '
              + 'second and does not get a headache.',
                'Part of the reason is its tongue, which is far longer than its head '
              + 'and has to be stored somewhere.'],
        prompt: 'Where does a woodpecker keep its tongue when it is not using it?',
        answer: 'Wrapped around its skull',
        distractors: ['Curled up in its beak', 'Folded into its throat', 'Coiled in its chest'],
        reveal: 'It wraps backwards around the skull, under the skin and over the '
              + 'top of the brain - which also helps cushion all that hammering.',
    },
    {
        id: 'wonder-chickadee-memory', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Carolina Chickadee',
        intro: ['Chickadees hide seeds all over their territory to get through the '
              + 'winter - one seed per hiding place, thousands of places.',
                'Then they have to remember where they all are. In autumn the part '
              + 'of their brain that handles memory actually grows.'],
        prompt: 'About how many hiding places can a chickadee remember?',
        answer: 'Thousands', distractors: ['About five', 'About twenty', 'About a hundred'],
        reveal: 'Thousands, for months at a time. One of these may well be at our '
              + 'feeder right now.',
    },
    {
        id: 'wonder-albatross-wings', subject: 'geography', bands: ['3-5', '6-8'],
        bird: 'Wandering Albatross',
        intro: ['The Wandering Albatross has the longest wings of any living bird '
              + 'and spends most of its life over the open Southern Ocean.',
                'It barely flaps. It locks its wings open and rides the wind, and can '
              + 'travel for hours without a single wingbeat.'],
        prompt: 'How wide are a Wandering Albatross’s wings, tip to tip?',
        answer: 'About 11 feet',
        distractors: ['About 3 feet - a yardstick', 'About 6 feet - a tall adult',
                      'About 20 feet - a school bus'],
        reveal: 'About 11 feet, tip to tip. Lie two grown-ups end to end and you are '
              + 'close. It can glide for hours without flapping once.',
    },
    {
        id: 'wonder-pigeon-post', subject: 'history', bands: ['3-5', '6-8'],
        bird: 'Homing Pigeon',
        intro: ['Long before radio, armies sent messages by pigeon. A pigeon taken '
              + 'hundreds of miles from home in a basket will still find its way back.',
                'In the First World War a pigeon called Cher Ami delivered a message '
              + 'that saved nearly two hundred trapped soldiers, after being shot.'],
        prompt: 'How does a homing pigeon find its way home?',
        answer: 'It senses the Earth’s magnetic field',
        distractors: ['It follows roads', 'It follows other pigeons', 'It is taught the route as a chick'],
        reveal: 'It senses the Earth’s magnetic field, and uses the sun and '
              + 'landmarks too. Nobody has fully worked out how it all fits together.',
    },
    {
        id: 'wonder-crow-tools', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'New Caledonian Crow',
        intro: ['Crows are among the few animals that make tools, not just use them.',
                'A New Caledonian Crow will take a straight twig and work on it until '
              + 'it is the right shape to pull a grub out of a hole.'],
        prompt: 'What does the crow do to the twig to make it work better?',
        answer: 'Bends a hook into the end',
        distractors: ['Sharpens it on a stone', 'Splits it down the middle', 'Soaks it in water'],
        reveal: 'It bends a hook into the end. Crows also remember human faces for '
              + 'years, and tell other crows about the ones they did not like.',
    },
    {
        id: 'wonder-owl-ears', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Barn Owl',
        intro: ['A Barn Owl can catch a mouse in total darkness, under snow, using '
              + 'nothing but sound.',
                'It can do it because of something odd about the way its head is '
              + 'built.'],
        prompt: 'What is unusual about a Barn Owl’s ears?',
        answer: 'One is higher than the other',
        distractors: ['They point backwards', 'It has four of them', 'They are inside its beak'],
        reveal: 'One ear sits higher than the other, so a sound reaches them at '
              + 'slightly different times and the owl can work out the height as well '
              + 'as the direction.',
    },
    {
        id: 'wonder-bar-headed-goose', subject: 'geography', bands: ['6-8'],
        bird: 'Bar-headed Goose',
        intro: ['Bar-headed Geese migrate straight over the Himalayas rather than '
              + 'going around them.',
                'The air up there holds so little oxygen that a person would pass out '
              + 'without a tank.'],
        prompt: 'How high have Bar-headed Geese been recorded flying?',
        answer: 'Over 23,000 feet',
        distractors: ['About 500 feet - a tall building', 'About 2,000 feet',
                      'About 100,000 feet'],
        reveal: 'Over 23,000 feet, near the top of Everest and not far below a '
              + 'cruising airliner. Their blood takes up oxygen far more readily '
              + 'than ours does.',
    },
    {
        id: 'wonder-cardinal-female-sings', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'Northern Cardinal',
        intro: ['In most songbirds only the male sings. The Northern Cardinal is one '
              + 'of the exceptions.',
                'A female cardinal sings too, often from the nest, and she and her '
              + 'mate answer each other back and forth.'],
        prompt: 'Why do people think the female cardinal sings from the nest?',
        answer: 'To tell her mate when to bring food',
        distractors: ['To frighten away cats', 'To keep her eggs warm', 'To call the chicks out'],
        reveal: 'The leading idea is that she is telling him when to bring food. '
              + 'Pairs sing matching phrases to each other.',
    },
    {
        id: 'wonder-hummingbird-heart', subject: 'maths', bands: ['3-5', '6-8'],
        bird: 'Ruby-throated Hummingbird',
        intro: ['A hummingbird beats its wings so fast you cannot see them, and its '
              + 'heart has to keep up.',
                'Your own heart beats about 90 times a minute while you are sitting '
              + 'still.'],
        prompt: 'About how fast does a hummingbird’s heart beat when it is flying?',
        answer: 'About 1,200 a minute', distractors: ['About 120 a minute', 'About 400 a minute', 'About 12,000 a minute'],
        reveal: 'About 1,200 beats a minute - roughly twenty every second. At night '
              + 'it drops into a deep cold sleep to save energy.',
    },
{
        id: 'wonder-bowerbird', subject: 'art', bands: ['3-5', '6-8'],
        bird: 'Satin Bowerbird',
        intro: ['A male Satin Bowerbird builds a little avenue of twigs on the '
              + 'forest floor and then decorates it, for weeks, to impress a female.',
                'He is extremely fussy about his decorations, and he sorts them.'],
        prompt: 'What does a Satin Bowerbird collect to decorate with?',
        answer: 'Blue things, and only blue',
        distractors: ['Anything shiny', 'Red flowers only', 'Smooth white pebbles'],
        reveal: 'Blue - bottle caps, pegs, feathers, drinking straws. He will steal '
              + 'blue things from a rival’s bower, and he arranges them by size.',
    },
    {
        id: 'wonder-lyrebird', subject: 'language', bands: ['3-5', '6-8'],
        bird: 'Superb Lyrebird',
        intro: ['The Superb Lyrebird of Australia is the best mimic alive. It copies '
              + 'every other bird in the forest, note for note.',
                'It does not stop at birds. It copies whatever else it hears often '
              + 'enough.'],
        prompt: 'What else have wild lyrebirds been recorded imitating?',
        answer: 'Chainsaws and camera shutters',
        distractors: ['Thunder and rain', 'Dogs barking only', 'Nothing but other birds'],
        reveal: 'Chainsaws, car alarms and camera shutters, learned from loggers and '
              + 'tourists. A mimicked sound can pass from bird to bird for years.',
    },
    {
        id: 'wonder-owl-neck', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'Great Horned Owl',
        intro: ['An owl cannot move its eyes. They are fixed in its skull like two '
              + 'telescopes, so to look sideways it must turn its whole head.',
                'It is very good at turning its head.'],
        prompt: 'How far around can an owl turn its head?',
        answer: 'About three quarters of a circle',
        distractors: ['About a quarter of a circle', 'Halfway round', 'All the way round'],
        reveal: 'About 270 degrees - three quarters of the way round. NOT all the way. '
              + 'It has 14 bones in its neck; you have 7.',
    },
    {
        id: 'wonder-mockingbird-songs', subject: 'language', bands: ['3-5', '6-8'],
        bird: 'Northern Mockingbird',
        intro: ['A mockingbird does not really have a song of its own. It borrows '
              + 'everybody else’s and strings them together.',
                'It keeps learning new ones its whole life.'],
        prompt: 'About how many different songs can one mockingbird learn?',
        answer: 'Around 200', distractors: ['Around 5', 'Around 20', 'Around 2,000'],
        reveal: 'Around 200, and it keeps adding. A male short of a mate will sing '
              + 'through the night.',
    },
    {
        id: 'wonder-kiwi-egg', subject: 'maths', bands: ['3-5', '6-8'],
        bird: 'Kiwi',
        intro: ['The kiwi of New Zealand is about the size of a chicken, cannot fly, '
              + 'and has feathers like shaggy hair.',
                'It lays what is, for its size, the most enormous egg of any bird.'],
        prompt: 'The kiwi’s egg weighs about how much of the mother’s own weight?',
        answer: 'About one fifth', distractors: ['About one hundredth', 'About one fiftieth', 'About half'],
        reveal: 'About a fifth of her body weight. For a grown adult that would be '
              + 'like carrying a 30-pound egg.',
    },
    {
        id: 'wonder-eagle-nest', subject: 'maths', bands: ['3-5', '6-8'],
        bird: 'Bald Eagle',
        intro: ['Bald Eagles use the same nest year after year, adding sticks to it '
              + 'every season.',
                'After enough years the nest gets genuinely dangerous to stand under.'],
        prompt: 'The biggest eagle nest ever recorded weighed about how much?',
        answer: 'About 2 tons', distractors: ['About 20 pounds', 'About 200 pounds', 'About 20 tons'],
        reveal: 'Nearly 2 tons, and about 9 feet across - heavier than a car. '
              + 'Branches eventually give way under them.',
    },
    {
        id: 'wonder-hummingbird-nest', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'Ruby-throated Hummingbird',
        intro: ['A hummingbird’s nest is about the size of half a walnut shell, '
              + 'and the eggs inside are the size of peas.',
                'The nest has to stretch as the chicks grow, so it is built from '
              + 'something unusual.'],
        prompt: 'What does a hummingbird use to hold its nest together?',
        answer: 'Spider silk', distractors: ['Mud', 'Its own feathers', 'Tree sap'],
        reveal: 'Spider silk, which stretches as the chicks grow. The outside is '
              + 'covered in lichen so it looks like a bump on the branch.',
    },
    {
        id: 'wonder-flamingo-pink', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'Flamingo',
        intro: ['Flamingo chicks hatch out gray. The pink arrives later.',
                'A flamingo in a zoo that is fed the wrong food turns pale and white.'],
        prompt: 'Where does a flamingo’s pink come from?',
        answer: 'The food it eats',
        distractors: ['The sun', 'The salty water it stands in', 'It is born pink underneath'],
        reveal: 'From its food - tiny shrimp and algae carry the pigment, and the '
              + 'flamingo moves it into its feathers.',
    },
    {
        id: 'wonder-vulture-smell', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Turkey Vulture',
        intro: ['Most birds have a poor sense of smell. The Turkey Vulture is a '
              + 'spectacular exception.',
                'Gas companies have used this: they add a chemical to pipelines that '
              + 'smells like rotting meat, then look for circling vultures to find a leak.'],
        prompt: 'From how far away can a Turkey Vulture smell a meal?',
        answer: 'Over a mile', distractors: ['About 10 feet', 'About 100 feet', 'About 50 miles'],
        reveal: 'Over a mile. It finds food under a forest canopy it cannot see through '
              + 'at all.',
    },
    {
        id: 'wonder-pigeon-art', subject: 'art', bands: ['6-8'],
        bird: 'Pigeon',
        intro: ['Pigeons have been trained in laboratories to sort photographs, and '
              + 'they are startlingly good at it.',
                'In one well-known experiment they were shown paintings.'],
        prompt: 'What were pigeons trained to tell apart?',
        answer: 'Monet from Picasso',
        distractors: ['Red from green only', 'Photographs from drawings', 'Letters of the alphabet'],
        reveal: 'Monet from Picasso - and then they sorted paintings they had never '
              + 'seen into the right style.',
    },
    {
        id: 'wonder-dinosaur', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Chicken',
        intro: ['Birds are not just related to dinosaurs. Birds ARE dinosaurs - the '
              + 'only branch of the family that survived the asteroid.',
                'So every bird at the feeder has a very famous cousin.'],
        prompt: 'Which living animal is the closest relative of Tyrannosaurus rex?',
        answer: 'A chicken', distractors: ['A crocodile', 'A lizard', 'An elephant'],
        reveal: 'Birds - and protein recovered from T. rex bone matched chicken more '
              + 'closely than anything else alive.',
    },
    {
        id: 'wonder-murmuration', subject: 'maths', bands: ['6-8'],
        bird: 'European Starling',
        intro: ['Starlings gather at dusk in flocks of thousands and pour across the '
              + 'sky in shapes that look choreographed.',
                'There is no leader. Nobody is in charge of the shape.'],
        prompt: 'How does each starling decide where to go?',
        answer: 'It watches about seven neighbours',
        distractors: ['It follows the bird in front', 'It follows the oldest bird',
                      'They all call out to each other'],
        reveal: 'Each bird tracks roughly its seven nearest neighbours. Seven simple '
              + 'rules, repeated by thousands of birds, make the whole shape.',
    },
    {
        id: 'wonder-robin-egg', subject: 'art', bands: ['k-2', '3-5'],
        bird: 'American Robin',
        intro: ['"Robin’s egg blue" is a color name used by paint companies and '
              + 'crayon makers, because a robin’s egg really is that blue.',
                'The color is not painted on. It is made inside the mother.'],
        prompt: 'Why might a robin’s egg be blue rather than white?',
        answer: 'Blue shields the chick from sun',
        distractors: ['To match the sky', 'Because robins eat blueberries', 'To look like a stone'],
        reveal: 'The leading idea is sunlight: blue blocks some harmful rays while '
              + 'still letting warmth through. The pigment comes from the mother’s blood.',
    },
    {
        id: 'wonder-swallow-return', subject: 'geography', bands: ['3-5', '6-8'],
        bird: 'Cliff Swallow',
        intro: ['The Cliff Swallows of San Juan Capistrano in California are famous '
              + 'for coming back from Argentina at almost the same date every spring.',
                'The town has held a festival for their return for nearly a century.'],
        prompt: 'Roughly how far do those swallows travel to get back?',
        answer: 'About 6,000 miles', distractors: ['About 60 miles', 'About 600 miles', 'About 60,000 miles'],
        reveal: 'About 6,000 miles each way, from Argentina. They can be back within '
              + 'days of the same date year after year.',
    },
    {
        id: 'wonder-woodcock-walk', subject: 'science', bands: ['k-2', '3-5'],
        bird: 'American Woodcock',
        intro: ['The American Woodcock is a plump brown bird that hunts worms in soft '
              + 'ground, and it has a very odd habit.',
                'Before it moves forward it rocks its whole body back and forth, over '
              + 'and over, while its head stays still.'],
        prompt: 'Why do people think the woodcock rocks like that?',
        answer: 'To make worms move so it can feel them',
        distractors: ['To keep warm', 'To scare off rivals', 'To look bigger than it is'],
        reveal: 'The best guess is that the drumming makes worms shift underground, '
              + 'and the woodcock feels them through its feet.',
    },
    {
        id: 'wonder-penguin-feathers', subject: 'maths', bands: ['3-5', '6-8'],
        bird: 'Emperor Penguin',
        intro: ['A penguin stays warm in water near freezing, and its feathers are a '
              + 'big part of how.',
                'They are packed far more densely than most birds’ feathers.'],
        prompt: 'About how many feathers does a penguin have on each square inch?',
        answer: 'About 100', distractors: ['About 2', 'About 10', 'About 10,000'],
        reveal: 'Around 100 per square inch, in overlapping layers that trap a sheet '
              + 'of air against the skin.',
    },
    {
        id: 'wonder-crane-dance', subject: 'art', bands: ['k-2', '3-5'],
        bird: 'Sandhill Crane',
        intro: ['Sandhill Cranes dance. They bow, leap into the air with their wings '
              + 'spread, and toss sticks and grass above their heads.',
                'Pairs dance together, and they stay together for life.'],
        prompt: 'When do Sandhill Cranes dance?',
        answer: 'All year, not only when courting',
        distractors: ['Only in spring', 'Only when they are frightened', 'Only the young ones dance'],
        reveal: 'All year and at any age. Chicks dance too, which suggests it is partly '
              + 'just practice - and partly because they can.',
    },
    {
        id: 'wonder-nutcracker-memory', subject: 'maths', bands: ['6-8'],
        bird: 'Clark’s Nutcracker',
        intro: ['Clark’s Nutcracker lives high in the Rocky Mountains and survives '
              + 'winter on pine seeds it buried months earlier.',
                'It buries them in small caches spread over many square miles, then '
              + 'finds them again under deep snow.'],
        prompt: 'About how many seeds can one nutcracker hide and still relocate?',
        answer: 'Tens of thousands', distractors: ['About 50', 'About 500', 'About 5 million'],
        reveal: 'Tens of thousands of caches, remembered for months, under snow. It is '
              + 'among the best spatial memories ever measured in an animal.',
    },
    {
        id: 'wonder-cuckoo-egg', subject: 'science', bands: ['3-5', '6-8'],
        bird: 'Common Cuckoo',
        intro: ['A Common Cuckoo never builds a nest or raises its own chick.',
                'It lays its egg in another bird’s nest and flies off, leaving '
              + 'the smaller bird to do all the work.'],
        prompt: 'What does the cuckoo chick do when it hatches?',
        answer: 'Pushes the other eggs out of the nest',
        distractors: ['Shares the food fairly', 'Flies back to find its real mother', 'Sings like the host bird'],
        reveal: 'It heaves the other eggs over the side, so it gets every scrap of '
              + 'food - often from foster parents half its size.',
    },
];


// Distractor pool for identification when the feeder has only seen one or two
// species — a 3-choice question needs three plausible birds whether or not
// they have all visited.
const COMMON_FEEDER_SPECIES = Object.keys(SPECIES_FACTS);

function speciesFact(species, band) {
    const f = SPECIES_FACTS[species];
    if (!f) return '';
    return band === 'k-2' ? f['k-2'] : f['up'];
}

// ── Art ──────────────────────────────────────────────────────────
//
// Art questions, because a feeder is one of the few data sources that is
// also genuinely beautiful, and because forty questions of the same shape is
// how a question set becomes boring no matter how good the questions are.
//
// These are not data questions wearing a smock. Warm and cool, the primary
// colors, and what mixes to make orange are the actual beginning of a
// primary art curriculum, and the birds supply the examples - a cardinal, a
// goldfinch and a jay really are red, yellow and blue, which is a free and
// surprisingly rare demonstration that the three primaries exist in nature
// and turned up at the school feeder in the same week.

// The plain color words from SPECIES_LOOKS, as paint.
//
// Separate from SPECIES_COLORS: that table pulls the grays apart so chart
// bars stay distinguishable, which is right for a chart and wrong for a
// swatch. A swatch has to be the color the WORD means, or matching the word
// to the patch stops being possible.
const COLOR_WORD_HEX = {
    'red':             '#e23b3b',
    'orange':          '#f08a2c',
    'yellow':          '#f5d324',
    'brown':           '#9c6b43',
    'blue':            '#3b7fe2',
    'gray':            '#9aa3ad',
    'black':           '#2f3338',
    'black and white': '#d9dee4',
};

// Artists' warm/cool split. Only the colors it is honestly defined for -
// black, white and the black-and-white birds sit outside it, and a question
// that forced them to one side would be teaching something untrue.
const WARM_COLORS = ['red', 'orange', 'yellow', 'brown'];
const COOL_COLORS = ['blue', 'gray'];

// Red, yellow and blue. The feeder regularly supplies all three.
const PRIMARY_COLORS = ['red', 'yellow', 'blue'];

/**
 * Paint a color swatch onto each answer.
 *
 * The answers to a color question have to BE the colors - a K-2 class that
 * cannot yet read "orange" can still match a patch to a photograph, and that
 * is the whole point of asking them.
 */
function cmSwatchChoices(built, hexOf) {
    if (!built) return null;
    built.choices = built.choices.map(c => {
        const hex = hexOf(c.label);
        return hex ? { ...c, swatch: hex } : c;
    });
    return built;
}

// The species seen this week that have a color we can talk about.
function cmColorfulSpecies(s, allow) {
    return s.species
        .map(x => ({ species: x.species, n: x.n, look: speciesLook(x.species) }))
        .filter(x => x.look && x.look.color
                  && (!allow || allow.includes(x.look.color)));
}

// ── Word puzzles (design notes §3, "activity ideas") ──────────────
//
// Everything else in the set asks the class to read data. These ask them to
// read WORDS — jumbles, missing letters, a hidden name, a letter code — using
// the birds that actually came to the feeder this week as the material. A
// class that has met Carolina Wren on the board five times can unscramble
// NERW; the puzzle is doing double duty as spelling practice on vocabulary
// they have a reason to care about.
//
// A real crossword is a worksheet, not a projector question — it needs a grid
// and twenty minutes. "Missing letters" below is the single-clue version of
// one, which is what fits a question screen.

// "Northern Cardinal" -> "CARDINAL". The last word is the one a class says
// out loud and the one short enough to play with; "NORTHERNCARDINAL" as a
// jumble is a punishment rather than a puzzle.
function cmShortName(species) {
    const parts = String(species || '').trim().split(/[\s-]+/);
    return (parts[parts.length - 1] || '').toUpperCase();
}

/**
 * Wrong answers whose NAME IS THE SAME LENGTH as the right one.
 *
 * From a flag on the Caesar cipher: "I knew there were only 4 letters, so I
 * could easily tell WREN, without actually moving letters." Every puzzle here
 * shows the answer's length - a jumble, a cipher, a row of blanks - so if
 * only one option is that long the puzzle is already solved. Prefers same
 * length, then nearest, so it degrades to the old behavior rather than
 * returning nothing when the feeder has only a handful of species.
 */
function cmLengthMatchedDistractors(pool, answerLen, rng, count) {
    const exact = cmShuffle(pool.filter(x => x.short.length === answerLen), rng);
    const near  = cmShuffle(pool.filter(x => x.short.length !== answerLen), rng)
        .sort((a, b) => Math.abs(a.short.length - answerLen)
                      - Math.abs(b.short.length - answerLen));
    return exact.concat(near).slice(0, count);
}

// Shuffle until it actually differs from the original — a "jumble" that
// comes back as the word itself has happened and looks like a bug.
function cmJumble(word, rng) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const out = cmShuffle(word.split(''), rng).join('');
        if (out !== word) return out;
    }
    return null;
}

const PUZZLE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ── Classroom data ───────────────────────────────────────

/**
 * Roll a feeder's detections up into everything the templates ask for.
 *
 * Computed once per feeder per session rather than per template: fifteen
 * templates each re-reducing the same few thousand rows is the kind of thing
 * that makes a projector laptop stutter between questions.
 */
/**
 * Every day in the window, including the empty ones.
 *
 * Teacher feedback: "x axis shows Fri, Sat, then Wed, Thurs - what happened
 * to Sunday, Monday and Tuesday?" They were missing because the summary was
 * built from the detections, so a day with no birds produced no row and the
 * chart simply skipped it. That is not a cosmetic gap: it makes the axis lie
 * about the passage of time, and it quietly changes the answer to "which day
 * was quietest", because the quietest day was not on the chart at all.
 */
function cmDayKeysEnding(today, count) {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        out.push(cmDayKey(d));
    }
    return out;
}

/**
 * What counts as a bird.
 *
 * The detector reports what it sees, and what turns up at a feeder is not
 * always a bird. A real classroom here was offered "Deer" as one of three
 * answers to "which of these birds came to the feeder today" - which is a
 * giveaway and a lie in the same breath, and it was the FIRST thing a
 * six-year-old would have spotted. A detection carries no taxonomic field to
 * sort this out with, so this is a list of the animals that actually show up
 * in front of feeder cameras. It errs towards keeping things: an unlisted
 * animal is treated as a bird, because dropping a real species from a lesson
 * is worse than the occasional stray.
 *
 * These rows leave the classroom summary entirely rather than being hidden
 * from the species list alone. The lesson says "bird visits" in a dozen
 * places, and a deer is not a bird visit.
 */
const CM_NOT_BIRDS = new Map([
    ['deer', 'mammal'], ['white-tailed deer', 'mammal'], ['whitetail deer', 'mammal'],
    ['mule deer', 'mammal'], ['elk', 'mammal'], ['moose', 'mammal'],
    ['squirrel', 'mammal'], ['gray squirrel', 'mammal'], ['grey squirrel', 'mammal'],
    ['eastern gray squirrel', 'mammal'], ['eastern grey squirrel', 'mammal'],
    ['fox squirrel', 'mammal'], ['red squirrel', 'mammal'], ['flying squirrel', 'mammal'],
    ['chipmunk', 'mammal'], ['eastern chipmunk', 'mammal'], ['groundhog', 'mammal'],
    ['woodchuck', 'mammal'], ['marmot', 'mammal'],
    ['raccoon', 'mammal'], ['racoon', 'mammal'], ['opossum', 'mammal'],
    ['possum', 'mammal'], ['virginia opossum', 'mammal'],
    ['rabbit', 'mammal'], ['cottontail', 'mammal'], ['eastern cottontail', 'mammal'],
    ['hare', 'mammal'], ['jackrabbit', 'mammal'],
    ['cat', 'mammal'], ['domestic cat', 'mammal'], ['house cat', 'mammal'],
    ['feral cat', 'mammal'], ['bobcat', 'mammal'], ['lynx', 'mammal'],
    ['dog', 'mammal'], ['domestic dog', 'mammal'], ['coyote', 'mammal'],
    ['wolf', 'mammal'], ['fox', 'mammal'], ['red fox', 'mammal'],
    ['gray fox', 'mammal'], ['grey fox', 'mammal'],
    ['bear', 'mammal'], ['black bear', 'mammal'], ['brown bear', 'mammal'],
    ['skunk', 'mammal'], ['striped skunk', 'mammal'],
    ['armadillo', 'mammal'], ['nine-banded armadillo', 'mammal'],
    ['rat', 'mammal'], ['mouse', 'mammal'], ['vole', 'mammal'],
    ['shrew', 'mammal'], ['mole', 'mammal'], ['bat', 'mammal'],
    ['weasel', 'mammal'], ['mink', 'mammal'], ['otter', 'mammal'],
    ['marten', 'mammal'], ['fisher', 'mammal'], ['badger', 'mammal'],
    ['porcupine', 'mammal'],
    ['snake', 'reptile'], ['lizard', 'reptile'], ['anole', 'reptile'],
    ['green anole', 'reptile'], ['brown anole', 'reptile'], ['iguana', 'reptile'],
    ['gecko', 'reptile'], ['skink', 'reptile'], ['turtle', 'reptile'],
    ['tortoise', 'reptile'], ['alligator', 'reptile'],
    ['frog', 'amphibian'], ['toad', 'amphibian'], ['salamander', 'amphibian'],
    ['insect', 'insect'], ['butterfly', 'insect'], ['moth', 'insect'],
    ['bee', 'insect'], ['wasp', 'insect'], ['hornet', 'insect'],
    ['dragonfly', 'insect'], ['grasshopper', 'insect'],
    // Not animals the question should ever ask about: people, and the
    // detector's own ways of saying it does not know.
    ['human', 'skip'], ['person', 'skip'], ['people', 'skip'],
    ['man', 'skip'], ['woman', 'skip'], ['child', 'skip'],
    ['unknown', 'skip'], ['other', 'skip'], ['none', 'skip'],
    ['no bird', 'skip'], ['empty', 'skip'], ['motion', 'skip'],
    ['background', 'skip'],
]);

/**
 * The detector falls back to the scientific name when it has no common one,
 * and "Streptopelia chinensis" in front of a Year 2 class is not a bird, it
 * is a spelling test. Only binomials actually seen in this community's data
 * are mapped; an unmapped one is left exactly as it came rather than guessed
 * at, because a wrong common name is worse than a Latin one.
 */
const CM_LATIN_COMMON = {
    'streptopelia chinensis':   'Spotted Dove',
    'streptopelia decaocto':    'Eurasian Collared-Dove',
    'columba livia':            'Rock Pigeon',
    'columba livia domestica':  'Rock Pigeon',
    'columba palumbus':         'Common Wood-Pigeon',
    'zenaida macroura':         'Mourning Dove',
    'zenaida asiatica':         'White-winged Dove',
    'cardinalis cardinalis':    'Northern Cardinal',
    'baeolophus bicolor':       'Tufted Titmouse',
    'thryothorus ludovicianus': 'Carolina Wren',
    'haemorhous mexicanus':     'House Finch',
    'passer domesticus':        'House Sparrow',
    'sturnus vulgaris':         'European Starling',
    'quiscalus quiscula':       'Common Grackle',
    'cyanocitta cristata':      'Blue Jay',
};

/**
 * Roughly how big, in the three sizes a field guide actually uses.
 *
 * This exists for one question - who gives way to whom at a crowded feeder -
 * and it is deliberately coarse. Project FeederWatch's displacement data
 * found that the heavier bird usually wins, so a question can be built on
 * size; but published weights for the same species vary by source and the
 * ranges overlap badly in the middle (a starling and a jay are the same
 * handful of grams apart that nobody should be asked to guess about). So the
 * question only ever compares SMALL against LARGE, two steps apart, where
 * the ordering is not in doubt whichever guide you open. Everything medium
 * is here to be excluded, not to be compared.
 */
const CM_BIRD_SIZE = {
    // chickadee-to-sparrow sized, under about 25g
    'Carolina Chickadee': 'small', 'Black-capped Chickadee': 'small',
    'Tufted Titmouse': 'small', 'Carolina Wren': 'small', 'Bewick\'s Wren': 'small',
    'House Wren': 'small', 'Winter Wren': 'small',
    'House Finch': 'small', 'Purple Finch': 'small', 'American Goldfinch': 'small',
    'Pine Siskin': 'small', 'White-breasted Nuthatch': 'small',
    'Red-breasted Nuthatch': 'small', 'Brown-headed Nuthatch': 'small',
    'House Sparrow': 'small', 'Dark-eyed Junco': 'small', 'Chipping Sparrow': 'small',
    'Song Sparrow': 'small', 'White-throated Sparrow': 'small',
    'Downy Woodpecker': 'small', 'Ruby-throated Hummingbird': 'small',
    'Tree Swallow': 'small', 'Yellow-rumped Warbler': 'small',
    'Pine Warbler': 'small', 'Palm Warbler': 'small',

    // robin-to-starling sized: never compared, only kept out of the way
    'Northern Cardinal': 'medium', 'American Robin': 'medium',
    'European Starling': 'medium', 'Northern Mockingbird': 'medium',
    'Red-bellied Woodpecker': 'medium', 'Hairy Woodpecker': 'medium',
    'Red-winged Blackbird': 'medium', 'Brown Thrasher': 'medium',
    'Gray Catbird': 'medium', 'Blue Grosbeak': 'medium',
    'Common Ground Dove': 'medium', 'Ruddy Ground Dove': 'medium',
    'Inca Dove': 'medium', 'Brown-headed Cowbird': 'medium',

    // dove-to-crow sized, comfortably over 70g
    'Mourning Dove': 'large', 'White-winged Dove': 'large',
    'White-tipped Dove': 'large', 'Eurasian Collared-Dove': 'large',
    'Spotted Dove': 'large', 'Rock Pigeon': 'large',
    'Common Wood-Pigeon': 'large', 'Blue Jay': 'large',
    'Florida Scrub-Jay': 'large', 'American Crow': 'large', 'Fish Crow': 'large',
    'Common Grackle': 'large', 'Boat-tailed Grackle': 'large',
    'Northern Flicker': 'large', 'Pileated Woodpecker': 'large',
    'Blue-headed Vireo': 'small',
};

function cmSpeciesName(sp) {
    const k = String(sp || '').trim().toLowerCase();
    return CM_LATIN_COMMON[k] || sp;
}

function cmIsBird(sp) {
    return !CM_NOT_BIRDS.has(String(sp || '').trim().toLowerCase());
}

// The group an animal belongs to, or null for a bird and for the
// detector's "I do not know" rows, which name no animal at all.
function cmAnimalGroup(sp) {
    const g = CM_NOT_BIRDS.get(String(sp || '').trim().toLowerCase());
    return !g || g === 'skip' ? null : g;
}

/**
 * How sure the detector was, as a percentage from 0 to 100.
 *
 * THE DETECTOR REPORTS A PERCENTAGE. 63.5 means "63.5% sure". Every
 * threshold in this file was written as `>= 0.65`, which on a 0-100 scale is
 * true of every detection ever recorded - so the filters that were supposed
 * to keep a 36%-confident guess out of "which bird is this?" have never once
 * excluded a row. The guess-the-species question has been free to put up a
 * photo whose label was barely better than a coin flip, under a comment
 * explaining that a misidentified clip teaches the wrong bird.
 *
 * Production settled the scale beyond argument: the values arrive byte-
 * scaled (91/255 * 100 = 35.686...), running 35.7 at the lowest through a
 * median of 63.5 to 97.3 at the best.
 *
 * Normalised defensively all the same. A firmware that started reporting
 * 0-1 would otherwise reinstate exactly this bug from the other direction,
 * and silently - which is how it survived this long the first time.
 */
function cmConfPct(r) {
    const c = Number(r && r.confidence);
    if (!isFinite(c) || c <= 0) return 0;
    return c <= 1 ? c * 100 : c;
}

// Where the SPECIES NAME is the content - guess-the-bird, and the clip
// questions - a shaky label teaches a child the wrong bird, so the floor is
// real and a question that cannot clear it does not get asked. Where the
// photograph is only something true to look at, the label is not the answer
// and the best available shot is better than no question at all.
const CM_CONF_LABEL = 65;
const CM_CONF_SHOW  = 55;

/**
 * The rarity label, Title Cased, or '' where the feeder sent none.
 *
 * Production sends "Common"; the test fixture sent "common". The question
 * that asks how many sightings were "something other than Common" then
 * answered ALL OF THEM - a clean reversal of its own meaning, from one
 * capital letter. One definition, used by the summary and by the questions,
 * so there is no second place for the casing to drift.
 */
function cmRarityLabel(r) {
    const x = String((r && r.rarity) || '').trim();
    return x ? x.charAt(0).toUpperCase() + x.slice(1).toLowerCase() : '';
}

function cmSummarize(feederId, name, rows, isHome, windowDays) {
    // Scientific names become common ones and the non-birds go, before a
    // single count is taken - so every number downstream, every chart and
    // every photo is drawn from the same cleaned set rather than each
    // template having to remember to filter for itself.
    // The names as well as the tally: a deer that walked past the feeder is
    // a fact about the fortnight, and SC.3.L.15.1 is a question about exactly
    // that - which group of animals does this one belong to?
    const others = new Map();
    rows.filter(r => !cmIsBird(r.species)).forEach(r => {
        const sp = r.species || '';
        if (cmAnimalGroup(sp)) others.set(sp, (others.get(sp) || 0) + 1);
    });
    const nonBird = rows.filter(r => !cmIsBird(r.species)).length;
    rows = rows.filter(r => cmIsBird(r.species))
               .map(r => (cmSpeciesName(r.species) === r.species
                          ? r : { ...r, species: cmSpeciesName(r.species) }));

    const bySpecies = new Map();
    const byDay     = new Map();
    const byHour    = new Array(24).fill(0);
    const daySpec   = new Map();
    const snapshots = [];
    // Detections that came with a recorded clip. Only feeders set up to
    // record have any, so most summaries carry none and the clip questions
    // simply sit the week out.
    const clips = [];
    let tempSum = 0, tempRows = 0;
    const dayTemp = new Map();   // day -> {sum, n}
    // How unusual the detector thinks each sighting is for THIS AREA -
    // Common, Uncommon, Rare. Fetched since the beginning and read by
    // nothing, which is a waste of the one field that knows our feeder sits
    // in a place rather than nowhere.
    const byRarity = new Map();

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

        // Title case, always. Production sends "Common"; the test fixture
        // sent "common", and the question that asks how many sightings were
        // "something other than Common" then answered ALL OF THEM - a clean
        // reversal of its own meaning, from a capital letter. Whatever the
        // feeder sends, it means the same three words.
        const rar = cmRarityLabel(r);
        if (rar) byRarity.set(rar, (byRarity.get(rar) || 0) + 1);

        if (r.image_url && !isPrivateMedia(r.image_url)) snapshots.push(r);
        if (r.video_url && !isPrivateMedia(r.video_url)) clips.push(r);
    }

    // Highest confidence first: the identification question wants the clearest
    // photo of the bird, not the most recent blur.
    // Through cmConfPct rather than the raw field: order survives either
    // scale, but a feed that ever mixed the two would sort every 0-1 row
    // below every 0-100 one, and "the clearest photo we have" would quietly
    // become "any photo from the other firmware".
    snapshots.sort((a, b) => cmConfPct(b) - cmConfPct(a));
    clips.sort((a, b) => cmConfPct(b) - cmConfPct(a));

    const species = [...bySpecies.entries()]
        .map(([species, n]) => ({ species, n }))
        .sort((a, b) => b.n - a.n || a.species.localeCompare(b.species));

    const days = (windowDays
        ? cmDayKeysEnding(new Date(), windowDays)
        : [...byDay.keys()].sort((a, b) => a.localeCompare(b))
      ).map(day => ({ day, n: byDay.get(day) || 0 }));

    return {
        feederId, name, isHome,
        rows, total: rows.length,
        species, bySpecies, days, byDay, byHour, daySpec, snapshots, clips,
        distinct: species.length,
        // Kept rather than discarded: a class that knows a deer walked past
        // the feeder is better off than one that thinks nothing did, and a
        // question may want to say so one day.
        nonBird, others, byRarity,
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

    // The image has just given the slide its real height.
    requestAnimationFrame(classroomFitStage);

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
    const scope = room.question_scope || 'home';

    const ids = [];
    if (room.home_feeder_id) ids.push(room.home_feeder_id);
    (room.partners || []).forEach(p => { if (p.feeder_id) ids.push(p.feeder_id); });

    // 'community' reaches past the classroom's own list to every approved
    // feeder here — the same set the Stats tab draws on. A single courtyard
    // feeder in February has ten visits and no lesson in it; forty feeders
    // across the community have a week's worth of real data, and the
    // questions that need VOLUME (scatter plots, box plots, comparing two
    // populations) only exist at that size.
    //
    // Approved only, and only in THIS community. Reading the feeders table
    // unfiltered would turn a classroom into a viewer for every feeder on
    // the site, which is the hole loadClassroomFeederOptions was careful
    // not to open.
    let pooledNames = new Map();
    if (scope === 'community') {
        const extra = await cmCommunityFeederIds();
        extra.forEach(f => {
            pooledNames.set(f.id, f.display_name);
            if (!ids.includes(f.id)) ids.push(f.id);
        });
    }

    if (!ids.length) return { home: null, partners: [], all: [], pooled: null, scope };

    const since = new Date(Date.now() - CLASSROOM_WINDOW_DAYS * 86400000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/community_detections`
              // latitude/longitude/zip_code carry the geography questions —
              // SS.3.G.1.1 and SS.5.G.1.2 want a class reading real
              // coordinates off real places, and a feeder that reports its
              // position is the only honest source of those we have.
              + `?select=id,feeder_id,species,confidence,detected_at,image_url,video_url,`
              + `temperature,rarity,latitude,longitude,zip_code`
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

    // Every feeder that came back, named — including the community ones the
    // classroom never listed. Comparison questions need the parts, not just
    // the pile: "which feeder saw more cardinals" is MA.7.DP.1.2, and it
    // cannot be asked of a summary that has already added them together.
    const each = ids.map(id => {
        const own = id === room.home_feeder_id ? home
                  : partners.find(p => p.feederId === id);
        return own || cmSummarize(id, pooledNames.get(id) || 'a feeder',
                                  byFeeder.get(id) || [], false);
    }).filter(Boolean);

    // The pile itself. Built from the rows rather than by merging summaries,
    // so every derived figure — byHour, daySpec, the temperature average —
    // is computed over the whole set instead of being averaged twice.
    const pooled = rows.length ? Object.assign(
        cmSummarize(null, cmPoolName(), rows, false),
        { isPool: true, feeders: each.filter(x => x.total > 0) }
    ) : null;

    return { home, partners, all: [home, ...partners].filter(Boolean), each, pooled, scope };
}

// What the slides call the pooled set. The community's own name when we
// have it, because "our feeders" is a claim about ownership that is true
// for a school and false for an open community anyone may join.
function cmPoolName() {
    const c = (typeof myCommunities !== 'undefined' && Array.isArray(myCommunities))
        ? myCommunities.find(x => x && x.id === classroomCommunityId) : null;
    const name = c && (c.name || c.slug);
    return name ? `the ${name} feeders` : 'our community feeders';
}

/**
 * Every approved feeder in this community, with its display name.
 *
 * Same two-step read as loadClassroomFeederOptions, and for the same
 * reason: community_feeders_list is owner/moderator-only, and a teacher
 * has to be able to run a community-wide lesson without the roster.
 */
async function cmCommunityFeederIds() {
    if (!classroomCommunityId) return [];
    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/community_feeders`
            + `?select=feeder_id&status=eq.approved&community_id=eq.${classroomCommunityId}`,
            { headers: sbHeaders(true) });
        if (!res.ok) return [];
        const ids = (await res.json()).map(r => r.feeder_id).filter(Boolean);
        if (!ids.length) return [];

        const fres = await fetch(
            `${SUPABASE_URL}/rest/v1/feeders?id=in.(${ids.join(',')})`
            + `&select=id,display_name`,
            { headers: sbHeaders(true) });
        if (!fres.ok) return [];
        return await fres.json();
    } catch {
        // A classroom set to 'community' whose lookup fails falls back to
        // its own feeders rather than to no lesson at all.
        return [];
    }
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

    // A classroom set to 'community' asked for the pile, so it gets the
    // pile — no fallback ladder, because there is nothing wider to fall
    // back TO. If even the whole community is empty the caller's
    // no-data path handles it, exactly as for a quiet home feeder.
    if (data.scope === 'community' && data.pooled) return data.pooled;

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
    const out  = cmSummarize(src.feederId, src.name, rows, src.isHome, days);

    // Carry the pool flags across. Without this a narrowed pool looks like
    // an ordinary single feeder, and every question that checks isPool —
    // the per-feeder comparisons especially — silently stops firing on the
    // 7-day window while still working on the 14-day one.
    if (src.isPool) {
        out.isPool  = true;
        out.feeders = (src.feeders || []).map(f => cmWindow(f, days))
                                         .filter(f => f.total > 0);
    }
    return out;
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
// Hours are the exception the cap's own comment warns about. "6a" and "12p"
// are two and three characters, so eighteen of them fit where eight species
// names do not — and an hours chart cut at eight loses the afternoon, which
// is where half the interesting things at a feeder happen.
const CHART_MAX_HOURS = 18;
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
// Which questions need the exact numbers printed on the bars.
//
// From a teacher's flag on percent-change: "charts need to be easy to see
// values." Right, and the fix is not simply to label everything. Hiding
// values is correct when the SKILL IS reading the chart — which day was
// busiest, which bird came most — because labelling those answers the
// question outright. It is wrong when the skill is ARITHMETIC ON the values,
// because an unlabelled axis then turns a subtraction exercise into a test of
// how accurately a ten-year-old estimates a bar against a gridline, which is
// neither what is being taught nor what gets marked.
//
// So the templates whose answer is computed FROM the numbers pass
// showValues and print them from the start.
// ── Color ────────────────────────────────────────────────────────
//
// Every bar used to be the same green, separated only by opacity. On a
// projector that reads as a spreadsheet, and the feedback from an actual
// classroom was blunt: kids love color, and there wasn't any.
//
// Color here is not decoration, which is why it is a hand-written table
// rather than a generated ramp. Each species gets the color a child would
// say that bird is, so the cardinal's bar is red and the jay's is blue, and
// the chart quietly teaches identification every time it is shown. By the
// third lesson "the red one" and "the cardinal" are the same thought.
//
// Where plumage would collide - five of these birds are honestly just gray -
// the grays are pulled apart along the shades they really do differ by: a
// nuthatch IS blue-gray above, a dove IS pinkish, a junco IS charcoal. So the
// bars stay distinguishable without the colors becoming a lie.
//
// Tuned for a dark projector in a lit room: mid-to-light tones, nothing below
// about 45% lightness, because a dark bar on a dark slide is a missing bar at
// the back of the room.
const SPECIES_COLORS = {
    'Northern Cardinal':       '#ef4444',  // the red everyone pictures
    'House Finch':             '#f0638a',  // red too, pushed to rose to separate
    'Red-bellied Woodpecker':  '#fb8c6a',  // red cap, coral so it is not a third red
    'American Robin':          '#f59e0b',  // orange tummy
    'American Goldfinch':      '#fde047',  // the brightest bird at the feeder
    'Carolina Wren':           '#c08457',  // warm brown
    'House Sparrow':           '#a8926f',  // duller brown than the wren
    'Blue Jay':                '#3b82f6',
    'White-breasted Nuthatch': '#7dd3fc',  // genuinely blue-gray above
    'Tufted Titmouse':         '#a5b4cf',  // soft slate, and it is a slate bird
    'Mourning Dove':           '#d8b4a0',  // doves really are pinkish-gray
    'Dark-eyed Junco':         '#8b93a7',  // charcoal, lifted enough to read
    'Northern Mockingbird':    '#cbd5e1',  // pale gray
    'Carolina Chickadee':      '#e8eef5',  // black and white, so near-white
    'Black-capped Chickadee':  '#dbe4ee',
    'Downy Woodpecker':        '#f1f5f9',  // the other black-and-white
    'European Starling':       '#a78bfa',  // black with a purple-green sheen
};

// For series that are not species - days of the week, hours of the day. A
// run of related hues keeps the order readable left to right while still
// being a row of colors rather than a row of gray.
const CHART_SPECTRUM = [
    '#60a5fa', '#38bdf8', '#2dd4bf', '#4ade80', '#a3e635',
    '#fde047', '#fbbf24', '#fb923c', '#f87171', '#f472b6',
];

/**
 * Cold blue to warm red, for a temperature.
 *
 * `t` is 0 (the coldest day in view) to 1 (the warmest). Deliberately not a
 * full rainbow: blue-to-red is the one color ramp almost everybody already
 * reads as cold-to-hot without a legend, which is the whole point of using
 * color rather than another axis.
 */
function cmHeatColor(t) {
    const stops = [[103, 183, 240], [150, 190, 210], [222, 196, 150], [240, 134, 74]];
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * The color for one row of a chart.
 *
 * `mode` is decided once in cmChart and baked onto each row, so the renderers
 * never have to know what a series is about.
 */
function cmRowColor(row, i, n, mode) {
    if (mode === 'plain')   return 'var(--color-primary)';
    if (mode === 'species') return SPECIES_COLORS[row.key] || '#94a3b8';
    // Spread the spectrum across however many rows there are, so a week uses
    // the whole range rather than the first five.
    const span = CHART_SPECTRUM.length - 1;
    return CHART_SPECTRUM[n < 2 ? 0 : Math.round((i / (n - 1)) * span)];
}

// Where the lesson has got to in the rotation of chart shapes. Reset for
// each build so a lesson's charts are stable from review to projector.
let cmChartRotation = 0;

function cmChart(caption, series, opts) {
    const o = opts || {};
    // Species names are long and collide past eight; hour labels are three
    // characters and fit far more. The cap exists for legibility, so it
    // belongs with the caller who knows what the labels look like.
    //
    // This is not cosmetic. Truncation takes the FIRST n, so on a chart whose
    // bars ARE the answer options — "which hour was busiest" — a late peak
    // could be cut out of its own chart, leaving the class hunting for a bar
    // that was never drawn.
    const trimmed = series.filter(s => s && isFinite(s.value))
                          .slice(0, o.maxBars || CHART_MAX_BARS);
    if (trimmed.length < 2) return null;

    // A pending row has no value yet, so it cannot set the scale.
    const real = trimmed.filter(r => !r.pending);
    const max = Math.max(...real.map(r => r.value));
    if (!real.length || max <= 0) return null;

    // Dots only where they stay countable: K–2, a week or less, and no row so
    // long that counting it is worse than reading a bar.
    const dotsOk = o.band === 'k-2' && max <= DOTS_MAX_VALUE
                                    && trimmed.length <= DOTS_MAX_ROWS;

    // A requested kind wins, but only where the data can actually carry it -
    // a donut of one dominant species teaches nothing, a line through
    // unordered categories draws a trend that does not exist. Falling back is
    // better than drawing a chart that misleads.
    // Every chart in a lesson used to be the same bar chart, and a class that
    // meets the same picture eight times stops looking at it by the third.
    // So where several shapes are all honest for this data, the lesson walks
    // through them rather than picking one.
    //
    // Rotation rather than random: a lesson must look the same on the
    // projector as it did in review ten minutes earlier, and a teacher who
    // has just approved a donut should not get a bar chart in front of the
    // class. The counter resets per build, so the sequence is a property of
    // the lesson rather than of how many charts the page has ever drawn.
    const candidates = dotsOk ? ['dots', 'bars'] : ['bars'];
    for (const k of ['hbars', 'line', 'donut', 'clock']) {
        if (CHART_KINDS_OK[k](trimmed, o)) candidates.push(k);
    }

    // An explicit request wins, but only if the data can carry it.
    const kind = (o.kind && CHART_KINDS_OK[o.kind] && CHART_KINDS_OK[o.kind](trimmed, o))
        ? o.kind
        : candidates[cmChartRotation++ % candidates.length];

    // Species series color by species; everything else runs the spectrum.
    // `plain` is the opt-out, and it is not cosmetic: a question that ASKS
    // about color ("which of these birds is blue?") must not be shown a
    // chart that has already answered it in the bars.
    const mode = o.plain ? 'plain'
               : trimmed.every(r => SPECIES_COLORS[r.key]) ? 'species'
               : 'spectrum';
    // A row may bring its own color, which is how a chart encodes a SECOND
    // variable in the bars themselves - height for one, color for the other
    // - instead of spending an axis or a label line on it.
    trimmed.forEach((r, i) => {
        if (!r.color) r.color = cmRowColor(r, i, trimmed.length, mode);
    });

    // A rolling 7-day window starts on a different weekday every day, which
    // produced a reasonable question from a teacher: "why does it start on a
    // Friday? School weeks start on Monday." The window stays rolling on
    // purpose - a Monday-aligned week would show a Monday class a single
    // day's data - so the chart states its own range instead of leaving the
    // reader to work out why it begins where it does.
    const isDays = trimmed.every(r => /^\d{4}-\d{2}-\d{2}$/.test(String(r.key || '')));
    const titled = (isDays && trimmed.length > 2)
        ? `${caption} \u00b7 ${trimmed[0].label} to ${trimmed[trimmed.length - 1].label}`
        : caption;

    return { kind, caption: titled, series: trimmed, highlight: o.highlight || null,
             showValues: !!o.showValues, palette: mode, max,
             // A clock drawn with hands reading a time, rather than with one
             // blob per hour. Carried through here so the template that knows
             // WHICH time is being asked about can say so.
             hands: o.hands != null ? o.hands : null,
             // The same, held back until the answer is up: for a clock whose
             // question is which hour, hands drawn early would be the answer.
             revealHands: o.revealHands != null ? o.revealHands : null,
             total: trimmed.reduce((a, r) => a + r.value, 0) };
}

/**
 * Chart kinds a class can read an exact value off, with the numbers hidden.
 *
 * bars and hbars have a labelled, gridded scale; line has the same scale;
 * dots ARE the count, one mark per visit. A donut carries proportion and no
 * scale at all, and a clock's blobs encode roughly-how-busy by area — both
 * are fine for "which is biggest?" and useless for "how many?".
 */
const CHART_KINDS_READABLE = new Set(['bars', 'hbars', 'line', 'dots',
                                      // box and scatter both carry a labelled,
                                      // gridded numeric axis — a class reads Q1
                                      // off a box plot the same way it reads a
                                      // bar off a bar chart. picto is readable
                                      // to the nearest half symbol via its key,
                                      // which is what its question asks for.
                                      //
                                      // ⚠ LEAVING THEM OUT IS NOT A MISSING
                                      // FEATURE, IT IS A SWAP: the branch that
                                      // uses this set rewrites an unreadable
                                      // chart to 'bars', so a box-plot question
                                      // would have been shown a bar chart of
                                      // the raw daily values with the question
                                      // still asking for a quartile.
                                      'box', 'scatter', 'picto']);

// Whether a requested chart kind is honest for this data.
//
// Variety is the point - a class that meets the same bar chart forty times
// stops looking at it - but not at the cost of a chart that says something
// untrue. Each guard is the condition under which that shape means anything.
const CHART_KINDS_OK = {
    // The two that always work. Without entries here an explicit
    // kind: 'bars' fell straight through to the rotation, so a template that
    // asked for a specific shape quietly got whatever came next in the cycle.
    bars: () => true,
    dots: (rows, o) => o.band === 'k-2'
                    && Math.max(...rows.map(r => r.value)) <= DOTS_MAX_VALUE
                    && rows.length <= DOTS_MAX_ROWS,

    // Horizontal bars: long species names get room to be read instead of
    // being wrapped onto two lines under a narrow column.
    hbars: rows => rows.length >= 2 && rows.length <= 8,

    // A line asserts that the x axis is a sequence. Only true where the
    // caller says so, which is days and hours.
    line:  (rows, o) => !!o.ordered && rows.length >= 3,

    // A donut is about share of a whole. Pointless with one slice, unreadable
    // past six, and misleading when one slice is nearly everything - at 90%
    // the other species are slivers nobody can compare.
    donut: rows => rows.length >= 2 && rows.length <= 6
                && Math.max(...rows.map(r => r.value))
                   / rows.reduce((a, r) => a + r.value, 0) <= 0.9,

    // The clock needs real hours to place its marks.
    clock: (rows, o) => !!o.hours && rows.length >= 2,
};

// The week as one bar per day, oldest first — the shape every "per day"
// question wants, and the one the class sees often enough to get used to.
/**
 * A day written the way it is said aloud: "Wednesday the 11th".
 *
 * NOT the axis label. "There were 15 visits on Wed 11 and 3 visits on Thu 12"
 * is how the word problems read before this existed, and a teacher skipped
 * one mid-lesson over it: "sentence is confusing without punctuation". An
 * axis label is a compressed tag, which is right under a bar and wrong inside
 * a sentence a class has to follow by ear.
 */
function cmDayProse(dayKey) {
    const d = cmDayStart(dayKey);
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
                 'Thursday', 'Friday', 'Saturday'][d.getDay()];
    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'][d.getMonth()];
    const n = d.getDate();
    const ord = (n % 10 === 1 && n !== 11) ? 'st'
              : (n % 10 === 2 && n !== 12) ? 'nd'
              : (n % 10 === 3 && n !== 13) ? 'rd' : 'th';
    // The month as well as the weekday: "Wednesday the 11th" is ambiguous
    // across a fortnight's data, and a class reading a date aloud says the
    // month. Asked for directly: "you should spell out the day/date, for
    // instance Wednesday November 11th."
    return `${day} ${month} ${n}${ord}`;
}

/**
 * Axis labels for a run of days.
 *
 * NOT cmDayLabel. That one says "today" and "yesterday", which read well in a
 * sentence and are actively confusing on an axis: Friday, Saturday, Sunday,
 * Monday, Tuesday, yesterday, today gives a reader no way to tell the order,
 * because two of the seven are relative and the rest are not. A weekday name
 * alone is ambiguous over a fortnight's window too — there are two Fridays.
 *
 * "Fri 7" fixes both: every label has the same shape, and the number climbs
 * left to right, so the direction of time is readable without being told.
 */
function cmDayAxisLabel(dayKey) {
    const dt = cmDayStart(dayKey);
    const wd = dt.toLocaleDateString(undefined, { weekday: 'short' });
    return wd + ' ' + dt.getDate();
}

function cmDaySeries(s) {
    return s.days.map(d => ({ label: cmDayAxisLabel(d.day), value: d.n, key: d.day }));
}

/**
 * The clearest photo this feeder has of each species, for the chart labels.
 *
 * A K-2 class is the band least able to read "Carolina Chickadee" off a chart
 * and most able to recognize the bird, so the picture is doing the real work
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

/**
 * A snapshot in the shape a SLIDE wants, which is not the shape a chart
 * wants.
 *
 * cmSpeciesPhoto returns a bare URL, because that is what a chart thumbnail
 * needs for an SVG href. A question's `image` is an object, because the slide
 * also needs the detection id. Assigning the string to q.image renders
 * src="undefined" - a broken image on the projector, and silent everywhere
 * else. Four templates did exactly that before this existed.
 */
function cmShotFor(s, species) {
    const shot = s.snapshots.find(r => r.species === species);
    return shot ? { url: shot.image_url, detection_id: shot.id } : null;
}

/**
 * A photograph of a bird the feeder has never seen.
 *
 * From Wikimedia Commons, fetched by tools/fetch-bird-photos.js along with
 * the attribution its licence requires. The credit is carried on the image
 * object and rendered on the slide: for CC BY and CC BY-SA that is not a
 * courtesy, it is the condition under which we are allowed to show it at all.
 */
/**
 * A male/female photo pair, or null when the catalog has not loaded.
 *
 * Rotates with the lesson's seed so a class meeting this twice in a fortnight
 * gets a different species the second time — the point is that the pattern
 * holds across birds, not that cardinals are odd.
 */
function cmSexedPair(rng) {
    if (typeof BIRD_PAIRS === 'undefined' || !BIRD_PAIRS) return null;
    const names = Object.keys(BIRD_PAIRS);
    if (!names.length) return null;
    const species = cmShuffle(names, rng)[0];
    const p = BIRD_PAIRS[species];
    if (!p || !p.male || !p.female) return null;
    return {
        species,
        male:   { url: p.male.file,   credit: p.male },
        female: { url: p.female.file, credit: p.female },
    };
}

function cmWonderPhoto(bird) {
    const p = (typeof BIRD_PHOTOS !== 'undefined' && BIRD_PHOTOS) ? BIRD_PHOTOS[bird] : null;
    return p ? { url: p.file, credit: p } : null;
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
/**
 * The answers, or a button that asks for them first.
 *
 * Two flags on the puzzles said the same thing: "maybe this should be an
 * 'enter your answer' rather than multichoice", and "maybe it should just
 * jumble the letters and ask what the bird is, not a selection".
 *
 * They are right about the problem. Four options under an anagram is not a
 * puzzle - the class reads the four and checks which letters fit, which is a
 * different and much smaller exercise than unscrambling a word.
 *
 * This is NOT a text box, deliberately. Teacher-led mode has no student
 * devices at all - that is the whole design - so there is nothing to type
 * into, and in join-code mode a typed answer would have to be marked, which
 * means spelling mistakes decide who is right. Hiding the options instead
 * gets the part that matters: the class meets the puzzle cold and has to
 * actually solve it. The options are one press away when they are stuck,
 * which is also what a teacher wants when thirty children are waiting.
 */
/**
 * The top half of a slide: what the class is looking at, and what it is
 * being asked.
 *
 * Stacked, these two compete for one column of height — and the picture
 * always loses, because the question has to stay readable. Three flags from
 * one morning said the same thing in three different words: "the graph is
 * too small", "the chart is too small", "the photo could be larger by moving
 * it to top left quadrant, and question to top right."
 *
 * Side by side, the media gets its own column and roughly twice the height,
 * and nothing had to be taken from the question to pay for it. The layout is
 * a wide-screen one only — a projector is 16:9, which is exactly the shape
 * that has width to spare and none to spare in height. Narrow screens, and
 * any slide with nothing to show, stay the single centred column.
 */
function classroomSlideTopHtml(S, q) {
    const ask = `${classroomIntroHtml(q)}
            <h1 class="classroom-prompt">${esc(q.prompt)}</h1>`;

    const media = classroomEvidenceHtml(q, S.revealed);
    if (!media) return `<div class="classroom-slide-top">${ask}</div>`;

    return `
        <div class="classroom-slide-top has-media">
            <div class="classroom-slide-media">${media}</div>
            <div class="classroom-slide-ask">${ask}</div>
        </div>`;
}

// ════════════════════════════════════════════════════════════════════
//  A chart the class builds
// ════════════════════════════════════════════════════════════════════
//
//  Ten Florida benchmarks were left uncovered after two batches of
//  questions, and they were all the same shape: "COLLECT AND REPRESENT
//  data using tally marks or pictographs", "create box plots and
//  histograms", "construct maps, charts and graphs". A child picking one
//  of four options is not representing anything, so tagging a
//  multiple-choice question against those would have been the exact
//  over-claim classroom-alignment.js exists to prevent. They stayed in
//  the gap list, visibly, until there was something real to point at.
//
//  THIS IS THAT. The class is given the numbers as a TABLE — which is
//  itself one of the representations those benchmarks name — and an
//  empty chart. They say how tall each bar should be; the teacher taps
//  it up. Nothing is checked until they say they are done.
//
//  ⚠ THE FIRST CHECK IS THE ANSWER, and the rest is practice. A teacher
//  can keep adjusting after a wrong check — they should, that is the
//  lesson — but what gets recorded is whether the class had it right the
//  first time they said they were finished. Recording the last state
//  instead would score every class 100%, and a scoreboard that cannot
//  say anything is worse than no scoreboard.
//
//  It still records as an ordinary two-choice answer, so the history,
//  the scoreboard and the standards report need no special case.

/**
 * Turn a series into a chart the class can actually build.
 *
 * ⚠ THE CLASS CAN ONLY LAND ON MULTIPLES OF THE STEP. The interaction is
 * "press + until the bar is right", so a target of 23 on a chart that
 * moves in fives is a bar they can never finish — they would press past
 * it forever.
 *
 * The first version of this demanded a step that divided every count
 * exactly, and against real feeder counts nothing ever did: all three
 * build questions returned null on every data set, which is the same
 * mistake the pictograph question made a batch earlier.
 *
 * So there are two honest modes, and the caller picks:
 *
 *   exact  — the counts are naturally small (days of the week, species
 *            per day), the step is 1, and every bar lands on its number.
 *   scaled — a key of 5 or 10, and the target is the count ROUNDED to the
 *            nearest step. That is not a compromise, it is what a scaled
 *            pictograph IS: 99 visits at ten-per-bird is ten birds. The
 *            table shows the true count, the class does the dividing, and
 *            the explain says plainly that the graph approximates.
 *
 * Returns null whenever the data cannot carry either.
 */
function cmBuildSpec(caption, series, opts) {
    const o = opts || {};
    const rows = (series || []).filter(s => s && isFinite(s.value) && s.value > 0)
                               .slice(0, o.maxRows || 5);
    if (rows.length < 3) return null;

    const max = Math.max(...rows.map(r => r.value));
    if (max <= 0) return null;

    const presses = o.maxPresses || 12;

    // ⚠ THE UNIT IS NOT ALWAYS "VISIT". build-tally counts DAYS and
    // build-bar-chart counts KINDS OF BIRD, and a key reading "= 1 visit"
    // over a chart of days is the chart contradicting its own table.
    const unit  = o.unit || 'visit';
    // "kind of bird" does not pluralise by adding an s to the end, so the
    // plural is carried rather than derived. build-bar-chart only ever
    // uses a step of 1 today, but a trap that is only unreachable by
    // accident is still a trap.
    const units = o.units || (unit + 's');

    if (o.scaled) {
        // Smallest key that keeps every row inside the press budget.
        const step = (o.steps || [2, 5, 10, 20, 25]).find(p => Math.round(max / p) <= presses);
        if (!step) return null;

        const target = v => Math.max(step, Math.round(v / step) * step);
        // All rounding to the same height is a graph with nothing to read.
        const heights = new Set(rows.map(r => target(r.value) / step));
        if (heights.size < 2) return null;

        return {
            kind: o.kind || 'picto', scaled: true, unit, units,
            caption, step, top: Math.max(...rows.map(r => target(r.value))),
            series: rows.map((r, i) => ({
                label: r.label,
                count: r.value,                    // what the table says
                target: target(r.value),           // what the chart can show
                color: r.color || cmRowColor(r, i, rows.length, 'spectrum'),
            })),
        };
    }

    // Exact. Only worth offering while the bars stay short enough to build
    // by hand — twenty presses on one row is not a lesson.
    if (max > presses) return null;

    return {
        kind: o.kind || 'bars', unit, units,
        caption, step: 1, top: max,
        series: rows.map((r, i) => ({
            label: r.label,
            count: r.value,
            target: r.value,
            color: r.color || cmRowColor(r, i, rows.length, 'spectrum'),
        })),
    };
}

/**
 * How many DAYS each of the commonest species turned up.
 *
 * Small whole numbers by construction — never more than the days in the
 * window — which is what makes an exact build possible at all. It is
 * also a genuinely different question from "how many visits": a bird
 * that came every day in ones and a bird that came once in a flock look
 * nothing alike here.
 */
function cmDaysSeenSeries(s, limit) {
    // ⚠ ONLY THE DAYS THE WINDOW SHOWS. daySpec is keyed by calendar day
    // and a 7-day cutoff lands mid-day, so it routinely holds EIGHT keys
    // for a seven-day week — which produced "came on 8 of 7 days" and a
    // tally too long to build. s.days is the canonical list.
    const inWindow = new Set(s.days.map(d => d.day));
    const days = new Map();
    s.daySpec.forEach((m, day) => {
        if (!inWindow.has(day)) return;
        m.forEach((_, sp) => days.set(sp, (days.get(sp) || 0) + 1));
    });
    return s.species.slice(0, limit || 4)
        .map(x => ({ label: x.species, value: days.get(x.species) || 0, key: x.species }))
        .filter(r => r.value > 0);
}

/**
 * A four-quadrant grid the class plots a point on.
 *
 * MA.6.GR.1.1 says "plot rational number ordered pairs in all four
 * quadrants", and every other way of asking it is a quiz ABOUT plotting:
 * name the quadrant, read off a point somebody else placed. The verb is
 * plot, so the class plots.
 *
 * ⚠ THE DATA HAS TO REACH ALL FOUR QUADRANTS, which is why it is
 * CHANGES rather than counts. Visits and temperature are both positive
 * numbers and would never leave the first quadrant; day-to-day change in
 * each is signed by nature — colder and quieter is genuinely (−, −).
 * That is also the only honest way the benchmark's "all four quadrants"
 * clause is met by feeder data at all.
 */
function classroomGridHtml(q, revealed) {
    const g = q.grid;
    if (!g) return '';

    const R = g.range;                    // the grid runs -R..R on both axes
    const W = 620, pad = 40;
    const plot = W - pad * 2;
    const unit = plot / (R * 2);
    const X = v => pad + (v + R) * unit;
    const Y = v => pad + (R - v) * unit;

    let grid = '';
    for (let i = -R; i <= R; i++) {
        grid += `<line x1="${X(i)}" y1="${pad}" x2="${X(i)}" y2="${W - pad}"
                       class="${i === 0 ? 'cc-axis-line' : 'cc-grid'}"></line>
                 <line x1="${pad}" y1="${Y(i)}" x2="${W - pad}" y2="${Y(i)}"
                       class="${i === 0 ? 'cc-axis-line' : 'cc-grid'}"></line>`;
    }
    // Only every other number, or the labels collide at projector size.
    for (let i = -R; i <= R; i++) {
        if (i === 0 || i % 2) continue;
        grid += `<text x="${X(i)}" y="${Y(0) + 26}" class="cc-axis mid">${i}</text>
                 <text x="${X(0) - 12}" y="${Y(i) + 8}" class="cc-axis end">${i}</text>`;
    }

    // Every cell is a target, so the class can be wrong in a readable way.
    let cells = '';
    if (!revealed) {
        for (let x = -R; x <= R; x++) {
            for (let y = -R; y <= R; y++) {
                cells += `<circle cx="${X(x)}" cy="${Y(y)}" r="${unit * 0.42}"
                                  class="cc-grid-hit" onclick="classroomGridPlot(${x},${y})"></circle>`;
            }
        }
    }

    const put = q.grid_at;
    const right = put && put.x === g.target.x && put.y === g.target.y;
    const mark = put
        ? `<circle cx="${X(put.x)}" cy="${Y(put.y)}" r="11"
                   class="cc-grid-mark ${q.grid_checked ? (right ? 'ok' : 'bad') : ''}"></circle>`
        : '';
    const truth = (revealed || (q.grid_checked && !right))
        ? `<circle cx="${X(g.target.x)}" cy="${Y(g.target.y)}" r="13" class="cc-grid-truth"></circle>`
        : '';

    return `
      <figure class="classroom-chart cc-grid">
        <svg viewBox="0 0 ${W} ${W}" role="img" aria-label="${esc(g.caption)}">
          ${grid}${cells}${truth}${mark}
          <text x="${W - pad + 4}" y="${Y(0) - 10}" class="cc-axis-title end">${esc(g.xLabel)}</text>
          <text x="${X(0) + 10}" y="${pad - 12}" class="cc-axis-title">${esc(g.yLabel)}</text>
        </svg>
        <figcaption>${esc(g.caption)}</figcaption>
      </figure>`;
}

function classroomGridPlot(x, y) {
    const S = classroomSession;
    if (!S || S.revealed) return;
    const q = S.questions[S.index];
    if (!q || !q.grid) return;
    q.grid_at = { x, y };
    q.grid_checked = false;
    renderClassroomStage();
}

function classroomGridCheck() {
    const S = classroomSession;
    if (!S || S.revealed) return;
    const q = S.questions[S.index];
    if (!q || !q.grid || !q.grid_at) return;

    const right = q.grid_at.x === q.grid.target.x && q.grid_at.y === q.grid.target.y;
    q.grid_checked = true;
    if (q.grid_scored) { renderClassroomStage(); return; }
    q.grid_scored = true;
    answerClassroomQuestion(right ? 0 : 1);
}

function classroomBuildChartHtml(q, revealed) {
    const b = q.build;
    if (!b) return '';

    const vals = q.build_values || b.series.map(() => 0);
    const top  = b.top;
    const step = b.step;

    // Unit mode draws one stamp per step, which is what a tally chart and
    // a pictograph ARE. Bar mode draws a column. Same controls either way.
    const unit = b.kind === 'picto' || b.kind === 'tally';

    const rows = b.series.map((s, i) => {
        const v    = vals[i];
        const done = q.build_checked || revealed;
        // Right, or not, only once they have said they are finished.
        const mark = !done ? '' : (v === s.target ? ' ok' : ' bad');

        const body = unit
            ? `<span class="cc-build-units">${
                 Array.from({ length: Math.round(v / step) },
                   () => `<span class="cc-dot" style="background:${s.color || 'var(--color-primary)'}"></span>`).join('')
               }${v === 0 ? '<span class="cc-none">none yet</span>' : ''}</span>`
            : `<span class="cc-build-bar"><span class="cc-build-fill${mark}"
                 style="width:${Math.min(100, (v / top) * 100)}%;background:${
                   s.color || 'var(--color-primary)'}"></span></span>`;

        return `
          <div class="cc-build-row${mark}">
            <span class="cc-build-label">${esc(s.label)}</span>
            ${body}
            <span class="cc-build-val">${v}</span>
            <span class="cc-build-btns">
              <button type="button" class="classroom-btn" ${revealed ? 'disabled' : ''}
                      onclick="classroomBuildBump(${i}, -1)" aria-label="Lower ${esc(s.label)}">−</button>
              <button type="button" class="classroom-btn" ${revealed ? 'disabled' : ''}
                      onclick="classroomBuildBump(${i}, 1)" aria-label="Raise ${esc(s.label)}">+</button>
            </span>
            ${done && v !== s.target
              ? `<span class="cc-build-target">should be ${s.target}</span>` : ''}
          </div>`;
    }).join('');

    return `
      <figure class="classroom-chart cc-build">
        <div class="cc-build-key">
          ${(() => {
              const word = step === 1 ? (b.unit || 'visit') : (b.units || 'visits');
              return unit ? `<span class="cc-dot"></span> = ${step} ${esc(word)}`
                          : `Each step is ${step} ${esc(word)}`;
          })()}
        </div>
        <table class="cc-build-table"><tbody>
          ${b.series.map(s => `<tr><td>${esc(s.label)}</td><td>${
              s.count != null ? s.count : s.target}</td></tr>`).join('')}
        </tbody></table>
        <div class="cc-build-rows">${rows}</div>
        <figcaption>${esc(b.caption)}</figcaption>
      </figure>`;
}

/**
 * Raise or lower one bar by a step.
 *
 * Clamped at zero and at the top of the chart, because a bar taller than
 * the axis is not a thing a class can read and a negative count is not a
 * thing that happened.
 */
function classroomBuildBump(i, dir) {
    const S = classroomSession;
    if (!S || S.revealed) return;
    const q = S.questions[S.index];
    if (!q || !q.build) return;

    if (!q.build_values) q.build_values = q.build.series.map(() => 0);
    const step = q.build.step;
    const next = q.build_values[i] + dir * step;
    q.build_values[i] = Math.max(0, Math.min(q.build.top, next));

    // Any change after a wrong check clears the marks: leaving a bar
    // painted red while the class is in the middle of fixing it is the
    // chart arguing with them.
    q.build_checked = false;
    renderClassroomStage();
}

/**
 * "We're finished" — grade the chart.
 *
 * The first press is what the class is scored on. Later presses still
 * mark the bars so they can see what is left, which is the part a
 * teacher actually uses, but they do not change the record.
 */
function classroomBuildCheck() {
    const S = classroomSession;
    if (!S || S.revealed) return;
    const q = S.questions[S.index];
    if (!q || !q.build) return;

    const vals = q.build_values || q.build.series.map(() => 0);
    const right = q.build.series.every((s, i) => vals[i] === s.target);

    q.build_checked = true;

    if (q.build_scored) { renderClassroomStage(); return; }
    q.build_scored = true;

    // choices[0] is "we built it correctly" — see the template.
    answerClassroomQuestion(right ? 0 : 1);
}

function classroomChoicesBlock(S, q, choices) {
    // A built chart answers itself: the class says when it is finished and
    // the chart is graded. Offering the two record options as buttons as
    // well would be two ways to answer one question, and the wrong one is
    // a tap away.
    if (q.grid && !S.revealed) {
        return `<div class="cc-build-foot">
            <button class="classroom-btn-primary big" ${q.grid_at ? '' : 'disabled'}
                    onclick="classroomGridCheck()">
                ${q.grid_at ? (q.grid_checked ? 'Check it again' : 'Plot it — check')
                            : 'Tap where the point goes'}</button>
            ${q.grid_checked
                ? '<p class="classroom-muted">The ringed point is where it should be.</p>'
                : ''}
        </div>`;
    }

    if (q.build && !S.revealed) {
        return `<div class="cc-build-foot">
            <button class="classroom-btn-primary big" onclick="classroomBuildCheck()">
                ${q.build_checked ? 'Check it again' : 'We’re finished — check it'}</button>
            ${q.build_checked
                ? '<p class="classroom-muted">Not quite yet — the red rows are the ones to fix.</p>'
                : ''}
        </div>`;
    }

    const shown = S.choicesShownFor === S.index;
    // A question whose answers carry their own colour drops the decorative
    // A/B/C/D accents. Those are fixed — red, blue, amber, purple, by
    // position — and on a colour question they are a second, contradictory
    // colour on the same button. The swatch is the one that means something.
    const swatched = q.choices.some(c => c && c.swatch);
    if (!q.guess_first || S.revealed || shown) {
        return `<div class="classroom-choices ${q.choices.length > 3 ? 'four' : ''}${
                swatched ? ' swatched' : ''}">${choices}</div>`;
    }
    return `
        <div class="classroom-guess-first">
            <p class="classroom-muted">Work it out first \u2014 no options yet.</p>
            <button class="classroom-btn" onclick="showClassroomChoices()">
                Show the choices</button>
        </div>`;
}

function showClassroomChoices() {
    const S = classroomSession;
    if (!S) return;
    S.choicesShownFor = S.index;
    renderClassroomStage();
}

/**
 * Whatever the question puts in front of the class: a photo, a chart, a map,
 * or a photo AND a map side by side.
 *
 * One place that decides, because three call sites were each deciding it
 * slightly differently and the review pass had already drifted out of step
 * with the projector once.
 */
function classroomEvidenceHtml(q, revealed) {
    if (!q) return '';
    // A sexed pair is its own shape: two photographs of ONE species whose
    // whole job is to be compared. It comes first because a question that has
    // one cannot be answered from anything else.
    if (q.pair) return classroomPairHtml(q.pair);
    // A chart the class is building beats everything: it IS the question,
    // and a photograph beside it would be something else to look at while
    // they are meant to be reading a table.
    if (q.build) return classroomBuildChartHtml(q, revealed);
    if (q.grid)  return classroomGridHtml(q, revealed);
    if (q.video && q.video.url) return classroomClipHtml(q, revealed);
    // image_on_reveal: a photo that would answer the question, held back until
    // the answer is up. Before then the slide falls through to whatever else
    // it has, which for a puzzle is nothing — the letters are the evidence.
    const showImage = q.image && (revealed || !q.image_on_reveal);
    const shot = showImage ? classroomShotHtml(q, revealed) : '';
    const map  = q.map   ? classroomMapHtml(q.map, revealed) : '';

    // Both: the bird beside the places. Side by side on a projector, stacked
    // when there is no room for two.
    const sound = q.sound ? classroomSoundHtml(q, revealed) : '';

    if (shot && map) return `<div class="classroom-evidence-pair">${shot}${map}</div>`;
    if (map)  return map;
    // A photo AND a song: the bird above, the button below, which is the
    // pairing the reveal of a "who sings this?" question wants.
    if (shot) return sound ? `${shot}${sound}` : shot;
    if (sound) return sound;
    return classroomChartHtml(q.chart, revealed);
}

/**
 * A bird song on the slide.
 *
 * ⚠ A BUTTON, NOT AN <audio controls>. The native player is a thin strip
 * of 14px glyphs: unreadable from the back of a classroom and almost
 * unhittable on an interactive whiteboard. This is one large control that
 * says what it will do.
 *
 * NOT autoplay either, and not looping. Browsers block autoplay without a
 * gesture, so a song that was supposed to introduce the question would
 * simply not happen and nobody would know why — and a bird call looping
 * under a teacher's voice is the sort of thing that gets a feature turned
 * off for good. The class hears it when the teacher presses it, as many
 * times as they want.
 *
 * THE CREDIT IS NOT OPTIONAL. Every one of these is CC BY-SA or public
 * domain; for the former, naming the recordist and the licence wherever
 * the recording is played is the condition under which we may play it at
 * all. Same rule the photographs already follow.
 */
/**
 * The first of these species whose recording THIS browser can play.
 *
 * ⚠ NOT EVERY RECORDING IS AN MP3. Commons has exactly one Carolina
 * Chickadee recording and it is an .ogg, which Safari will not play — so
 * on an iPad at the front of a classroom, two music questions would have
 * put up a button that does nothing. There is no mp3 of that species to
 * fetch instead, and substituting a Black-capped Chickadee because the
 * file format is more convenient would be answering a different question.
 *
 * So the question picks a bird it can actually sound. Pass the best
 * example first and an acceptable fallback after it; a template that gets
 * null should not build at all rather than ask about a silence.
 */
function cmPlayableSound(species) {
    if (typeof birdSound !== 'function') return null;
    const list = Array.isArray(species) ? species : [species];

    let probe = null;
    try { probe = document.createElement('audio'); } catch { probe = null; }

    for (const sp of list) {
        const rec = birdSound(sp);
        if (!rec || !rec.file) continue;
        if (!probe || !probe.canPlayType) return rec;   // cannot tell: try it

        const type = /\.mp3$/i.test(rec.file) ? 'audio/mpeg'
                   : /\.og[ga]$/i.test(rec.file) ? 'audio/ogg'
                   : /\.wav$/i.test(rec.file) ? 'audio/wav' : '';
        // canPlayType returns '', 'maybe' or 'probably'. Anything but '' is
        // worth offering; '' is a definite no.
        if (!type || probe.canPlayType(type)) return rec;
    }
    return null;
}

function classroomSoundHtml(q, revealed) {
    const s = q.sound;
    if (!s || !s.file) return '';

    // Held back exactly like image_on_reveal, and for the same reason: on
    // "which bird sounds like this?" the recording IS the question, but on
    // "what does a cardinal sound like?" it is the answer.
    if (q.sound_on_reveal && !revealed) return '';

    const credit = s.artist
        ? `<p class="classroom-shot-credit">${esc(s.artist)}${
              s.licence ? ' / ' + esc(s.licence) : ''} · Wikimedia Commons</p>`
        : '';

    return `
        <figure class="classroom-sound">
            <button type="button" class="classroom-sound-btn"
                    onclick="classroomPlaySound(this)" data-src="${esc(s.file)}">
                <span class="classroom-sound-icon" aria-hidden="true">▶</span>
                <span class="classroom-sound-label">Play the song</span>
            </button>
            <audio preload="none" src="${esc(s.file)}"></audio>
            ${credit}
        </figure>`;
}

/**
 * Play, or stop if it is already playing.
 *
 * Stopping matters more than it sounds: some of these recordings run for a
 * minute and a half, and a teacher who has heard enough needs one obvious
 * way to end it rather than hunting for a control while thirty children
 * listen to a towhee.
 */
function classroomPlaySound(btn) {
    const fig = btn.closest('.classroom-sound');
    const el  = fig && fig.querySelector('audio');
    if (!el) return;

    const label = btn.querySelector('.classroom-sound-label');
    const icon  = btn.querySelector('.classroom-sound-icon');

    if (!el.paused) {
        el.pause();
        el.currentTime = 0;
        btn.classList.remove('playing');
        if (icon)  icon.textContent = '▶';
        if (label) label.textContent = 'Play the song';
        return;
    }

    // Only one bird at a time. Two slides' worth of audio overlapping is
    // the kind of thing that happens once and is never forgiven.
    document.querySelectorAll('.classroom-sound audio').forEach(a => {
        if (a !== el) { a.pause(); a.currentTime = 0; }
    });
    document.querySelectorAll('.classroom-sound-btn.playing').forEach(b => {
        if (b !== btn) {
            b.classList.remove('playing');
            const i = b.querySelector('.classroom-sound-icon');
            const l = b.querySelector('.classroom-sound-label');
            if (i) i.textContent = '▶';
            if (l) l.textContent = 'Play the song';
        }
    });

    const done = () => {
        btn.classList.remove('playing');
        if (icon)  icon.textContent = '▶';
        if (label) label.textContent = 'Play it again';
    };
    el.onended = done;

    el.play().then(() => {
        btn.classList.add('playing');
        if (icon)  icon.textContent = '■';
        if (label) label.textContent = 'Stop';
    }).catch(() => {
        // A codec the browser will not take — our ogg files on Safari — or a
        // file that failed to load. Say so on the button rather than leaving
        // a control that does nothing when pressed.
        if (label) label.textContent = 'Sound will not play here';
        btn.disabled = true;
    });
}

/**
 * A feeder clip on the slide.
 *
 * Muted and looping: a four-to-twenty-second clip that plays once and stops
 * is over before the room has settled, and sound from a projector across a
 * classroom is mostly fan noise. Looping means the class can watch it as
 * many times as the conversation needs without anyone touching anything.
 *
 * Cropped like a snapshot when the question asks which bird it is: the
 * feeder burns the species name into the bottom of every clip, in the same
 * strip geometry it uses on photos, so the photo's crop fraction is reused
 * on the video's own height.
 */
function classroomClipHtml(q, revealed) {
    const v = q.video;
    const crop = v.crop && !revealed;
    return `<div class="classroom-shot classroom-clip"${crop ? ' data-crop="caption"' : ''}>`
         + `<video src="${esc(v.url)}"${v.poster ? ` poster="${esc(v.poster)}"` : ''}`
         + ' autoplay muted loop playsinline preload="auto"'
         + ' onloadedmetadata="classroomFitClip(this)"></video>'
         + '</div>';
}

function classroomFitClip(video) {
    // The clip has just given the slide its real height.
    requestAnimationFrame(classroomFitStage);
    const wrap = video.closest('.classroom-shot');
    if (!wrap || wrap.dataset.crop !== 'caption') return;
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    const keptH = Math.round(h * (1 - cmCaptionCropFraction(h)));
    wrap.style.aspectRatio = `${w} / ${keptH}`;
    wrap.style.setProperty('--shot-ar', String(w / keptH));
    wrap.classList.add('cropped');
}

function classroomChartHtml(chart, revealed) {
    if (!chart) return '';
    // A chart that declares showValues shows them whether or not the answer
    // has been revealed.
    const withValues = revealed || chart.showValues;
    switch (chart.kind) {
        case 'dots':  return classroomDotsHtml(chart, withValues);
        case 'hbars': return classroomHBarsHtml(chart, withValues);
        case 'line':  return classroomLineHtml(chart, withValues);
        case 'donut': return classroomDonutHtml(chart, withValues);
        // The three Florida names by name. None of these is ever reached by
        // the rotation — a template asks for them or they do not appear.
        case 'picto':   return classroomPictoHtml(chart, withValues);
        case 'scatter': return classroomScatterHtml(chart, revealed);
        case 'box':     return classroomBoxHtml(chart, revealed);
        // The clock also needs the REAL reveal, not just "show the values":
        // its reveal-only hands point at the answer, and showValues is
        // switched on before the reveal whenever the counts are safe to print.
        case 'clock': return classroomClockHtml(chart, withValues, revealed);
        default:      return classroomBarsHtml(chart, withValues);
    }
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

/**
 * The unlabelled lines BETWEEN the labelled ones.
 *
 * Two separate flags, both saying the same thing: "this one is easy because
 * the bar hits an axis line — Saturday is tough to determine", and "there are
 * no chart lines with labels, so it's impossible to determine this". Both are
 * right, and the cause is cmNiceStep doing its job: it aims for about four
 * labelled gridlines, so a week topping out at 18 gets lines at 0/5/10/15/20
 * and a bar at 13 has nothing to be read against. The class can see it is
 * "between 10 and 15" and no more than that, which is not an answer.
 *
 * The fix is not more LABELS — eleven numbers up a 300-unit axis collide at
 * the font size a projected chart needs. It is a faint line at every value,
 * so a bar that misses a labelled line can still be counted up to from the
 * one below it. That is how squared paper works and children already read it.
 *
 * Returns 0 when the labelled lines are already one apart, or when every
 * value would mean so many lines that the chart turns into a gray wash.
 */
function cmMinorStep(top, step) {
    if (step <= 1) return 0;                  // already a line at every value
    // Finest first: a line at EVERY value is what was actually asked for, and
    // anything coarser still leaves some bar sitting in a gap. Only when that
    // would mean more than forty lines — at which point the plot is a gray
    // wash and nobody counts them anyway — does it fall back to a fraction of
    // the labelled step.
    for (const d of [1, step / 5, step / 4, step / 2]) {
        if (Number.isInteger(d) && d >= 1 && d < step && top / d <= 40) return d;
    }
    return 0;
}

/**
 * Horizontal rules across the plot: faint ones at every value where that is
 * readable, labelled ones on the friendly numbers.
 *
 * Shared by the bar and line charts because they had the same bug, and
 * fixing it in one of them would have left the other one unanswerable.
 */
function cmGridHtml(top, step, x1, x2, y) {
    let out = '';
    const minor = cmMinorStep(top, step);
    if (minor) {
        for (let v = 0; v <= top + 0.001; v += minor) {
            if (Math.abs(v / step - Math.round(v / step)) < 0.001) continue;
            out += `<line x1="${x1}" y1="${y(v)}" x2="${x2}" y2="${y(v)}" class="cc-grid-minor"/>`;
        }
    }
    for (let v = 0; v <= top + 0.001; v += step) {
        const yy = y(v);
        out += `<line x1="${x1}" y1="${yy}" x2="${x2}" y2="${yy}" class="cc-grid"/>`
            +  `<text x="${x1 - 12}" y="${yy + 7}" class="cc-axis" text-anchor="end">${v}</text>`;
    }
    return out;
}

/**
 * Break a chart label across at most `maxLines`, preferring real words.
 *
 * ⚠ HYPHENS COUNT AS BREAK POINTS. "Common Wood-Pigeon" split only on
 * spaces leaves "Wood-Pigeon" — eleven characters in a slot built for
 * about seven — which is the overlap that was reported. Splitting on the
 * hyphen too gives "Common" / "Wood-" / "Pigeon", and the hyphen stays
 * on the first part because a word broken without one reads as a typo.
 *
 * Returns the label whole when it is short enough, because almost every
 * label is: days and hours never need this at all.
 */
function cmWrapLabel(label, maxLines) {
    const max = maxLines || 2;
    if (label.length <= 12) return [label];

    // Split on spaces, then on hyphens, keeping the hyphen with the part
    // before it.
    const words = [];
    label.split(' ').forEach(w => {
        const bits = w.split('-');
        bits.forEach((b, i) => words.push(i < bits.length - 1 ? b + '-' : b));
    });

    // Greedy fill, aiming for even line lengths rather than one long line
    // and one short one.
    const target = Math.ceil(label.length / Math.min(max, words.length || 1));
    const lines = [];
    let cur = '';
    words.forEach(w => {
        const join = cur && !cur.endsWith('-') ? ' ' : '';
        if (!cur) { cur = w; return; }
        if ((cur + join + w).length <= Math.max(target, 8) || lines.length === max - 1) {
            cur += join + w;
        } else {
            lines.push(cur); cur = w;
        }
    });
    if (cur) lines.push(cur);
    return lines.slice(0, max);
}

function classroomBarsHtml(chart, revealed) {
    const hasPhotos = chart.series.some(x => x.image);
    const n = chart.series.length;

    // Geometry in dependency order: the photographs decide how much room the
    // area under the axis needs, so their size has to be known before the
    // canvas height is. Fixing padB first and sizing the thumbnails
    // afterwards is what pushed the species names off the bottom edge when
    // the thumbnails were enlarged.
    const W = 1000;
    const padL = 70, padR = 20, padT = 30;
    const plotW = W - padL - padR;
    const slot  = plotW / n;

    // Two bars should not sit at opposite ends of the canvas with a chasm
    // between them - "bars should be closer together" was a flag on the
    // week-over-week chart, which has exactly two. Below five bars the slot
    // is capped and the whole group is centerd instead of spread.
    const barW   = Math.min(slot * 0.62, 96);
    const group  = Math.min(slot, 200);
    const originX = padL + (plotW - group * n) / 2;
    const cxOf = i => originX + group * i + group / 2;

    const thumbW = hasPhotos ? Math.max(96, Math.min(group * 0.92, 190)) : 0;
    const thumbH = Math.round(thumbW / 1.3);

    // Under the axis: the photo, a gap, then up to two lines of label.
    const labelDrop = hasPhotos ? thumbH + 12 : 0;
    const hasSub = chart.series.some(r => r.sub);
    // Three label lines rather than two, since cmWrapLabel may use all
    // three on a name like "Common Wood-Pigeon".
    const padB = 56 + labelDrop + 78 + (hasSub ? 30 : 0);
    const H = padT + 300 + padB;
    const plotH = H - padT - padB;

    const step = cmNiceStep(chart.max);
    const top = Math.ceil(chart.max / step) * step;
    const y = v => padT + plotH - (v / top) * plotH;

    // Gridlines first, so the bars sit on top of them.
    const grid = cmGridHtml(top, step, padL, W - padR, y);

    const withPhotos = hasPhotos;
    // SVG ids are document-global, so a fixed id would let a second chart's
    // clip paths override the first one's.
    const nonce = Math.random().toString(36).slice(2, 8);
    // The image box is drawn 19% taller than the visible rect and clipped to
    // it, so the burned-in caption falls off the bottom. A rect this shape
    // with plain "slice" would show the full height of the frame — caption
    // and all — because the source is wider than the box.
    const thumbSrcH = Math.round(thumbH * 1.19);

    const bars = chart.series.map((s, i) => {
        const cx = cxOf(i);
        const h = Math.max(1, (s.value / top) * plotH);
        const on = chart.highlight && s.key === chart.highlight;
        // ⚠ SPECIES NAMES OVERLAP, and wrapping alone does not fix it.
        // Reported as "the x-axis labels are the bird species usually have
        // the text overlap". The old rule split at the LAST space and
        // stopped: "Common Wood-Pigeon" became "Common" / "Wood-Pigeon",
        // and an eleven-character word in a 155-unit slot still runs into
        // its neighbours. "White-tipped Dove" is worse.
        //
        // So: break on hyphens as well as spaces, allow three lines, and
        // then SHRINK the text to whatever actually fits the slot. The
        // shrink is the part that makes it reliable — wrapping can only
        // help where there is somewhere to wrap, and some bird names are
        // one long word.
        const label = String(s.label);
        const lines = cmWrapLabel(label, 3);
        // Shrink first, on an estimate — 0.58em per character for this
        // bold face — so most labels simply get a slightly smaller size
        // and look normal.
        const longest = Math.max(...lines.map(l => l.length), 1);
        const labelSize = Math.max(16, Math.min(30, (group * 0.92) / (longest * 0.58)));
        const lineStep = Math.round(labelSize * 0.92);

        // ⚠ THEN GUARANTEE IT, because the estimate is not a measurement.
        // A per-character factor is wrong for any string that is mostly
        // narrow or mostly wide letters, and "Streptopelia chinensis"
        // overran its slot at a size the estimate said would fit — the
        // same overlap the flag was about, just less of it.
        //
        // textLength with spacingAndGlyphs makes the browser fit the text
        // to an exact width, so this cannot be wrong. Applied ONLY to
        // lines the estimate says are still too wide, because textLength
        // forces a width rather than capping one: on a short label it
        // would stretch "Blue Jay" across the whole slot.
        const maxW = group * 0.94;
        const fitAttr = ln => (ln.length * 0.58 * labelSize > maxW)
            ? ` textLength="${maxW.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '';

        // An explicit second line, for a series that carries two facts per
        // bar. Flagged on the weather chart: "the x-axis labels need to be on
        // 2 lines, first the Day and Date, and beneath that the temperature."
        // Relying on the length-based wrap above would have put the split
        // wherever the string happened to be long enough, which is not the
        // same thing as putting it where the meaning changes.
        const subLine = s.sub
            ? `<text x="${cx}" y="${H - padB + 28 + labelDrop + lines.length * lineStep}"
                     class="cc-sublabel" text-anchor="middle"
                     ${s.subColor ? `fill="${s.subColor}"` : ''}>${esc(s.sub)}</text>`
            : '';

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

        // The day being predicted: an empty slot rather than a bar, because
        // there is no number yet and drawing a zero would be a claim.
        if (s.pending) {
            return `<rect x="${cx - barW / 2}" y="${padT}" width="${barW}"
                          height="${plotH}" rx="6" class="cc-pending"/>`
                 + `<text x="${cx}" y="${padT + plotH / 2 + 18}" class="cc-pending-q"
                          text-anchor="middle">?</text>`
                 + thumb
                 + lines.map((ln, k) =>
                     `<text x="${cx}" y="${H - padB + 28 + labelDrop + k * lineStep}"
                            class="cc-label" font-size="${labelSize.toFixed(1)}"
                            text-anchor="middle"${fitAttr(ln)}>${esc(ln)}</text>`).join('');
        }

        return `<rect x="${cx - barW / 2}" y="${y(s.value)}" width="${barW}" height="${h}"
                      rx="6" class="cc-bar${on ? ' on' : ''}" fill="${s.color}"/>`
             + (revealed
                 ? `<text x="${cx}" y="${y(s.value) - 10}" class="cc-val" text-anchor="middle">${s.value}</text>`
                 : '')
             + thumb
             + lines.map((ln, k) =>
                 `<text x="${cx}" y="${H - padB + 28 + labelDrop + k * lineStep}"
                        class="cc-label" font-size="${labelSize.toFixed(1)}"
                        text-anchor="middle"${fitAttr(ln)}>${esc(ln)}</text>`).join('')
             + subLine;
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
            dots += `<span class="cc-dot${(i + 1) % 5 === 0 ? ' five' : ''}"
                           style="background:${s.color}"></span>`;
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

/**
 * A US map with some states picked out.
 *
 * Drawn from the state outlines rather than embedded as a picture, because
 * the only reason to put a map on a question is to color part of it — "these
 * seven states" is a fact you can see in two seconds and cannot get from a
 * list of seven names read aloud.
 *
 * The states are NOT labelled. A class that can see Ohio lit up and has to
 * work out that it is Ohio is doing geography; a map with the names printed
 * on it is a diagram they read once and forget. The names arrive with the
 * reveal, where they confirm rather than replace the looking.
 */
function classroomMapHtml(spec, revealed) {
    const M = (typeof US_MAP !== 'undefined') ? US_MAP : null;
    if (!M || !spec) return '';

    const hi = new Set((spec.highlight || []).map(c => String(c).toLowerCase()));
    if (!hi.size) return '';

    // Highlighted states last, so a lit state's border is never painted over
    // by the plain neighbour drawn after it.
    const order = Object.keys(M.paths).sort(
        (a, b) => (hi.has(a) ? 1 : 0) - (hi.has(b) ? 1 : 0));

    const paths = order.map(code =>
        `<path d="${M.paths[code]}" class="cc-state${hi.has(code) ? ' on' : ''}"/>`).join('');

    const named = [...hi].map(c => M.names[c]).filter(Boolean).sort();

    return `
        <figure class="classroom-map">
            <svg viewBox="${esc(M.viewBox)}" role="img"
                 aria-label="${esc(spec.caption || 'Map of the United States')}">
                ${paths}
            </svg>
            <figcaption>${revealed && named.length
                ? esc(named.join(', '))
                : esc(spec.caption || '')}</figcaption>
        </figure>`;
}

/**
 * The story that sets up a question.
 *
 * Read aloud before the question is asked, which is why it is sentences
 * rather than bullets and why it is set large. It is the part of the slide
 * doing the actual teaching; the multiple choice underneath is just how the
 * room answers.
 */
function classroomIntroHtml(q) {
    if (!q || !Array.isArray(q.intro) || !q.intro.length) return '';
    return `<div class="classroom-intro">
                ${q.wonder_bird ? `<p class="classroom-intro-bird">${esc(q.wonder_bird)}</p>` : ''}
                ${q.intro.map(line => `<p>${esc(line)}</p>`).join('')}
            </div>`;
}

/**
 * Horizontal bars.
 *
 * The same data as a bar chart, read the other way round. Worth having for
 * species: "White-breasted Nuthatch" wrapped onto two lines under a narrow
 * column is most of why the vertical chart looks cramped, and lying the bars
 * down gives every name a whole line to itself at full size.
 */
function classroomHBarsHtml(chart, revealed) {
    const n = chart.series.length;
    const W = 1000, rowH = 62, padT = 16;
    const labelW = 300, padR = 70;

    // This chart had no value axis at all — not a faint one, none. Flagged
    // mid-lesson: "there are no x axis labels or markers, can't determine
    // the answer", on a question asking how many of one bird came. Quite
    // right: a bar whose length is the answer, drawn against nothing, with
    // the numbers deliberately withheld until the reveal, cannot be read.
    // The vertical bars have had gridlines all along; these are the same
    // thing turned on its side.
    const step  = cmNiceStep(chart.max);
    const top   = Math.ceil(chart.max / step) * step;
    const minor = cmMinorStep(top, step);
    const axisH = 54;                       // room under the bars for the numbers
    const padB  = 16 + axisH;
    const H     = padT + padB + n * rowH;
    const plotW = W - labelW - padR;
    const x     = v => labelW + (v / top) * plotW;
    const baseY = padT + n * rowH;

    let grid = '';
    if (minor) {
        for (let v = 0; v <= top + 0.001; v += minor) {
            if (Math.abs(v / step - Math.round(v / step)) < 0.001) continue;
            grid += `<line x1="${x(v)}" y1="${padT}" x2="${x(v)}" y2="${baseY}" class="cc-grid-minor"/>`;
        }
    }
    for (let v = 0; v <= top + 0.001; v += step) {
        grid += `<line x1="${x(v)}" y1="${padT}" x2="${x(v)}" y2="${baseY}" class="cc-grid"/>`
             +  `<text x="${x(v)}" y="${baseY + 38}" class="cc-axis" text-anchor="middle">${v}</text>`;
    }

    const rows = chart.series.map((s, i) => {
        const cy = padT + i * rowH + rowH / 2;
        const w = Math.max(3, (s.value / chart.max) * plotW);
        const on = chart.highlight && s.key === chart.highlight;
        return `<text x="${labelW - 16}" y="${cy + 9}" class="cc-label"
                      text-anchor="end">${esc(cmShorten(String(s.label), 22))}</text>`
             + `<rect x="${labelW}" y="${cy - 19}" width="${w}" height="38" rx="8"
                      class="cc-bar${on ? ' on' : ''}" fill="${s.color}"/>`
             + (revealed
                 ? `<text x="${labelW + w + 14}" y="${cy + 9}" class="cc-val">${s.value}</text>`
                 : '');
    }).join('');

    return `
        <figure class="classroom-chart hbars">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${grid}
                <line x1="${labelW}" y1="${padT}" x2="${labelW}" y2="${baseY}" class="cc-axisline"/>
                <line x1="${labelW}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" class="cc-axisline"/>
                ${rows}
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

/**
 * A line over time.
 *
 * Only drawn where the caller has said the x axis is a sequence, because the
 * whole meaning of a line is "this followed that". The area beneath is filled
 * so it still reads as a quantity from the back of a room, where a 3px stroke
 * on its own disappears.
 */
function classroomLineHtml(chart, revealed) {
    const W = 1000, H = 420;
    const padL = 70, padR = 30, padT = 30, padB = 86;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const step = cmNiceStep(chart.max);
    const top = Math.ceil(chart.max / step) * step;
    const n = chart.series.length;

    // The points are INSET from the axis rather than touching it.
    //
    // With the first point at x = padL it sits on the y-axis, and three
    // things go wrong at once: its marker is half-clipped by the axis line,
    // its value label lands in the axis column, and the last point's label
    // runs at the edge of the viewBox. The first of those is what produced
    // "54" on a projector — the axis tick "5" and the first value "4", four
    // pixels apart on the same baseline, because a value about four fifths
    // of a step below a gridline puts its label exactly there.
    //
    // Moving the labels was not enough: twelve pixels of daylight between
    // two digits of the same size, on the same line, still reads as one
    // number. The fix is for the data not to start on the axis at all, which
    // is also how every other chart here is laid out.
    const inset = 34;
    const innerW = plotW - inset * 2;
    const x = i => padL + inset + (n < 2 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = v => padT + plotH - (v / top) * plotH;

    const grid = cmGridHtml(top, step, padL, W - padR, y);

    const pts = chart.series.map((s, i) => `${x(i)},${y(s.value)}`).join(' ');
    const area = `${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`;

    // A fat dot per reading, in that reading's own color, so the line is
    // also a row of colored markers rather than one undifferentiated stroke.
    const marks = chart.series.map((s, i) => {
        const on = chart.highlight && s.key === chart.highlight;

        return `<circle cx="${x(i)}" cy="${y(s.value)}" r="${on ? 16 : 11}"
                        fill="${s.color}" class="cc-point${on ? ' on' : ''}"/>`
             + (revealed
                 ? `<text x="${x(i)}" y="${y(s.value) - 24}" class="cc-val"
                          text-anchor="middle">${s.value}</text>`
                 : '')
             + `<text x="${x(i)}" y="${H - padB + 34}" class="cc-label"
                      text-anchor="middle">${esc(cmShorten(String(s.label), 10))}</text>`;
    }).join('');

    return `
        <figure class="classroom-chart line">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${grid}
                <polygon points="${area}" class="cc-area"/>
                <polyline points="${pts}" class="cc-line"/>
                <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="cc-axisline"/>
                ${marks}
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

/**
 * A donut of the share each species took.
 *
 * The one chart whose shape IS the fraction, which is why it earns a place
 * next to the fraction and percent questions: "about a quarter" is something
 * you can see in a ring and have to compute from bars. A ring rather than a
 * full pie so the total can sit in the hole, where it answers "a quarter of
 * WHAT" without a sentence.
 *
 * Slices are not labelled with their values before the reveal - reading the
 * share off the chart is the exercise.
 */
function classroomDonutHtml(chart, revealed) {
    const W = 1000, H = 440;
    const cx = 250, cy = H / 2, rOuter = 170, rInner = 96;
    const total = chart.total || chart.series.reduce((a, r) => a + r.value, 0);
    if (!total) return '';

    let angle = -Math.PI / 2;            // start at twelve o'clock
    const slices = chart.series.map(s => {
        const sweep = (s.value / total) * Math.PI * 2;
        const a0 = angle, a1 = angle + sweep;
        angle = a1;
        const on = chart.highlight && s.key === chart.highlight;
        // A slice at or past half the circle needs the large-arc flag, or it
        // is drawn as its own complement.
        const large = sweep > Math.PI ? 1 : 0;
        const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
        const d = `M ${p(rOuter, a0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`
                + ` L ${p(rInner, a1)} A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, a0)} Z`;
        return `<path d="${d}" fill="${s.color}" class="cc-slice${on ? ' on' : ''}"/>`;
    }).join('');

    // Legend, because a slice cannot carry a species name inside it.
    const legend = chart.series.map((s, i) => {
        const ly = 70 + i * 56;
        const pct = Math.round((s.value / total) * 100);
        return `<rect x="560" y="${ly - 22}" width="30" height="30" rx="7" fill="${s.color}"/>`
             + `<text x="604" y="${ly + 2}" class="cc-label" text-anchor="start">`
             + `${esc(cmShorten(String(s.label), 20))}</text>`
             + (revealed
                 ? `<text x="${W - 30}" y="${ly + 2}" class="cc-val" text-anchor="end">${pct}%</text>`
                 : '');
    }).join('');

    return `
        <figure class="classroom-chart donut">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${slices}
                <text x="${cx}" y="${cy - 2}" class="cc-donut-total" text-anchor="middle">${total}</text>
                <text x="${cx}" y="${cy + 34}" class="cc-donut-cap" text-anchor="middle">visits</text>
                ${legend}
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

// ════════════════════════════════════════════════════════════════════
//  Three chart shapes Florida asks for by name
// ════════════════════════════════════════════════════════════════════
//
//  These are not more ways to draw a week. Each one exists because a
//  benchmark names it and cannot be met without it:
//
//    scaled pictograph  MA.2.DP.1.1, MA.3.DP.1.1 — "scaled pictographs"
//    scatter plot       MA.8.DP.1.1-1.3 — bivariate data, association
//    box plot           MA.6.DP.1.3 — min, Q1, median, Q3, max
//
//  They are built directly rather than through cmChart. cmChart's job is to
//  pick an honest shape for one series of labelled values and rotate
//  between them; these three take a different shape of data entirely, and
//  none of them may EVER be substituted for another chart — a question that
//  asks a class to read a quartile off a box plot is unanswerable if the
//  rotation hands it a bar chart.
// ════════════════════════════════════════════════════════════════════

/**
 * A pictograph, with a key saying what one symbol is worth.
 *
 * The scale is the entire point, and it is the thing the benchmark adds at
 * grade 2-3 over the tally charts of grade 1: a child who reads six birds
 * as six visits has not read the chart. So the key is drawn large, and a
 * half symbol is drawn where the count does not divide — rounding 7 up to
 * 8 to keep the symbols whole would silently change the answer.
 *
 * `per` is chosen so the longest row stays countable. Ten symbols is about
 * the limit before a class starts estimating instead of counting, which is
 * the same judgement DOTS_MAX_VALUE makes for the tally chart.
 */
function cmPictograph(caption, series, opts) {
    const o = opts || {};
    let rows = (series || []).filter(s => s && isFinite(s.value));
    if (rows.length < 2) return null;

    const max = Math.max(...rows.map(r => r.value));
    if (max <= 0) return null;

    const SCALES = [2, 5, 10, 20, 25, 50, 100];

    // A key of 1 is not a pictograph, it is a tally chart — and the
    // benchmark that wants a tally chart already has one. Only offer this
    // shape where a real scale is warranted.
    //
    const per = o.per || SCALES.find(p => max / p <= 10);
    if (!per) return null;

    // ⚠ A ROW SMALLER THAN HALF THE KEY CANNOT BE DRAWN HONESTLY.
    // Two visits against a key of ten is a fifth of a bird; drawn as the
    // smallest mark available — half a bird — it reads as five, and a class
    // counting carefully gets the wrong answer BECAUSE they counted
    // carefully. Those rows come off the chart and the caption says how
    // many, which is what a teacher drawing this on the board would do.
    const kept = rows.filter(r => r.value >= per / 2);
    const dropped = rows.length - kept.length;
    if (kept.length < 2) return null;
    rows = kept;

    rows.forEach((r, i) => {
        if (!r.color) r.color = cmRowColor(r, i, rows.length, 'spectrum');
    });

    return { kind: 'picto', per, series: rows,
             // What the SYMBOLS add up to, row by row — see the note at the
             // `plotted` check in buildClassroomQuestions. Without this the
             // true counts are printed over a chart that is drawing
             // something slightly different.
             plotted: rows.map(r => ({
                 value: Math.round((r.value / per) * 2) / 2 * per })),
             caption: dropped
                ? `${caption} (${dropped} rarer bird${dropped === 1 ? '' : 's'} `
                  + `left off — too few to draw at this scale)`
                : caption,
             showValues: !!o.showValues, highlight: o.highlight || null,
             max, total: rows.reduce((a, r) => a + r.value, 0) };
}

function classroomPictoHtml(chart, revealed) {
    const rows = chart.series.map(s => {
        const on    = chart.highlight && s.key === chart.highlight;
        // Rounded to the nearest HALF symbol, because half a bird is the
        // only fraction this chart can draw. Three quarters of the way to
        // the next bird is drawn as a whole one, not as a half — 99 visits
        // against a key of ten is ten birds, and showing nine and a half
        // would be further from the truth, not closer to it.
        const units = Math.round((s.value / chart.per) * 2) / 2;
        const whole = Math.floor(units);
        const rest  = units - whole;

        // The same masked bird silhouette the tally chart uses, so the two
        // charts are visibly the same KIND of thing and only the key differs
        // — which is exactly the step from MA.1.DP.1.1 to MA.3.DP.1.1.
        let icons = '';
        for (let i = 0; i < whole; i++) {
            icons += `<span class="cc-dot" style="background:${s.color}"></span>`;
        }
        if (rest) {
            icons += `<span class="cc-dot half" style="background:${s.color}"></span>`;
        }

        return `
            <div class="cc-row${on ? ' on' : ''}">
                <span class="cc-row-head">
                    ${s.image ? `<span class="cc-thumb"><img src="${esc(s.image)}" alt=""></span>` : ''}
                    <span class="cc-row-label">${esc(s.label)}</span>
                </span>
                <span class="cc-dots">${icons || '<span class="cc-none">none</span>'}</span>
                ${revealed ? `<span class="cc-row-val">${s.value}</span>` : ''}
            </div>`;
    }).join('');

    return `
        <figure class="classroom-chart dots picto${chart.series.some(x => x.image) ? ' with-photos' : ''}">
            <div class="cc-key">
                <span class="cc-dot"></span>
                = ${chart.per} visit${chart.per === 1 ? '' : 's'}
            </div>
            <div class="cc-rows">${rows}</div>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

/**
 * A scatter plot of two numbers measured on the same days.
 *
 * MA.8.DP.1.2 asks a class to DESCRIBE a pattern of association, so the
 * plot must be able to show that there isn't one. No trend line is drawn
 * unless the caller asks for it, and `fit` is deliberately the caller's
 * decision: a line through a cloud with no association is the single most
 * misleading thing this file could draw.
 *
 * Axes both start at a sensible floor rather than at zero. A temperature
 * axis from 0°F squashes a week that ran 38-54°F into the bottom third and
 * hides exactly the spread the question is about.
 */
function cmScatter(caption, points, opts) {
    const o = opts || {};
    const pts = (points || []).filter(p => p && isFinite(p.x) && isFinite(p.y));
    if (pts.length < 5) return null;

    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    // All of one value on either axis is not bivariate data.
    if (xMax === xMin || yMax === yMin) return null;

    let fit = null;
    if (o.fit) {
        const n = pts.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, den = 0;
        pts.forEach(p => { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; });
        if (den > 0) fit = { slope: num / den, intercept: my - (num / den) * mx };
    }

    return { kind: 'scatter', caption, points: pts, fit,
             // ⚠ EVERY CHART MUST CARRY `series`. buildClassroomQuestions
             // reads chart.series.map to decide whether printing the values
             // would answer the question, OUTSIDE the per-template try/catch
             // — so a chart without it does not lose its question, it takes
             // the whole lesson down. These are the plotted y-values, which
             // is exactly what that check is looking for.
             series: pts.map(p => ({ label: String(p.x), value: p.y, key: String(p.x) })),
             xLabel: o.xLabel || '', yLabel: o.yLabel || '',
             xMin, xMax, yMin, yMax,
             // Held back until the reveal: on "is there a pattern here?"
             // the line IS the answer.
             revealFit: !!o.revealFit, showValues: !!o.showValues };
}

function classroomScatterHtml(chart, revealed) {
    const W = 1000, H = 560;
    const padL = 92, padR = 36, padT = 28, padB = 96;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    // A tenth of the range of padding on each side, so no point is drawn
    // sitting on an axis where half of it is clipped.
    const padX = (chart.xMax - chart.xMin) * 0.1 || 1;
    const padY = (chart.yMax - chart.yMin) * 0.1 || 1;
    const x0 = chart.xMin - padX, x1 = chart.xMax + padX;
    const y0 = Math.max(0, chart.yMin - padY), y1 = chart.yMax + padY;

    const X = v => padL + ((v - x0) / (x1 - x0)) * plotW;
    const Y = v => padT + plotH - ((v - y0) / (y1 - y0)) * plotH;

    const yStep = cmNiceStep(y1 - y0);
    const xStep = cmNiceStep(x1 - x0);

    let grid = '';
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
        grid += `<line x1="${padL}" y1="${Y(v).toFixed(1)}" x2="${W - padR}" y2="${Y(v).toFixed(1)}"
                       class="cc-grid"></line>
                 <text x="${padL - 14}" y="${(Y(v) + 7).toFixed(1)}" class="cc-axis end">${v}</text>`;
    }
    for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1; v += xStep) {
        grid += `<line x1="${X(v).toFixed(1)}" y1="${padT}" x2="${X(v).toFixed(1)}" y2="${padT + plotH}"
                       class="cc-grid"></line>
                 <text x="${X(v).toFixed(1)}" y="${padT + plotH + 34}" class="cc-axis mid">${v}</text>`;
    }

    const dots = chart.points.map(p => `
        <circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="11"
                fill="${p.color || 'var(--color-primary)'}" class="cc-pt"></circle>
        ${revealed && p.label
            ? `<text x="${X(p.x).toFixed(1)}" y="${(Y(p.y) - 18).toFixed(1)}"
                     class="cc-val mid">${esc(p.label)}</text>` : ''}`).join('');

    // The line only when the question has been answered, if the template
    // said so — see cmScatter's header.
    const showFit = chart.fit && (!chart.revealFit || revealed);
    const line = showFit ? (() => {
        const ya = chart.fit.intercept + chart.fit.slope * x0;
        const yb = chart.fit.intercept + chart.fit.slope * x1;
        return `<line x1="${X(x0).toFixed(1)}" y1="${Y(ya).toFixed(1)}"
                      x2="${X(x1).toFixed(1)}" y2="${Y(yb).toFixed(1)}"
                      class="cc-fit"></line>`;
    })() : '';

    return `
        <figure class="classroom-chart scatter">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${grid}
                <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="cc-axis-line"></line>
                <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="cc-axis-line"></line>
                ${line}
                ${dots}
                <text x="${padL + plotW / 2}" y="${H - 18}" class="cc-axis-title mid">${esc(chart.xLabel)}</text>
                <text x="26" y="${padT + plotH / 2}" class="cc-axis-title mid"
                      transform="rotate(-90 26 ${padT + plotH / 2})">${esc(chart.yLabel)}</text>
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

/**
 * A box plot of one set of numbers.
 *
 * Quartiles by the method Florida's materials use — the median of each
 * half, with the overall median excluded from both halves when the count
 * is odd. There are several defensible definitions and they disagree on
 * small sets; picking a different one would mark a correctly-worked answer
 * wrong, which is the worst thing a question can do.
 *
 * The raw values are kept on the chart so the reveal can show the dots
 * under the box. A box plot is the one chart where a class cannot check
 * the summary against the data unless we show them both.
 */
function cmBoxPlot(caption, values, opts) {
    const o = opts || {};
    const v = (values || []).filter(x => isFinite(x)).slice().sort((a, b) => a - b);
    if (v.length < 5) return null;

    const med = arr => {
        const m = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
    };
    const half = Math.floor(v.length / 2);
    const lower = v.slice(0, half);
    const upper = v.slice(v.length % 2 ? half + 1 : half);

    const five = { min: v[0], q1: med(lower), med: med(v), q3: med(upper), max: v[v.length - 1] };
    // A box with no width teaches nothing and has no quartiles to read.
    if (five.q1 === five.q3) return null;

    return { kind: 'box', caption, five, values: v,
             // The five-number summary, not the raw values: those ARE the
             // answers to the box-plot question, so this is what must stop
             // the values being printed before the reveal. See the note in
             // cmScatter about why `series` is not optional.
             series: [five.min, five.q1, five.med, five.q3, five.max]
                 .map(x => ({ label: String(x), value: x, key: String(x) })),
             xLabel: o.xLabel || '', showValues: !!o.showValues };
}

function classroomBoxHtml(chart, revealed) {
    const W = 1000, H = 372;
    const padL = 60, padR = 60, padT = 48, padB = 124;
    const plotW = W - padL - padR;
    const f = chart.five;

    const span = (f.max - f.min) || 1;
    const lo = f.min - span * 0.12, hi = f.max + span * 0.12;
    const X = v => padL + ((v - lo) / (hi - lo)) * plotW;

    const boxTop = padT + 24, boxH = 92, mid = boxTop + boxH / 2;

    const step = cmNiceStep(hi - lo);
    let grid = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        grid += `<line x1="${X(v).toFixed(1)}" y1="${padT}" x2="${X(v).toFixed(1)}" y2="${boxTop + boxH + 26}"
                       class="cc-grid"></line>
                 <text x="${X(v).toFixed(1)}" y="${boxTop + boxH + 58}" class="cc-axis mid">${v}</text>`;
    }

    // The data itself, under the box. Jittered vertically so repeated
    // values do not stack into a single dot and make the set look smaller
    // than it is.
    const dots = chart.values.map((v, i) => `
        <circle cx="${X(v).toFixed(1)}" cy="${(boxTop + boxH + 12 + (i % 3) * 5).toFixed(1)}"
                r="5" class="cc-pt-faint"></circle>`).join('');

    // ⚠ THE FIVE MARKS COLLIDE, and on a tight distribution they always
    // will — min and Q1 sitting four visits apart rendered as "miQ1 6.5",
    // which is not a near miss, it is two numbers eaten by each other.
    //
    // Two bands rather than one: the quartiles and median above the box,
    // the extremes below the dots, which also matches where each mark
    // actually is. Within a band, a label too close to the one before it
    // drops to a second line instead of overprinting. Nothing is omitted —
    // a five-number summary with a number quietly missing would be a
    // worse chart than one with a crowded label.
    const LABEL_W = 110;
    const band = (items, baseY, dy) => {
        let lastX = -Infinity, low = false;
        return items.map(([v, label]) => {
            const x = X(v);
            low = (x - lastX < LABEL_W) ? !low : false;
            lastX = x;
            return `<text x="${x.toFixed(1)}" y="${baseY + (low ? dy : 0)}"
                          class="cc-val mid">${label} ${v}</text>`;
        }).join('');
    };

    const marks = revealed
        ? band([[f.q1, 'Q1'], [f.med, 'med'], [f.q3, 'Q3']], padT + 14, -30)
        + band([[f.min, 'min'], [f.max, 'max']], boxTop + boxH + 86, 30)
        : '';

    return `
        <figure class="classroom-chart box">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${grid}
                ${dots}
                <line x1="${X(f.min).toFixed(1)}" y1="${mid}" x2="${X(f.q1).toFixed(1)}" y2="${mid}" class="cc-whisker"></line>
                <line x1="${X(f.q3).toFixed(1)}" y1="${mid}" x2="${X(f.max).toFixed(1)}" y2="${mid}" class="cc-whisker"></line>
                <line x1="${X(f.min).toFixed(1)}" y1="${boxTop + 18}" x2="${X(f.min).toFixed(1)}" y2="${boxTop + boxH - 18}" class="cc-whisker"></line>
                <line x1="${X(f.max).toFixed(1)}" y1="${boxTop + 18}" x2="${X(f.max).toFixed(1)}" y2="${boxTop + boxH - 18}" class="cc-whisker"></line>
                <rect x="${X(f.q1).toFixed(1)}" y="${boxTop}"
                      width="${(X(f.q3) - X(f.q1)).toFixed(1)}" height="${boxH}"
                      class="cc-box"></rect>
                <line x1="${X(f.med).toFixed(1)}" y1="${boxTop}" x2="${X(f.med).toFixed(1)}" y2="${boxTop + boxH}" class="cc-med"></line>
                ${marks}
                <text x="${padL + plotW / 2}" y="${H - 14}" class="cc-axis-title mid">${esc(chart.xLabel)}</text>
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

/**
 * A clock face showing when the birds came.
 *
 * Design notes section 11 asks for exactly this for K-2: telling the time
 * from detection timestamps on an analog clock. It is the one chart here that
 * teaches something other than reading a chart, and a class that has to find
 * eight o'clock on a dial to answer is practising the dial, not the data.
 *
 * Twelve positions, so morning and afternoon land on the same mark. That is a
 * property of real clocks and not a thing to paper over, so the two are drawn
 * in different colors with a legend, which is also the honest way to show a
 * feeder that is busy at 8am and quiet at 8pm.
 */
function classroomClockHtml(chart, withValues, revealed) {
    // Two clocks, not one.
    //
    // `hands` draws a real clock reading a real time and nothing else: the
    // question is "what time is this?", which is the thing a K-2 class is
    // actually learning. Flagged exactly so: "for this grade it would be
    // better to show the hands of the clock and ask them what time; having
    // bubbles outside the clock will confuse them." Quite right — the blob
    // version asks the class to find the biggest circle, and finding the
    // biggest circle is not telling the time.
    //
    // Without `hands` it is the distribution chart the older bands get, one
    // blob per hour sized by how busy it was.
    const hands = chart.hands;

    // The same flag's first half: "the bubbles of frequency fall off the
    // screen." They did. A blob sits (R + 46) out with a radius up to 42, so
    // the drawing reaches 258 below center while the canvas was 460 tall
    // with its center at 240 — the bottom blob was cut in half by the edge.
    // Height now follows from that reach rather than being a guess.
    const W = 1000;
    const H = hands ? 420 : 560;
    const cx = W / 2, cy = H / 2 + 10, R = 170;

    // Hour marks and the numbers 1-12.
    let face = `<circle cx="${cx}" cy="${cy}" r="${R}" class="cc-clock-face"/>`;
    for (let h = 1; h <= 12; h++) {
        const a = (h / 12) * Math.PI * 2 - Math.PI / 2;
        face += `<text x="${(cx + (R - 38) * Math.cos(a)).toFixed(1)}"
                       y="${(cy + (R - 38) * Math.sin(a) + 11).toFixed(1)}"
                       class="cc-clock-num" text-anchor="middle">${h}</text>`;
        // A tick at every minute, five of them heavy, so a class counting
        // round the dial has something to count.
        for (let m = 0; m < 5; m++) {
            const t = ((h * 5 + m) / 60) * Math.PI * 2 - Math.PI / 2;
            const inner = m === 0 ? R - 16 : R - 8;
            face += `<line x1="${(cx + inner * Math.cos(t)).toFixed(1)}"
                           y1="${(cy + inner * Math.sin(t)).toFixed(1)}"
                           x2="${(cx + R * Math.cos(t)).toFixed(1)}"
                           y2="${(cy + R * Math.sin(t)).toFixed(1)}"
                           class="cc-clock-tick${m === 0 ? ' big' : ''}"/>`;
        }
    }

    // Hands and pin as one piece, because two clocks now draw them: the K-2
    // dial from the start, and the blob clock once its answer is revealed.
    const handsSvg = spec => {
        const hour24 = Number(spec.hour != null ? spec.hour : spec);
        const minute = Number(spec.minute || 0);
        const ha = ((hour24 % 12) + minute / 60) / 12 * Math.PI * 2 - Math.PI / 2;
        const ma = (minute / 60) * Math.PI * 2 - Math.PI / 2;
        const hand = (ang, len, cls) =>
            `<line x1="${cx}" y1="${cy}"
                   x2="${(cx + len * Math.cos(ang)).toFixed(1)}"
                   y2="${(cy + len * Math.sin(ang)).toFixed(1)}" class="${cls}"/>`;
        return hand(ma, R * 0.80, 'cc-clock-hand minute')
             + hand(ha, R * 0.52, 'cc-clock-hand hour')
             + `<circle cx="${cx}" cy="${cy}" r="10" class="cc-clock-pin"/>`;
    };

    if (hands) {
        return `
        <figure class="classroom-chart clock">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${face}
                ${handsSvg(hands)}
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
    }

    // One blob per hour that had birds, out beyond the numbers, sized by how
    // busy that hour was. Size rather than color carries the quantity,
    // because color is already carrying am/pm.
    const blobs = chart.series.map(s => {
        const hour24 = s.hour != null ? s.hour : parseInt(s.key, 10);
        if (!isFinite(hour24)) return '';
        const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
        const a = (h12 / 12) * Math.PI * 2 - Math.PI / 2;
        const r = 16 + (s.value / chart.max) * 26;
        const bx = cx + (R + 46) * Math.cos(a);
        const by = cy + (R + 46) * Math.sin(a);
        const on = chart.highlight && s.key === chart.highlight;
        const am = hour24 < 12;
        return `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${r.toFixed(1)}"
                        fill="${am ? '#fbbf24' : '#60a5fa'}"
                        class="cc-clock-blob${on ? ' on' : ''}"/>`
             + (withValues
                 ? `<text x="${bx.toFixed(1)}" y="${(by + 9).toFixed(1)}"
                          class="cc-clock-val" text-anchor="middle">${s.value}</text>`
                 : '');
    }).join('');

    return `
        <figure class="classroom-chart clock">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${face}
                ${blobs}
                ${revealed && chart.revealHands ? handsSvg(chart.revealHands) : ''}
                <circle cx="60" cy="34" r="14" fill="#fbbf24"/>
                <text x="86" y="42" class="cc-label" text-anchor="start">morning</text>
                <circle cx="260" cy="34" r="14" fill="#60a5fa"/>
                <text x="286" y="42" class="cc-label" text-anchor="start">afternoon</text>
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
}

// Long species names have to stop somewhere on a fixed canvas.
function cmShorten(text, max) {
    return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * The clip a question should use. Confidence floor as for photos — a
 * misidentified clip teaches the wrong bird — and, where the feeder has a
 * choice, a different bird from the photo question, so a class does not
 * meet the same cardinal twice in its first two slides.
 */
function cmPickClip(s, rng) {
    const good = s.clips.filter(r => cmConfPct(r) >= CM_CONF_LABEL);
    if (!good.length) return null;
    const photo = s.snapshots.find(r => cmConfPct(r) >= CM_CONF_LABEL && SPECIES_FACTS[r.species])
               || s.snapshots.find(r => cmConfPct(r) >= CM_CONF_LABEL);
    const other = good.filter(r => !photo || r.species !== photo.species);
    const pool = (other.length ? other : good).slice(0, 6);
    return cmShuffle(pool, rng)[0];
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
    bands: ['k-2', '3-5'],
    build({ s, band, rng, feeder }) {
        // Confidence floor: a misidentified snapshot teaches the wrong bird,
        // and the model is the only thing standing behind the "right" answer.
        // This floor was written `>= 0.65` against a figure the detector
        // reports from 0 to 100, so it admitted everything, including the
        // 36%-confident guesses - in the question that puts a photograph on
        // a projector and tells a six-year-old what bird it is.
        const shot = s.snapshots.find(r => cmConfPct(r) >= CM_CONF_LABEL && SPECIES_FACTS[r.species])
                  || s.snapshots.find(r => cmConfPct(r) >= CM_CONF_LABEL);
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
            // "our feeder" only when it IS our feeder. On a quiet week the
            // data comes from a partner, and the amber badge saying so is
            // small print a six-year-old will not read — the prompt is the
            // sentence the teacher says out loud, so it has to be the one
            // that is true.
            prompt: band === 'k-2'
                ? (s.isHome ? 'Which bird came to our feeder?'
                            : `Which bird came to ${feeder}?`)
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

// ── Clips ───────────────────────────────────────────────
//
// A feeder that records clips has something a photo cannot give a class:
// the bird MOVING — how it lands, how it eats, how often it looks up. Two
// questions use them, and they are deliberately different kinds of question.
//
// "Which bird is this?" has a right answer, and it is the detection's own
// species, exactly as the photo question's is.
//
// "What is it doing?" does NOT, and is not pretended to. Nothing records
// what a bird was doing in a clip — the camera knows the species, not the
// behaviour — so any "right answer" would be one this file made up. It is a
// poll: the class watches, votes, and the reveal says there is no single
// answer and asks whether everyone saw the same thing. Noticing is the
// lesson; a wrong mark for having noticed something different would teach
// the opposite.

{
    id: 'clip-which-bird',
    category: 'identification',
    title: 'Watch the clip',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng, feeder }) {
        const clip = cmPickClip(s, rng);
        if (!clip) return null;

        // Distractors as the photo question draws them: this feeder's own
        // visitors first, so the clip has to be watched rather than the
        // options merely recognised.
        const others = s.species.map(x => x.species).filter(sp => sp !== clip.species);
        const want   = band === 'k-2' ? 2 : 3;
        const pool   = cmShuffle(others, rng).concat(
            cmShuffle(COMMON_FEEDER_SPECIES.filter(
                sp => sp !== clip.species && !others.includes(sp)), rng));
        const built  = cmChoices(clip.species, pool.slice(0, want), rng);
        if (!built) return null;

        const when = new Date(clip.detected_at);
        return {
            prompt: band === 'k-2' ? 'Watch the video. Which bird is it?'
                                   : 'Watch the clip. Which species is this?',
            ...built,
            // The species name is burned into the bottom of the clip, as it
            // is on every snapshot — so the caption is cropped until the
            // reveal, the same as the photo question.
            video: { url: clip.video_url, poster: clip.image_url || '', crop: true },
            explain: `${clip.species}, filmed at ${feeder} on `
                   + `${when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}`
                   + ` at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`,
            fact: speciesFact(clip.species, band),
            detection_id: clip.id,
        };
    },
},

{
    id: 'clip-what-doing',
    category: 'science',
    title: 'What is it doing?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng }) {
        const clip = cmPickClip(s, rng);
        if (!clip) return null;

        // Fixed order, not shuffled: with no right answer there is no
        // pattern to give away, and "Something else" belongs last.
        const opts = band === 'k-2'
            ? ['Eating', 'Looking around', 'Flying away']
            : ['Eating', 'Watching for danger', 'Flying in or out', 'Something else'];

        return {
            prompt: band === 'k-2'
                ? 'Watch the bird. What is it doing most of the time?'
                : 'Watch closely. What does the bird spend most of the clip doing?',
            choices: opts.map(label => ({ label })),
            correct_index: null,
            poll: true,
            // Uncropped: the question is about the bird's behaviour, and
            // its name on the screen gives none of that away.
            video: { url: clip.video_url, poster: clip.image_url || '', crop: false },
            // The reveal's heading already says there is no right answer, so
            // this goes straight to the conversation it is for.
            explain: 'Did everyone see the same thing? Watch it again and look for '
                   + 'how often it stops to look up.',
            detection_id: clip.id,
            about_bird: SPECIES_LOOKS[clip.species] ? clip.species : null,
        };
    },
},

// ── 2. Counting ──────────────────────────────────────────
{
    id: 'most-common-week',
    category: 'counting',
    title: 'Which bird visited most?',
    bands: ['k-2', '3-5'],
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
    bands: ['k-2', '3-5'],
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
            //
            // Values ON here but NOT in the K-2 branch above. Here the answer
            // is the sum, so printing the numbers makes it the addition it is
            // meant to be; up there the answer is one highlighted day, and
            // printing it on the bar would simply be the answer.
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s),
                           { band, showValues: true }),
            explain: `${s.total} visits across ${s.days.length} day${s.days.length === 1 ? '' : 's'}.`,
        };
    },
},
{
    id: 'species-variety',
    category: 'counting',
    title: 'How many kinds of bird?',
    bands: ['3-5'],
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
                           cmSpeciesSeries(s, CHART_MAX_BARS), { band, showValues: true }),
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
    bands: ['3-5'],
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
                           { band, showValues: true }),
            explain: `${a.n} − ${b.n} = ${diff}.`,
        };
    },
},
{
    // Asked for by a Roland Park teacher: "Questions that compare how many
    // more on one day then another". That question already existed — but as
    // `day-difference`, which is 3–5 only, so a K-2 class never met it.
    //
    // This is a SEPARATE template rather than 'k-2' added to that one, because
    // the 3–5 version is deliberately built to defeat the shortcut a six-year-
    // old needs: it picks two MIDDLING days precisely so the only route is
    // reading the axis. Here both days are NAMED in the prompt and their
    // values are printed on the bars, so no searching is involved — the
    // exercise is the subtraction and nothing else.
    //
    // Which is why the pair is chosen by ARITHMETIC rather than by position.
    // Anchoring on busiest-versus-quietest reads well but fails on a busy
    // feeder: at around forty visits a day that gap is almost always wider
    // than ten, and the question simply never builds — measured at 9% of
    // weeks, against 96% on a feeder doing six a day. A teacher at a busy
    // school would have gone on never seeing the thing she asked for.
    //
    // So: keep the tallest bar, and walk outward for the furthest day that
    // still leaves a countable answer. A six-year-old asked for 31 − 12 is
    // being tested on something this slide is not for.
    id: 'day-difference-k2',
    category: 'comparison',
    title: 'How many more on the busy day?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        if (s.days.length < 3) return null;

        const sorted = s.days.slice().sort((x, y) => y.n - x.n);

        // ⚠ ANY PAIR, NOT JUST PAIRS WITH THE BUSIEST DAY. This used to
        // pin the first day to sorted[0] and hunt for a partner within
        // ten of it — and on a real week running 0, 15, 19, 30, 36, 53
        // nothing is within ten of 53, so the question never built. The
        // prompt names both days anyway, so there is no reason the first
        // one has to be the busiest.
        //
        // Busiest pair first, then the largest countable gap inside it:
        // a big difference between two tall bars is easier to see across
        // a room than a small one between two short ones.
        let a = null, b = null;
        outer:
        for (let i = 0; i < sorted.length - 1; i++) {
            for (let j = sorted.length - 1; j > i; j--) {
                const d = sorted[i].n - sorted[j].n;
                if (d >= 2 && d <= 10) { a = sorted[i]; b = sorted[j]; break outer; }
            }
        }
        if (!a || !b) return null;

        const diff = a.n - b.n;

        const built = cmChoices(String(diff),
                                cmNumberDistractors(diff, rng, 3).map(String), rng);
        if (!built) return null;

        return {
            prompt: `How many more visits were there on ${cmDayAxisLabel(a.day)} `
                  + `than on ${cmDayAxisLabel(b.day)}?`,
            ...built,
            // showValues so the two numbers are on the bars to be subtracted.
            // Without them this becomes a bar-height estimation question,
            // which is the 3–5 skill and not this one.
            chart: cmChart('Visits each day this week', cmDaySeries(s),
                           { band, showValues: true }),
            explain: `${a.n} − ${b.n} = ${diff}.`,
        };
    },
},
{
    id: 'week-over-week',
    category: 'comparison',
    title: 'Busier than last week?',
    bands: ['6-8'],
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
    bands: ['k-2', '3-5'],
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
            // Same label the chart uses. They were "Sunday, Nov 8" and
            // "yesterday" while the bars beside them said "Sun 8", so a class
            // reading the chart then looking for that bar in the options
            // found neither of them written the same way.
            choices: opts.map(d => ({ label: cmDayAxisLabel(d.day) })),
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
    bands: ['3-5'],
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
                                   .filter(x => x.value > 0), { band, maxBars: 14 }),
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

        // Two thirds and three quarters were missing, and a real week sat
        // at 63% — nearest band half, 13 points away, so the question
        // refused rather than saying "about two thirds". Both are
        // ordinary 3-5 fractions and their absence was the only reason
        // this never built.
        const bands = [
            { label: 'about a tenth',        v: 0.1  },
            { label: 'about a quarter',      v: 0.25 },
            { label: 'about a third',        v: 0.33 },
            { label: 'about half',           v: 0.5  },
            { label: 'about two thirds',     v: 0.67 },
            { label: 'about three quarters', v: 0.75 },
            { label: 'nearly all of them',   v: 0.9  },
        ];
        const near = bands.slice().sort((a, b) =>
            Math.abs(a.v - share) - Math.abs(b.v - share));
        const best = near[0];
        // Only ask when ONE band is clearly the right one, which now takes
        // two guards rather than one. The band has to be close — and, since
        // a quarter and a third are only eight points apart, the runner-up
        // has to be clearly further away as well. A share of 29% is near
        // enough to a third to pass the first guard and just as near to a
        // quarter, and a class arguing over which is closer is arguing
        // about the question rather than about the birds.
        if (Math.abs(best.v - share) > 0.09) return null;
        if (Math.abs(near[1].v - share) - Math.abs(best.v - share) < 0.06) return null;

        // Three distractors, nearest first: the near misses are where the
        // thinking is. Seven options on a projector is a reading test.
        const built = cmChoices(best.label, near.slice(1, 4).map(b => b.label), rng);
        if (!built) return null;

        return {
            prompt: `About what fraction of this week's visits were ${top.species}?`,
            ...built,
            // The named species is marked: the comparison is that bar against
            // the rest, and the answer is a ratio, not a bar.
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s), { band, highlight: top.species, showValues: true }),
            explain: `${top.n} of ${s.total} visits — that's ${Math.round(share * 100)}%, `
                   + `so ${best.label}. Counting every bird is the slow way to see that; `
                   + `looking at whether one bar is taller than all the others put together `
                   + `is the fast way.`,
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
                           cmSpeciesSeries(s), { band, highlight: top.species, showValues: true }),
            explain: `${top.n} ÷ ${s.total} = ${(top.n / s.total).toFixed(2)} → ${pct}%.`,
        };
    },
},
{
    id: 'visits-per-day',
    category: 'math',
    title: 'Average visits per day',
    bands: ['3-5'],
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
            chart: cmChart(`Visits each day at ${feeder}`, cmDaySeries(s), { band, showValues: true }),
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
            // Temperature is carried by the BAR'S COLOR \u2014 not a second axis,
            // and not the label.
            //
            // Height is visits, color is temperature, so a single mark holds
            // both variables and the chart gains no extra furniture. Cold
            // blue to warm red is the one ramp nearly everybody reads without
            // a legend, so the relationship the question actually asks about
            // \u2014 do the warm days have the taller bars? \u2014 is visible before
            // anyone has read a number.
            //
            // The degrees stay in small type under each date. Once color is
            // carrying the PATTERN, the number is supporting detail rather
            // than something that has to be decoded, and a 6\u20138 class needs
            // the real values to justify an answer.
            chart: cmChart('Visits each day \u2014 bar color is that day\u2019s temperature',
                           days.slice().sort((x, y) => x.day.localeCompare(y.day))
                               .map(d => ({
                                   label: cmDayAxisLabel(d.day),
                                   sub: `${Math.round(d.temp)}\u00b0`,
                                   value: d.n, key: d.day,
                                   color: cmHeatColor(
                                       (d.temp - days[0].temp)
                                       / Math.max(1, days[days.length - 1].temp - days[0].temp)),
                               })), { band, kind: 'bars' }),
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
    bands: ['k-2', '3-5'],
    build({ s, band, rng, feeder, source }) {
        // Asked before the feeder has done anything today, "more than today"
        // is a formality rather than a prediction - so this used to refuse.
        // But a feeder that has done nothing yet today is what EVERY morning
        // class sees, which meant the question refused the lessons it was
        // written for and ran only for the afternoon ones. It now predicts
        // forward from the last day that actually has a count: today by the
        // afternoon, yesterday at registration. Predicting today from
        // yesterday is the better lesson of the two anyway, because the class
        // finds out before home time instead of waiting a night for it.
        const todayKey = cmDayKey(new Date());
        const todayN   = s.byDay.get(todayKey) || 0;
        let baseKey = todayKey, baseN = todayN;
        if (todayN < 3) {
            const prior = s.days.filter(d => d.day < todayKey && d.n >= 3).pop();
            if (!prior) return null;
            baseKey = prior.day; baseN = prior.n;
        }
        const baseIsToday = baseKey === todayKey;
        const aheadKey = cmDayKey(new Date(cmDayStart(baseKey).getTime() + 86400000));
        const ahead = aheadKey === todayKey ? 'today' : 'tomorrow';
        // "More than then" is not English. When the comparison day is not
        // today the prompt has already named it, so the choices carry the
        // direction alone rather than pointing back at a word.
        const opts = cmShuffle(baseIsToday
            ? ['More than today', 'Fewer than today', 'About the same']
            : ['More', 'Fewer', 'About the same'], rng);
        const lead = baseIsToday
            ? `Today ${feeder} had ${baseN} bird visits.`
            : `On ${cmDayProse(baseKey)} ${feeder} had ${baseN} bird visits.`;

        return {
            prompt: band === 'k-2'
                ? `${lead} Will ${ahead} have more or fewer?`
                : `${lead} Will ${ahead} have more, fewer, or about the same?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: null,            // not knowable yet
            explain: ahead === 'today'
                ? 'We will check this before the end of today.'
                : 'We will check this at the start of the next class.',
            // The run-up, with today marked AND tomorrow drawn as an empty
            // slot. A prediction chart that stops at today asks the class to
            // imagine the thing they are predicting; showing it as a dashed
            // box with a question mark puts it on the axis where it belongs,
            // and makes plain that the answer does not exist yet.
            chart: cmChart(`Visits each day at ${feeder}`,
                           cmDaySeries(s).filter(d => d.key <= baseKey).concat([{
                               label: cmDayAxisLabel(aheadKey),
                               value: 0, key: aheadKey, pending: true,
                           }]),
                           { band, highlight: baseKey, ordered: true, kind: 'bars' }),
            pending_check: {
                kind: 'visits_on_day',
                feeder_id: source.feederId,
                day: aheadKey,
                baseline: baseN,
                labels: opts,
            },
            // End of the day being predicted, local time - the earliest
            // moment the count is final rather than half a day's worth.
            resolve_after: new Date(cmDayStart(aheadKey).getTime() + 86400000).toISOString(),
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
        //
        // The estimate sits in the MIDDLE of a band, not on its edge. It used
        // to be an edge, which produced this flag: "shouldn't it be 21? 7
        // days at 3 per day" - the class does the multiplication, gets 21,
        // and finds 21 sitting at the bottom of a range rather than inside
        // one. The arithmetic is right and the chart was making it look
        // wrong.
        const edges = [Math.round(est - step / 2),
                       Math.round(est + step / 2),
                       Math.round(est + step * 1.5)];
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
            prompt: `${feeder} has averaged about ${Math.round(perDay)} visits a day `
                  + 'this week. If that average holds, how many visits will it get '
                  + 'over the NEXT 7 days?',
            choices: opts.map(b => ({ label: b.label })),
            correct_index: null,
            explain: `${Math.round(perDay)} visits a day \u00d7 7 days = about `
                   + `${est}, so that is the band to beat. Real weeks wander, `
                   + 'which is why this is a prediction and not a sum. Write down '
                   + 'what the class picked - we will count the real total in 7 '
                   + 'days and see who was closest.',
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

// ── Added to pull the bands apart ────────────────────────────────
//
// Before these, 3–5 and 6–8 shared eleven of their twelve templates: the
// older class was sitting the younger one's lesson with the wording changed.
// The design notes are specific about what 6–8 is for — weekday against
// weekend, mean against median, rates, probability, weather against visits —
// and almost none of it existed. These are that, plus one each for the other
// two bands so neither runs short once the sharing stops.

{
    id: 'count-one-species',
    category: 'counting',
    title: 'How many of one bird?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // A single species, small enough to count as dots. The whole question
        // for a five-year-old is "point at that bird's row and count it".
        const pick = s.species.find(x => x.n >= 3 && x.n <= 20);
        if (!pick || s.species.length < 2) return null;

        // Horizontal, so a species name sits beside its bar instead of being
        // wrapped under a narrow column next to its photograph. Flagged
        // exactly that way: "the text under the image is too crowded with
        // the other images. It might be better to have the Y-Axis be the
        // bird types and the x-axis be the # of visits."
        const chart = cmChart('Visits by species this week', cmSpeciesSeries(s),
                              { band, kind: 'hbars', highlight: pick.species });
        const built = cmChartCountChoices(pick.n, rng, chart, 2);
        if (!built) return null;
        return {
            prompt: `How many ${pick.species}s came this week?`,
            ...built,
            chart,
            explain: `${pick.species}: ${pick.n} visits this week.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'day-difference',
    category: 'comparison',
    title: 'Difference between two days',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Read two bars off the chart and subtract. Not the busiest and the
        // quietest — those are findable without reading values — but two
        // middling days, so the only route is the axis.
        if (s.days.length < 4) return null;
        const sorted = s.days.slice().sort((a, b) => b.n - a.n);
        const a = sorted[1], b = sorted[sorted.length - 2];
        if (!a || !b || a.n - b.n < 2) return null;

        const diff = a.n - b.n;
        const built = cmChoices(String(diff),
                                cmNumberDistractors(diff, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many more visits were there on ${cmDayAxisLabel(a.day)} `
                  + `than on ${cmDayAxisLabel(b.day)}?`,
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `${a.n} − ${b.n} = ${diff}.`,
        };
    },
},

{
    id: 'weekday-weekend',
    category: 'analysis',
    title: 'Weekdays or the weekend?',
    bands: ['6-8'],
    build({ s, band, rng, feeder }) {
        // Design notes §2, the 6–8 list, almost word for word. The chart shows
        // every day UNGROUPED, so the class has to sort them itself — which is
        // the entire exercise.
        const week = [], end = [];
        for (const d of s.days) {
            const dow = cmDayStart(d.day).getDay();
            (dow === 0 || dow === 6 ? end : week).push(d.n);
        }
        if (week.length < 3 || end.length < 2) return null;

        const avg = arr => arr.reduce((x, y) => x + y, 0) / arr.length;
        const wAvg = avg(week), eAvg = avg(end);
        // A difference smaller than half a visit a day is noise, and asking
        // the class to call it is teaching them to over-read a chart.
        if (Math.abs(wAvg - eAvg) < 0.5) return null;

        const answer = wAvg > eAvg ? 'Weekdays' : 'The weekend';
        const opts = cmShuffle(['Weekdays', 'The weekend', 'About the same'], rng);
        return {
            prompt: `Did ${feeder} average more visits per day on weekdays or at the weekend?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band }),
            explain: `Weekdays averaged ${wAvg.toFixed(1)} visits a day across ${week.length} days; `
                   + `the weekend averaged ${eAvg.toFixed(1)} across ${end.length}.`,
        };
    },
},

{
    id: 'median-daily',
    category: 'math',
    title: 'Median visits per day',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.days.length < 5) return null;
        const vals = s.days.map(d => d.n).sort((a, b) => a - b);
        const mid = Math.floor(vals.length / 2);
        const median = vals.length % 2 ? vals[mid] : Math.round((vals[mid - 1] + vals[mid]) / 2);
        const mean = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);

        // Only worth asking when the two differ: the point of the question is
        // that they are not the same thing, and the mean sits in the choices
        // as the obvious wrong answer.
        if (median === mean) return null;

        const built = cmChoices(String(median),
            [String(mean)].concat(cmNumberDistractors(median, rng, 2).map(String)), rng);
        if (!built) return null;
        return {
            prompt: 'What is the median number of visits per day this week?',
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `Sorted: ${vals.join(', ')}. The middle value is ${median}. `
                   + `The mean is ${mean} — close, but not the same thing.`,
        };
    },
},

{
    id: 'visits-rate',
    category: 'math',
    title: 'Visits per hour',
    bands: ['6-8'],
    build({ s, band, rng, feeder }) {
        // A rate rather than a total (design notes §11). Daylight hours only,
        // because dividing by 24 when the feeder is dark for half of them is
        // the kind of answer that is arithmetically right and meaningless.
        const FROM = 7, TO = 18;
        const inDay = s.byHour.slice(FROM, TO).reduce((a, b) => a + b, 0);
        const hours = (TO - FROM) * s.days.length;
        if (inDay < 25 || s.days.length < 4) return null;

        const rate = Math.round((inDay / hours) * 10) / 10;
        if (rate < 0.2) return null;

        const dist = [rate * 2, rate / 2, rate + 0.5, rate - 0.3]
            .map(v => Math.round(v * 10) / 10)
            .filter(v => v > 0 && v !== rate);
        const built = cmChoices(rate.toFixed(1), [...new Set(dist)].map(v => v.toFixed(1)), rng);
        if (!built) return null;
        return {
            prompt: `${feeder} recorded ${inDay} visits between 7am and 6pm over `
                  + `${s.days.length} days. About how many visits per hour is that?`,
            ...built,
            // Only the hours the question counts. Showing every active hour
            // put a 6am bar on screen that the stated total excluded, so a
            // class adding the bars got a different number from the one in
            // the prompt — which is a fast way to lose them.
            chart: cmChart(`Visits by hour, 7am to 6pm`,
                           s.byHour.map((n, h) => ({ label: cmHourLabel(h), value: n, key: h }))
                                   .filter(x => x.key >= FROM && x.key < TO),
                           { band, maxBars: TO - FROM, showValues: true }),
            explain: `${inDay} visits ÷ (${TO - FROM} hours × ${s.days.length} days) `
                   + `= ${inDay} ÷ ${hours} ≈ ${rate} per hour.`,
        };
    },
},

{
    id: 'probability-next',
    category: 'math',
    title: 'Chance of two in a row',
    bands: ['6-8'],
    build({ s, band, rng }) {
        // Compound probability from relative frequency (design notes §11).
        // Deliberately TWO birds: one is just the percentage question again,
        // and squaring is the step that separates the bands.
        if (s.total < 25 || s.species.length < 2) return null;
        const top = s.species[0];
        const p = top.n / s.total;
        // Outside this range the squared answer is either near-certain or so
        // small that the distractors stop being distinguishable.
        if (p < 0.35 || p > 0.8) return null;

        const pct = Math.round(p * p * 100);
        const naive = Math.round(p * 100);          // the classic wrong answer
        if (Math.abs(pct - naive) < 8) return null;

        const built = cmChoices(`${pct}%`,
            [`${naive}%`, `${Math.round(p * 200)}%`, `${Math.max(1, Math.round(pct / 2))}%`], rng);
        if (!built) return null;
        return {
            prompt: `${top.species} made ${top.n} of this week's ${s.total} visits. `
                  + 'If the next two birds are independent, what is the chance BOTH are '
                  + `${top.species}?`,
            ...built,
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s), { band, highlight: top.species, showValues: true }),
            explain: `${top.n} ÷ ${s.total} = ${p.toFixed(2)}. `
                   + `Both: ${p.toFixed(2)} × ${p.toFixed(2)} ≈ ${pct}%.`,
        };
    },
},

{
    id: 'day-range',
    category: 'math',
    title: 'Range across the week',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.days.length < 4) return null;
        const vals = s.days.map(d => d.n);
        const range = Math.max(...vals) - Math.min(...vals);
        if (range < 3) return null;

        const built = cmChoices(String(range),
                                cmNumberDistractors(range, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: 'What is the range of daily visits this week — the busiest day minus the quietest?',
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `${Math.max(...vals)} − ${Math.min(...vals)} = ${range}.`,
        };
    },
},

// ── More variety ─────────────────────────────────────────────────
//
// The first set leaned on two shapes: "which bar is biggest" and "what is
// this number". These add shapes it did not have — yes/no, ordinal rank,
// absence, addition of two values, proportional projection — so a class
// meeting the same data twice in a term is not asked the same thing twice.

{
    id: 'did-it-visit',
    category: 'counting',
    title: 'Did this bird come?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // A yes/no, which nothing else in the set is. Half the time the
        // answer is no, using a bird the feeder has NOT seen — otherwise the
        // class learns that the answer to this shape is always yes.
        if (s.species.length < 2) return null;
        const seen = s.species.map(x => x.species);
        const unseen = COMMON_FEEDER_SPECIES.filter(x => !seen.includes(x));
        const askAboutSeen = rng() < 0.5 || !unseen.length;

        const species = askAboutSeen
            ? seen[Math.floor(rng() * Math.min(seen.length, 4))]
            : unseen[Math.floor(rng() * unseen.length)];
        const answer = askAboutSeen ? 'Yes' : 'No';
        const opts = ['Yes', 'No'];

        return {
            prompt: `Did a ${species} come to the feeder this week?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            chart: cmChart('Birds seen this week', cmSpeciesSeries(s), { band }),
            explain: askAboutSeen
                ? `Yes — ${species} came ${s.bySpecies.get(species)} time(s).`
                : `No — no ${species} this week. The chart shows every bird that came.`,
            fact: speciesFact(species, band),
        };
    },
},

{
    id: 'how-many-days',
    category: 'counting',
    title: 'How many days?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // Counting BARS rather than reading their height — a different skill
        // from everything else at this band.
        const withBirds = s.days.filter(d => d.n > 0).length;
        if (withBirds < 2 || s.days.length < 3) return null;
        const built = cmChoices(String(withBirds),
            cmNumberDistractors(withBirds, rng, 2).filter(v => v > 0 && v <= 14).map(String), rng);
        if (!built) return null;
        return {
            prompt: 'On how many days did birds come to the feeder?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band }),
            explain: `Birds came on ${withBirds} of the ${s.days.length} days.`,
        };
    },
},

{
    id: 'quietest-day',
    category: 'time',
    title: 'Which day was quietest?',
    bands: ['3-5'],
    build({ s, band, rng, feeder }) {
        // The mirror of busiest-day. Finding a minimum is genuinely harder
        // than finding a maximum on a bar chart — the eye goes to the tall
        // one — so it is its own question rather than a reskin.
        if (s.days.length < 4) return null;
        const sorted = s.days.slice().sort((a, b) => a.n - b.n);
        const min   = sorted[0].n;
        const tied  = s.days.filter(d => d.n === min);
        const above = s.days.filter(d => d.n > min).sort((a, b) => a.n - b.n);
        // A tie at the bottom used to kill this outright, and a real week has
        // two empty days in it more often than not - so the mirror of
        // busiest-day sat out every week that busiest-day ran. A tie is not a
        // broken question. It means the answer is the quietest of the days ON
        // OFFER, and the prompt says so rather than hoping nobody notices the
        // other nought on the chart.
        if (above.length < 2) return null;
        const answer = cmShuffle(tied, rng)[0];
        const opts   = cmShuffle([answer].concat(above.slice(0, 3)), rng);
        const many   = tied.length > 1;
        return {
            prompt: many
                ? `Which of THESE days was quietest at ${feeder} this week?`
                : `Which day was quietest at ${feeder} this week?`,
            choices: opts.map(d => ({ label: cmDayAxisLabel(d.day) })),
            correct_index: opts.findIndex(d => d.day === answer.day),
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band }),
            explain: opts.map(d => `${cmDayAxisLabel(d.day)}: ${d.n}`).join(' · ')
                   + (many
                      ? `. ${cmDayAxisLabel(answer.day)} had ${min} - and so did `
                        + (tied.length === 2 ? 'one other day' : `${tied.length - 1} other days`)
                        + ' this week. The chart shows that; four choices cannot.'
                      : ''),
        };
    },
},

{
    id: 'total-two-days',
    category: 'math',
    title: 'Two days together',
    bands: ['3-5'],
    build({ s, band, rng }) {
        if (s.days.length < 4) return null;
        const sorted = s.days.slice().sort((a, b) => b.n - a.n);
        const a = sorted[0], b = sorted[2];
        if (!a || !b) return null;
        const sum = a.n + b.n;

        const built = cmChoices(String(sum),
                                cmNumberDistractors(sum, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many visits were there on ${cmDayProse(a.day)} and `
                  + `${cmDayProse(b.day)} added together?`,
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `${a.n} + ${b.n} = ${sum}.`,
        };
    },
},

{
    id: 'species-rank',
    category: 'comparison',
    title: 'Second most common',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Ordinal rather than extreme. "Biggest" is findable at a glance;
        // "second biggest" needs the bars actually compared.
        if (s.species.length < 3) return null;
        const [first, second, third] = s.species;
        if (second.n === third.n || first.n === second.n) return null;

        const built = cmChoices(second.species,
            [first.species, third.species].concat(
                s.species.slice(3, 4).map(x => x.species)), rng);
        if (!built) return null;
        return {
            prompt: 'Which bird was the SECOND most common this week?',
            ...built,
            chart: cmChart('Visits by species this week', cmSpeciesSeries(s), { band }),
            explain: s.species.slice(0, 3).map((x, i) => `${i + 1}. ${x.species} (${x.n})`).join(' · '),
        };
    },
},

{
    id: 'percent-change',
    category: 'math',
    title: 'Percent change on last week',
    bands: ['6-8'],
    build({ s, s14, band, rng }) {
        const prev = s14.total - s.total;
        if (s.total < 10 || prev < 10) return null;
        const prevDays = s14.days.filter(d =>
            cmDayStart(d.day).getTime() < Date.now() - 7 * 86400000).length;
        if (prevDays < 4) return null;

        const change = Math.round(((s.total - prev) / prev) * 100);
        if (Math.abs(change) < 8) return null;      // too small to read confidently

        const label = v => (v > 0 ? `up ${v}%` : `down ${Math.abs(v)}%`);
        const built = cmChoices(label(change),
            [label(-change), label(Math.round(change / 2)), label(change * 2)]
                .filter(x => x !== label(change)), rng);
        if (!built) return null;
        return {
            prompt: 'By roughly what percent did visits change from last week to this week?',
            ...built,
            chart: cmChart('This week against last week',
                           [{ label: 'Last week', value: prev, key: 'prev' },
                            { label: 'This week', value: s.total, key: 'now' }], { band, showValues: true }),
            explain: `(${s.total} − ${prev}) ÷ ${prev} = ${((s.total - prev) / prev).toFixed(2)} `
                   + `→ ${label(change)}.`,
        };
    },
},

{
    id: 'expected-count',
    category: 'math',
    title: 'Projecting forward',
    bands: ['6-8'],
    build({ s, band, rng, feeder }) {
        // Proportional reasoning, and a chance to say out loud that a rate
        // measured over one week does not have to hold for the next four.
        if (s.days.length < 5 || s.total < 20) return null;
        const perDay = s.total / s.days.length;
        const projected = Math.round(perDay * 30);
        if (projected < 20) return null;

        const round = v => Math.round(v / 5) * 5;
        const built = cmChoices(String(round(projected)),
            [round(projected * 2), round(projected / 2), round(projected * 1.4)]
                .filter(v => v > 0 && v !== round(projected)).map(String), rng);
        if (!built) return null;
        return {
            prompt: `At this week's rate, about how many visits would ${feeder} get in 30 days?`,
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `${s.total} ÷ ${s.days.length} ≈ ${perDay.toFixed(1)} a day, `
                   + `× 30 ≈ ${projected}. Worth asking the class whether a week in `
                   + `${cmDayStart(s.days[s.days.length - 1].day).toLocaleDateString(undefined, { month: 'long' })} `
                   + `predicts the next month at all.`,
        };
    },
},

{
    id: 'quiet-hours',
    category: 'analysis',
    title: 'Hours with nothing',
    bands: ['6-8'],
    build({ s, band, rng }) {
        // Reading ABSENCE off a chart — the gaps rather than the bars.
        const FROM = 6, TO = 19;
        const slots = [];
        for (let h = FROM; h < TO; h++) slots.push({ h, n: s.byHour[h] });
        const empty = slots.filter(x => x.n === 0).length;
        if (s.total < 20 || empty < 1 || empty > 10) return null;

        const built = cmChoices(String(empty),
            cmNumberDistractors(empty, rng, 3).filter(v => v >= 0 && v <= TO - FROM).map(String), rng);
        if (!built) return null;
        return {
            prompt: `Between 6am and 7pm, how many whole hours had NO visits at all?`,
            ...built,
            chart: cmChart('Visits by hour, 6am to 7pm',
                           slots.map(x => ({ label: cmHourLabel(x.h), value: x.n, key: x.h })),
                           { band, maxBars: TO - FROM, showValues: true }),
            explain: `${empty} of the ${TO - FROM} hours are empty: `
                   + slots.filter(x => x.n === 0).map(x => cmHourLabel(x.h)).join(', ') + '.',
        };
    },
},

// ── Color and shape, for K–2 ────────────────────────────────────
//
// These ask about the birds rather than about the numbers, which is the
// point: a five-year-old who cannot yet read a bar chart can absolutely tell
// you which bird is red. They are still grounded in this feeder — every bird
// offered is one that actually came this week.

{
    id: 'which-bird-is-color',
    category: 'identification',
    title: 'Which bird is this color?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // Only a color exactly ONE of the birds on offer has, or the
        // question has two right answers and the class is right to argue.
        const known = s.species
            .map(x => ({ species: x.species, look: speciesLook(x.species) }))
            .filter(x => x.look);
        if (known.length < 3) return null;

        const byColor = new Map();
        known.forEach(k => {
            if (!byColor.has(k.look.color)) byColor.set(k.look.color, []);
            byColor.get(k.look.color).push(k.species);
        });
        const unique = [...byColor.entries()].filter(([, list]) => list.length === 1);
        if (!unique.length) return null;

        const [color, [answer]] = cmShuffle(unique, rng)[0];
        const others = known.filter(k => k.look.color !== color).map(k => k.species);
        if (others.length < 2) return null;

        const built = cmChoices(answer, cmShuffle(others, rng).slice(0, 2), rng);
        if (!built) return null;
        return {
            prompt: `Which of these birds is ${color}?`,
            ...built,
            chart: cmChart('Birds that came this week', cmSpeciesSeries(s), { band }),
            explain: `The ${answer} is ${color}. `
                   + `Look for ${speciesLook(answer).feature}.`,
            fact: speciesFact(answer, band),
        };
    },
},

{
    id: 'what-color-is',
    category: 'identification',
    title: 'What color is it?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const known = s.species.map(x => x.species).filter(sp => speciesLook(sp));
        if (!known.length) return null;

        const species = cmShuffle(known, rng)[0];
        const look = speciesLook(species);
        const others = [...new Set(Object.values(SPECIES_LOOKS).map(l => l.color))]
            .filter(c => c !== look.color);
        const built = cmChoices(look.color, cmShuffle(others, rng).slice(0, 2), rng);
        if (!built) return null;
        return {
            prompt: `What color is a ${species}?`,
            ...built,
            // No chart: this one is about the bird, not the data, and a chart
            // of visit counts beside it would only suggest the answer is in
            // there somewhere.
            //
            // The bird itself, held back until the reveal. Asked for:
            // "it would be better if it showed a picture of a northern
            // cardinal as the reveal." On reveal and not before, because a
            // photograph of a cardinal IS the answer to "what color is a
            // cardinal" — image_on_reveal is what that flag is for.
            image: cmShotFor(s, species),
            image_on_reveal: true,
            explain: look.female
                ? `${look.color} — though the female is ${look.female}.`
                : `${look.color}. Look for ${look.feature}.`,
            fact: speciesFact(species, band),
        };
    },
},

{
    id: 'spot-the-feature',
    category: 'identification',
    title: 'Which bird has this?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // The "shape" half of color/shape matching. Features are written so
        // that only one bird on offer could have each.
        const known = s.species.map(x => x.species).filter(sp => speciesLook(sp));
        if (known.length < 3) return null;

        const answer = cmShuffle(known, rng)[0];
        const look = speciesLook(answer);
        if (!look.feature) return null;
        const others = known.filter(sp => sp !== answer);
        const built = cmChoices(answer, cmShuffle(others, rng).slice(0, 2), rng);
        if (!built) return null;
        return {
            prompt: `Which bird has ${look.feature}?`,
            ...built,
            explain: `The ${answer}. ${speciesFact(answer, band) || ''}`.trim(),
        };
    },
},

{
    id: 'came-today',
    category: 'counting',
    title: 'Which bird came today?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // Straight from the notes: "Which bird came today?" as a picture
        // choice. Today only, so it is about what is happening now rather
        // than about a week of history.
        // Before the first bird of the day this asked nothing - which in
        // practice meant it asked nothing at morning registration, when a
        // K-2 class is most likely to be looking. When today is still empty
        // it uses the last day that was not, and NAMES that day rather than
        // quietly passing yesterday off as today.
        const todayKey = cmDayKey(new Date());
        let key = todayKey, on = s.daySpec.get(todayKey);
        if (!on || !on.size) {
            const prior = s.days.filter(d => d.day < todayKey &&
                (s.daySpec.get(d.day) || new Map()).size).pop();
            if (!prior) return null;
            key = prior.day; on = s.daySpec.get(key);
        }
        const isToday = key === todayKey;
        const when = isToday ? 'today' : `on ${cmDayProse(key)}`;

        const seen = [...on.keys()];
        const notThen = s.species.map(x => x.species).filter(sp => !on.has(sp));
        if (!seen.length || notThen.length < 2) return null;

        const answer = cmShuffle(seen, rng)[0];
        const built = cmChoices(answer, cmShuffle(notThen, rng).slice(0, 2), rng);
        if (!built) return null;
        return {
            // TODAY is shouted because the whole point is to stop a class
            // answering from the week. A spelled-out date is specific on its
            // own, and "ON SATURDAY NOVEMBER 14TH" is just loud.
            prompt: `Which of these birds came to the feeder ${isToday ? 'TODAY' : 'on ' + cmDayProse(key)}?`,
            ...built,
            explain: `${answer} came ${on.get(answer)} time(s) ${when}. `
                   + `The others came on other days this week, but not ${isToday ? 'today' : 'then'}.`,
            fact: speciesFact(answer, band),
        };
    },
},

{
    id: 'species-on-day',
    category: 'comparison',
    title: 'Most common on one day',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Slices the week by day rather than summing it — a different cut of
        // the same data from every other species question.
        const busiest = s.days.slice().sort((a, b) => b.n - a.n)[0];
        if (!busiest || busiest.n < 6) return null;
        const onDay = s.daySpec.get(busiest.day);
        if (!onDay || onDay.size < 3) return null;

        const ranked = [...onDay.entries()].sort((a, b) => b[1] - a[1]);
        if (ranked[0][1] === ranked[1][1]) return null;

        const built = cmChoices(ranked[0][0], ranked.slice(1, 4).map(r => r[0]), rng);
        if (!built) return null;
        return {
            prompt: `Which bird came most often on ${cmDayAxisLabel(busiest.day)}?`,
            ...built,
            chart: cmChart(`Visits on ${cmDayAxisLabel(busiest.day)}, by species`,
                           ranked.map(([sp, n]) => ({ label: sp, value: n, key: sp,
                                                      image: cmSpeciesPhoto(s, sp) })),
                           { band }),
            explain: ranked.slice(0, 3).map(([sp, n]) => `${sp}: ${n}`).join(' · '),
        };
    },
},

{
    id: 'above-average-days',
    category: 'math',
    title: 'Days above the average',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Work out the mean, then compare every bar against it. Two steps
        // rather than one, which is the step up from "what is the average".
        if (s.days.length < 5 || s.total < 15) return null;
        const mean = s.total / s.days.length;
        const above = s.days.filter(d => d.n > mean).length;
        if (above === 0 || above === s.days.length) return null;

        const built = cmChoices(String(above),
            cmNumberDistractors(above, rng, 3)
                .filter(v => v >= 0 && v <= s.days.length).map(String), rng);
        if (!built) return null;
        return {
            prompt: 'On how many days were there MORE visits than the weekly average?',
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `The average is ${s.total} ÷ ${s.days.length} ≈ ${mean.toFixed(1)}. `
                   + `${above} day(s) are above it.`,
        };
    },
},

{
    id: 'compare-two-hours',
    category: 'time',
    title: 'Which hour was busier?',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const active = s.byHour.map((n, h) => ({ h, n })).filter(x => x.n > 0);
        if (active.length < 4 || s.total < 12) return null;
        const pair = cmShuffle(active, rng).slice(0, 2).sort((a, b) => a.h - b.h);
        if (pair[0].n === pair[1].n) return null;

        const answer = pair[0].n > pair[1].n ? pair[0] : pair[1];
        const opts = pair.map(x => cmHourLabel(x.h));
        return {
            prompt: `Were there more visits at ${opts[0]} or at ${opts[1]}?`,
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(cmHourLabel(answer.h)),
            chart: cmChart('Visits by hour this week',
                           s.byHour.map((n, h) => ({ label: cmHourLabel(h), value: n, key: h }))
                                   .filter(x => x.value > 0), { band, maxBars: 14 }),
            explain: `${opts[0]}: ${pair[0].n} · ${opts[1]}: ${pair[1].n}.`,
        };
    },
},

{
    id: 'mean-vs-median',
    category: 'math',
    title: 'Mean against median',
    bands: ['6-8'],
    build({ s, band, rng }) {
        // Not "what is the median" — that already exists — but what the gap
        // between them SAYS about the shape of the week.
        if (s.days.length < 5) return null;
        const vals = s.days.map(d => d.n).sort((a, b) => a - b);
        const mid = Math.floor(vals.length / 2);
        const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
        const mean = s.total / s.days.length;
        if (Math.abs(mean - median) < 0.75) return null;

        const answer = mean > median ? 'The mean is higher' : 'The median is higher';
        const opts = cmShuffle(['The mean is higher', 'The median is higher',
                                'They are the same'], rng);
        return {
            prompt: 'Is the mean or the median of this week\u2019s daily visits higher?',
            choices: opts.map(l => ({ label: l })),
            correct_index: opts.indexOf(answer),
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band, showValues: true }),
            explain: `Mean ${mean.toFixed(1)}, median ${median}. `
                   + (mean > median
                      ? 'A few busy days pull the mean up above the typical day.'
                      : 'A few very quiet days drag the mean below the typical day.'),
        };
    },
},

{
    id: 'percent-of-days',
    category: 'math',
    title: 'How often does it turn up?',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.days.length < 5 || !s.species.length) return null;
        const top = s.species[0];
        const daysSeen = s.days.filter(d => (s.daySpec.get(d.day) || new Map()).has(top.species)).length;
        if (daysSeen === 0 || daysSeen === s.days.length) return null;

        const pct = Math.round((daysSeen / s.days.length) * 100);
        const built = cmChoices(`${pct}%`,
            cmNumberDistractors(pct, rng, 4).filter(v => v > 0 && v <= 100)
                .slice(0, 3).map(v => `${v}%`), rng);
        if (!built) return null;
        return {
            prompt: `On what percent of days this week did at least one ${top.species} appear?`,
            ...built,
            chart: cmChart(`Days ${top.species} appeared`,
                           s.days.map(d => ({ label: cmDayAxisLabel(d.day),
                                              value: (s.daySpec.get(d.day) || new Map()).get(top.species) || 0,
                                              key: d.day })), { band }),
            explain: `${daysSeen} of ${s.days.length} days = ${pct}%. `
                   + 'Note this is days, not visits — a bird that came nine times in one day still counts once.',
        };
    },
},

// ── Puzzles ──────────────────────────────────────────────────────

{
    id: 'word-jumble',
    category: 'puzzle',
    // The whole point is to solve it, not to recognize it in a list.
    guessFirst: true,
    title: 'Unscramble the bird',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        // K-2 gets short names only. WREN and JAY are a game at six;
        // MOCKINGBIRD is not.
        const maxLen = band === 'k-2' ? 5 : 11;
        // Only the ANSWER needs a short name — it is the word being
        // unscrambled. The wrong options are just names to read, so they can
        // be any bird that came. Requiring three short names meant K-2 almost
        // never got a jumble: of the regulars only WREN and JAY are short
        // enough, so the pool was two and the template sat out every week.
        const short = s.species
            .map(x => ({ species: x.species, short: cmShortName(x.species) }))
            .filter(x => x.short.length >= 3 && x.short.length <= maxLen);
        if (!short.length || s.species.length < 3) return null;

        const pick = cmShuffle(short, rng)[0];
        const jumbled = cmJumble(pick.short, rng);
        if (!jumbled) return null;

        // Excluded by SHORT NAME, not by species. The puzzle only ever shows
        // the short name, so "Mourning Dove" and "Eurasian Collared-Dove" are
        // one word — DOVE — and offering both makes two options correct.
        // Flagged from a lesson: "all 3 were doves so they all are correct."
        const built = cmChoices(pick.species,
            cmLengthMatchedDistractors(
                s.species.map(x => ({ species: x.species, short: cmShortName(x.species) }))
                         .filter(x => x.short !== pick.short),
                pick.short.length, rng, band === 'k-2' ? 2 : 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            // "Which bird is this?" in front of a row of letters reads as an
            // identification question with the photo missing. Say the task.
            prompt: `Unscramble the bird’s name:
${jumbled.split('').join(' ')}`,
            ...built,
            // The bird, but only once it has been unscrambled. Flagged: "would
            // be nice to show a photo of the bird". Shown with the question, a
            // child who knows a dove reads DOVE off the picture and never
            // touches the letters — the guessFirst gate above exists to stop
            // exactly that. At the reveal it is the payoff instead: the word
            // they worked out, and the bird it belongs to, at their feeder.
            // Uncropped there, because by then the caption's name is the answer
            // already on the board.
            image: cmShotFor(s, pick.species),
            image_on_reveal: true,
            explain: `${jumbled} unscrambles to ${pick.short} — the ${pick.species}. `
                   + `It came ${s.bySpecies.get(pick.species)} time(s) this week.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'missing-letters',
    category: 'puzzle',
    // The whole point is to solve it, not to recognize it in a list.
    guessFirst: true,
    title: 'Fill in the blanks',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // The single-clue version of a crossword entry. First and last letters
        // stay, because a word with both ends missing is a guess rather than a
        // deduction.
        const pool = s.species
            .map(x => ({ species: x.species, short: cmShortName(x.species) }))
            .filter(x => x.short.length >= 5);
        if (pool.length < 3) return null;

        const pick = cmShuffle(pool, rng)[0];
        const letters = pick.short.split('');
        const hideable = [];
        for (let i = 1; i < letters.length - 1; i++) hideable.push(i);
        const hideCount = Math.max(2, Math.round(hideable.length * 0.45));
        const hidden = new Set(cmShuffle(hideable, rng).slice(0, hideCount));
        const masked = letters.map((ch, i) => (hidden.has(i) ? '_' : ch)).join(' ');

        const built = cmChoices(pick.species,
            cmLengthMatchedDistractors(pool.filter(x => x.short !== pick.short),
                                       pick.short.length, rng, 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `Which bird fits? ${masked}  (${pick.short.length} letters)`,
            ...built,
            explain: `${pick.short} — the ${pick.species}.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'hidden-bird',
    category: 'puzzle',
    // The whole point is to solve it, not to recognize it in a list.
    guessFirst: true,
    title: 'Find the hidden bird',
    bands: ['3-5', '6-8'],
    build({ s, band, rng }) {
        const pool = s.species
            .map(x => ({ species: x.species, short: cmShortName(x.species) }))
            .filter(x => x.short.length >= 4 && x.short.length <= 10);
        if (pool.length < 3) return null;

        const pick = cmShuffle(pool, rng)[0];
        const others = pool.filter(x => x.species !== pick.species);
        const pad = n => Array.from({ length: n },
            () => PUZZLE_ALPHABET[Math.floor(rng() * 26)]).join('');

        // Four to six letters of noise each side. Enough that the word does
        // not simply sit there, not so much that finding it is a chore.
        let line = null;
        for (let attempt = 0; attempt < 20; attempt++) {
            const candidate = pad(4 + Math.floor(rng() * 3)) + pick.short
                            + pad(4 + Math.floor(rng() * 3));
            // The noise must not accidentally spell one of the OTHER options,
            // which would give the question two right answers.
            if (!others.some(o => candidate.includes(o.short))) { line = candidate; break; }
        }
        if (!line) return null;

        const built = cmChoices(pick.species,
                                cmShuffle(others, rng).slice(0, 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `A bird's name is hidden in here. Which one?\n${line.split('').join(' ')}`,
            ...built,
            explain: `${pick.short} is hidden in it — the ${pick.species}.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'letter-code',
    category: 'puzzle',
    // The whole point is to solve it, not to recognize it in a list.
    guessFirst: true,
    title: 'Crack the code',
    bands: ['6-8'],
    build({ s, band, rng }) {
        // A=1 … Z=26. Ten numbers is a decode; twenty is a chore, so this is
        // capped at eight letters.
        const pool = s.species
            .map(x => ({ species: x.species, short: cmShortName(x.species) }))
            .filter(x => x.short.length >= 3 && x.short.length <= 8);
        if (pool.length < 3) return null;

        const pick = cmShuffle(pool, rng)[0];
        const code = pick.short.split('')
            .map(ch => PUZZLE_ALPHABET.indexOf(ch) + 1).join(' - ');

        const built = cmChoices(pick.species,
            cmLengthMatchedDistractors(pool.filter(x => x.short !== pick.short),
                                       pick.short.length, rng, 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `If A=1 and Z=26, which bird is this? ${code}`,
            ...built,
            explain: `${code} spells ${pick.short} — the ${pick.species}.`,
        };
    },
},

{
    id: 'caesar-bird',
    category: 'puzzle',
    // The whole point is to solve it, not to recognize it in a list.
    guessFirst: true,
    title: 'Shifted letters',
    bands: ['6-8'],
    build({ s, band, rng }) {
        const pool = s.species
            .map(x => ({ species: x.species, short: cmShortName(x.species) }))
            .filter(x => x.short.length >= 4 && x.short.length <= 10);
        if (pool.length < 3) return null;

        const pick = cmShuffle(pool, rng)[0];
        const shift = 1 + Math.floor(rng() * 5);
        const coded = pick.short.split('').map(ch => {
            const i = PUZZLE_ALPHABET.indexOf(ch);
            return i < 0 ? ch : PUZZLE_ALPHABET[(i + shift) % 26];
        }).join('');

        const built = cmChoices(pick.species,
            cmLengthMatchedDistractors(pool.filter(x => x.short !== pick.short),
                                       pick.short.length, rng, 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `Every letter has been moved ${shift} forward in the alphabet. `
                  + `Move them back to find the bird: ${coded.split('').join(' ')}`,
            ...built,
            explain: `${coded} shifted back ${shift} is ${pick.short} — the ${pick.species}.`,
        };
    },
},

{
    id: 'odd-one-out',
    category: 'puzzle',
    title: 'Which one did not come?',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        // Three birds the feeder saw and one it did not. Needs no reading of
        // numbers at all, which is what makes it work at K-2.
        const seen = s.species.map(x => x.species);
        if (seen.length < 3) return null;
        const unseen = COMMON_FEEDER_SPECIES.filter(sp => !seen.includes(sp));
        if (!unseen.length) return null;

        const answer = cmShuffle(unseen, rng)[0];
        const built = cmChoices(answer, cmShuffle(seen, rng).slice(0, 3), rng);
        if (!built) return null;
        return {
            prompt: 'Three of these birds came to the feeder this week. Which one did NOT?',
            ...built,
            chart: cmChart('Birds that came this week', cmSpeciesSeries(s), { band }),
            explain: `No ${answer} this week. The chart shows every bird that came.`,
            fact: speciesFact(answer, band),
        };
    },
},

{
    id: 'bird-wonder',
    // Works with no feeder data at all, which is what carries a lesson
    // at a feeder the birds have not found yet.
    needsData: false,
    category: 'wonder',
    title: 'Did you know?',
    bands: ['k-2', '3-5', '6-8'],
    build({ s, band, rng }) {
        // The only template that asks nothing of the feeder. It runs on a
        // week when the feeder is quiet, which is exactly when the data
        // questions are at their thinnest and the lesson needs it most.
        const pool = BIRD_WONDERS.filter(w => w.bands.includes(band));
        if (!pool.length) return null;

        const w = cmShuffle(pool, rng)[0];
        const built = cmChoices(w.answer, cmShuffle(w.distractors, rng), rng);
        if (!built) return null;

        // Our own snapshot first. For the species that do visit feeders,
        // "this one was at OUR feeder on Tuesday" is worth far more to a
        // class than any stock photograph. Otherwise a Wikimedia Commons
        // photograph, shown with the credit its licence requires.
        const photo = cmShotFor(s, w.bird) || cmWonderPhoto(w.bird);

        return {
            // Each FACT is its own template id, not all 34 sharing one.
            // Feedback on "the woodpecker photo is cut off" has to point at
            // the woodpecker, and repeat-avoidance has to know that yesterday
            // being a fact slide does not make today's a repeat.
            template_id: w.id,
            prompt: w.prompt,
            ...built,
            image: photo || null,
            intro: w.intro,
            subject: w.subject,
            wonder_bird: w.bird,
            explain: w.reveal,
        };
    },
},

{
    id: 'bird-collective-noun',
    // Works with no feeder data at all, which is what carries a lesson
    // at a feeder the birds have not found yet.
    needsData: false,
    category: 'language',
    title: 'What do you call a group of them?',
    bands: ['3-5', '6-8'],
    build({ rng }) {
        const pick = cmShuffle(BIRD_COLLECTIVES, rng)[0];
        const built = cmChoices(pick.noun, pick.others, rng);
        if (!built) return null;
        return {
            template_id: 'collective-' + pick.noun.replace(/\W+/g, '-'),
            prompt: `What do you call a group of ${pick.group}?`,
            ...built,
            explain: `${pick.noun.charAt(0).toUpperCase() + pick.noun.slice(1)} of `
                   + `${pick.group}. Most of these names come from hunting books `
                   + 'written over five hundred years ago.',
        };
    },
},

{
    id: 'bird-by-sound',
    // Works with no feeder data at all, which is what carries a lesson
    // at a feeder the birds have not found yet.
    needsData: false,
    category: 'language',
    title: 'Who says that?',
    bands: ['k-2', '3-5', '6-8'],
    build({ rng }) {
        // Prefer a bird we can actually PLAY. Flagged exactly: "it would be
        // better if these types of questions included a clickable link to
        // play the sound." A mnemonic with the real song behind it is a
        // different question from a mnemonic alone — the class hears the
        // rhythm the words were invented to carry.
        //
        // Not a hard requirement, though: the written mnemonics work on
        // their own and always have, and this template is one of the few
        // that carries a lesson at a feeder with no data at all. A species
        // with no recording still gets asked.
        const withSound = BIRD_SOUNDS.filter(x => cmPlayableSound(x.bird));
        const pool = cmShuffle(withSound.length >= 4 ? withSound : BIRD_SOUNDS, rng);
        const pick = pool[0];
        const built = cmChoices(pick.bird, pool.slice(1, 4).map(x => x.bird), rng);
        if (!built) return null;

        const rec = cmPlayableSound(pick.bird);

        return {
            template_id: 'sound-' + pick.bird.toLowerCase().replace(/\W+/g, '-'),
            prompt: rec
                ? `Birders learn songs by putting words to them. Listen, then look at `
                  + `the words. Which bird is this?\n"${pick.says}"`
                : `Birders learn songs by putting words to them. Which bird sounds `
                  + `like this?\n"${pick.says}"`,
            ...built,
            // The recording IS the question here, so it plays from the
            // start rather than waiting for the reveal.
            sound: rec,
            // Puts the "Read more" button on the reveal. Asked for on this
            // exact question — "maybe link to website about the bird?" — and
            // it is the right instinct: a class that has just learned a bird
            // by its song is the most curious it will ever be about that
            // bird, and the slide was a dead end.
            wonder_bird: pick.bird,
            explain: `The ${pick.bird}. Once you have heard it as words you cannot `
                   + 'un-hear it, which is exactly why birders teach them this way.',
        };
    },
},

{
    id: 'bird-state-symbol',
    // Works with no feeder data at all, which is what carries a lesson
    // at a feeder the birds have not found yet.
    needsData: false,
    category: 'geography',
    title: 'State birds',
    bands: ['3-5', '6-8'],
    build({ s, rng }) {
        const built = cmChoices('Northern Cardinal',
            ['Bald Eagle', 'American Robin', 'Blue Jay'], rng);
        if (!built) return null;
        return {
            prompt: 'One bird is the official state bird of seven different states — '
                  + 'more than any other. Which one?',
            ...built,
            // Our own cardinal if the feeder has one, which is the better
            // version of this: the bird on the board is the bird outside.
            image: cmShotFor(s, 'Northern Cardinal')
                || cmWonderPhoto('Northern Cardinal'),
            map: {
                highlight: ['il', 'in', 'ky', 'nc', 'oh', 'va', 'wv'],
                caption: 'Seven states, one bird',
            },
            explain: 'The Northern Cardinal: Illinois, Indiana, Kentucky, North '
                   + 'Carolina, Ohio, Virginia and West Virginia. The Bald Eagle is '
                   + 'the national bird, which is a different job.',
            fact: 'Cardinals do not migrate, so they are a bird those states really '
                + 'do have all year round.',
        };
    },
},

// ── Art ──────────────────────────────────────────────────────────

{
    id: 'art-color-match',
    category: 'art',
    title: 'Match the color',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // A photo and four patches of paint. No reading required, which is
        // exactly why it works at K-2.
        const pool = cmColorfulSpecies(s).filter(x => COLOR_WORD_HEX[x.look.color]);
        if (pool.length < 2) return null;

        const pick = cmShuffle(pool, rng)[0];
        const photo = cmShotFor(s, pick.species);
        if (!photo) return null;

        const others = Object.keys(COLOR_WORD_HEX)
            .filter(c => c !== pick.look.color && c !== 'black and white');
        const built = cmSwatchChoices(
            cmChoices(pick.look.color, cmShuffle(others, rng).slice(0, 3), rng),
            label => COLOR_WORD_HEX[label]);
        if (!built) return null;

        return {
            prompt: 'Which color matches this bird?',
            ...built,
            image: photo,
            explain: `This is a ${pick.species}, and it is ${pick.look.color}.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'art-warm-cool',
    category: 'art',
    title: 'Warm or cool?',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        const pool = cmColorfulSpecies(s, WARM_COLORS.concat(COOL_COLORS));
        if (!pool.length) return null;

        const pick = cmShuffle(pool, rng)[0];
        const warm = WARM_COLORS.includes(pick.look.color);
        const answer = warm ? 'Warm' : 'Cool';
        // Swatched, and therefore drawn without the decorative A/B accents.
        // Those accents are red for the first option and blue for the second
        // whatever the options say, which on THIS question is the question
        // itself answered wrongly in paint: flagged from a K-2 lesson as "the
        // A selection is Red, but the text is cool, and the B text is blue,
        // and it warm". A six-year-old reads the colour, not the word.
        const built = cmSwatchChoices(
            cmChoices(answer, [warm ? 'Cool' : 'Warm'], rng),
            label => (label === 'Warm' ? '#f97316' : '#3b82f6'));
        if (!built) return null;

        const photo = cmShotFor(s, pick.species);
        return {
            prompt: 'Artists call red, orange and yellow WARM colors, and blue '
                  + `and gray COOL colors. The ${pick.species} is `
                  + `${pick.look.color}. Is that warm or cool?`,
            ...built,
            image: photo || null,
            chart: photo ? null : undefined,
            explain: `${pick.look.color} is a ${answer.toLowerCase()} color.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'art-primary-color',
    category: 'art',
    title: 'Primary colors',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Needs at least two primaries actually present, or "which is not a
        // primary" is a question about one bird rather than about the idea.
        const pool = cmColorfulSpecies(s);
        const primaries = pool.filter(x => PRIMARY_COLORS.includes(x.look.color));
        const others    = pool.filter(x => !PRIMARY_COLORS.includes(x.look.color)
                                        && x.look.color !== 'black and white');
        // "Which is NOT primary" needs three primary birds to fill the other
        // three choices, and a real feeder hands you one cardinal and a great
        // deal of brown. Ask it the other way round when that happens: one
        // red bird among the grays and browns is a perfectly good question
        // about the same idea, and it is the one this feeder can support.
        if (!primaries.length || !others.length) return null;
        const flip = primaries.length < 3 || others.length < 1;
        const answer = flip ? cmShuffle(primaries, rng)[0] : cmShuffle(others, rng)[0];
        const pool2  = flip ? others : primaries;
        if (pool2.length < 2) return null;
        const built = cmChoices(answer.species,
            cmShuffle(pool2, rng).slice(0, 3).map(x => x.species), rng);
        if (!built) return null;

        return {
            prompt: 'Artists call red, yellow and blue the PRIMARY colors — '
                  + 'you cannot mix any other paints to make them. Which of these '
                  + (flip ? 'birds IS wearing a primary color?'
                          : 'birds is NOT wearing a primary color?'),
            ...built,
            explain: flip
                ? `The ${answer.species} is ${answer.look.color}, which is one of the `
                  + 'three. Every other bird here is wearing a color you could mix '
                  + 'from other paints.'
                : `The ${answer.species} is ${answer.look.color}, which is not `
                  + 'red, yellow or blue. The others are.',
            fact: speciesFact(answer.species, band),
        };
    },
},

{
    id: 'art-color-mix',
    category: 'art',
    title: 'Mixing paint',
    bands: ['3-5', '6-8'],
    build({ s, band, rng }) {
        // Anchored to a bird that is actually a MIXED color, so the question
        // has something in the room to point at. Orange alone meant an oriole
        // or nothing, and a Florida feeder in November is cardinals and
        // doves - so green and purple count too, and when the feeder has none
        // of the three the primary bird it DOES have still carries the idea
        // from the other end: the cardinal's red is the one you cannot mix.
        const MIXES = [
            { color: 'orange', mix: 'red + yellow',
              not: ['blue + yellow', 'red + blue', 'black + white'] },
            { color: 'green',  mix: 'blue + yellow',
              not: ['red + yellow', 'red + blue', 'black + white'] },
            { color: 'purple', mix: 'red + blue',
              not: ['red + yellow', 'blue + yellow', 'black + white'] },
        ];
        let bird = null, mix = null;
        for (const m of MIXES) {
            const hit = cmColorfulSpecies(s, [m.color])[0];
            if (hit) { bird = hit; mix = m; break; }
        }

        if (bird) {
            const built = cmChoices(mix.mix, mix.not, rng);
            if (!built) return null;
            return {
                prompt: `The ${bird.species} came to our feeder this week. Its `
                      + `${mix.color} is not a primary color — which two paints `
                      + 'would you mix to make it?',
                ...built,
                image: cmShotFor(s, bird.species) || null,
                explain: `${mix.mix} makes ${mix.color}. The other pairs make the `
                       + 'other mixes: red and yellow give orange, blue and yellow '
                       + 'give green, red and blue give purple.',
                fact: speciesFact(bird.species, band),
            };
        }

        const prim = cmColorfulSpecies(s)
            .filter(x => PRIMARY_COLORS.includes(x.look.color))[0];
        if (!prim) return null;
        const built2 = cmChoices('orange', ['red', 'yellow', 'blue'], rng);
        if (!built2) return null;
        const c = prim.look.color;
        return {
            prompt: `The ${prim.species} came to our feeder this week, and it is `
                  + `${c}. Red, yellow and blue are the paints you CANNOT mix — `
                  + 'you have to start with them. Which of these colors CAN you '
                  + 'mix from two others?',
            ...built2,
            image: cmShotFor(s, prim.species) || null,
            explain: 'Orange, because red and yellow make it. '
                   + c.charAt(0).toUpperCase() + c.slice(1) + ' is a primary color, '
                   + 'so there is no pair of paints that makes it — which is '
                   + 'exactly what "primary" means.',
            fact: speciesFact(prim.species, band),
        };
    },
},

{
    id: 'art-missing-color',
    category: 'art',
    title: 'The color that stayed away',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        const here = new Set(cmColorfulSpecies(s).map(x => x.look.color));
        if (here.size < 2) return null;

        const absent = ['red', 'blue', 'yellow', 'orange', 'brown']
            .filter(c => !here.has(c));
        if (!absent.length) return null;

        const answer = cmShuffle(absent, rng)[0];
        const built = cmSwatchChoices(
            cmChoices(answer, cmShuffle([...here], rng).slice(0, 3), rng),
            label => COLOR_WORD_HEX[label]);
        if (!built) return null;

        // The chart used to be species counts, which asks the class to know
        // what colour a Tufted Titmouse is before they can answer. Flagged
        // in a lesson: "difficult to answer without seeing photos of the
        // birds that visited the feeder." Charting the COLOURS instead puts
        // the evidence for this question on the board — each bar is a colour,
        // labelled and painted, so "which one is missing" is readable from
        // the back of the room without knowing a single species.
        //
        // Flagged AGAIN, and the second flag was about something else:
        // "there is no way to know this without looking at the detections
        // prior to the session... the question doesn't show any photos, or
        // species, just asks which colors." Painted bars say which colours
        // came; they do not say that a colour here means a BIRD of that
        // colour. So each bar now carries a photograph of one of this
        // feeder's own birds in that colour, which is the thing the chart
        // was missing — and the prompt names the chart instead of leaving
        // the class to work out that it is the evidence.
        const byColor = new Map();
        cmColorfulSpecies(s).forEach(x => {
            const row = byColor.get(x.look.color)
                     || { n: 0, species: null };
            row.n += x.n;
            // The commonest bird of that colour, since s.species is already
            // sorted by count and this keeps the first one seen.
            if (!row.species) row.species = x.species;
            byColor.set(x.look.color, row);
        });
        // `color` is honoured per row by cmChart, so each bar is painted the
        // colour it stands for. That is the whole point here: a bar chart of
        // colour words drawn in the default palette would be one more thing
        // to decode.
        const series = [...byColor.entries()]
            .sort((a, b) => b[1].n - a[1].n)
            .map(([color, row]) => ({
                label: color.charAt(0).toUpperCase() + color.slice(1),
                value: row.n,
                color: COLOR_WORD_HEX[color] || undefined,
                image: cmSpeciesPhoto(s, row.species),
            }));

        return {
            prompt: 'Look at the chart. Which of these colors was NOT on any bird '
                  + 'at our feeder this week?',
            ...built,
            chart: cmChart('Birds that came this week, by their color', series,
                           { band, kind: 'hbars' }),
            explain: `No ${answer} birds this week. `
                   + `We saw ${series.map(x => x.label.toLowerCase()).join(', ')}.`,
        };
    },
},

// ── Word problems ────────────────────────────────────────────────
//
// The same arithmetic the data questions ask for, wrapped in a situation the
// class is actually in. "What is 20 divided by 5" and "how many scoops of
// seed does our feeder need" are the same sum, and only one of them is a
// reason to care about the answer.

{
    id: 'word-seed-scoops',
    category: 'math',
    title: 'Seed scoops',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Today is not over, so "there were 0 visits on Sunday" is not a
        // fact about Sunday - it is a fact about the time of day the class
        // ran. A day still in progress with nothing on it is dropped; a real
        // nought on a finished day is kept, because that one is true.
        let series = cmDaySeries(s);
        const nowKey = cmDayKey(new Date());
        if (series.length && series[series.length - 1].key === nowKey
            && !series[series.length - 1].value) series = series.slice(0, -1);
        const days = series.slice(-2);
        if (days.length < 2) return null;
        const total = days.reduce((a, d) => a + d.value, 0);
        if (total < 4) return null;

        // This used to demand a divisor that went in cleanly, so a two-day
        // total of 53 got no question at all - and 53 is not a strange number
        // for two days at a feeder, it is just prime. Seed comes in whole
        // scoops, so the remainder IS the question rather than an obstacle
        // to it: a part scoop still has to go out as a whole one.
        const per = [2, 3, 4, 5][Math.floor(rng() * 4)];
        const answer = Math.ceil(total / per);
        const whole  = Math.floor(total / per);
        const rem    = total % per;

        // The tempting wrong answer is the one that drops the part scoop, so
        // it goes in deliberately rather than being left to chance.
        const wrong = [];
        if (rem) wrong.push(String(whole));
        cmNumberDistractors(answer, rng, 4).forEach(k => {
            if (wrong.length < 3 && k !== answer && !wrong.includes(String(k)))
                wrong.push(String(k));
        });
        const built = cmChoices(String(answer), wrong.slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: `Our class puts out one scoop of seed for every ${per} visits, `
                  + 'and a part scoop still has to go out as a whole one. There were '
                  + `${days[0].value} visits on ${cmDayProse(days[0].key)}, `
                  + `and ${days[1].value} visits on ${cmDayProse(days[1].key)}. `
                  + 'How many scoops of seed do we owe the feeder?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band, ordered: true }),
            explain: `${days[0].value} + ${days[1].value} = ${total} visits. `
                   + `${total} ÷ ${per} = ${whole}`
                   + (rem
                      ? ` with ${rem} left over — and `
                        + (rem === 1 ? 'that one visit still wants feeding'
                                     : `those ${rem} visits still want feeding`)
                        + `, so it is ${answer} scoops, not ${whole}. What to do `
                        + 'with a remainder depends on what you are counting.'
                      : ` exactly, so ${answer} scoops.`),
        };
    },
},

{
    id: 'word-watch-minutes',
    category: 'math',
    title: 'Minutes of birds',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const busiest = cmDaySeries(s).slice().sort((a, b) => b.value - a.value)[0];
        if (!busiest || busiest.value < 3) return null;

        const mins = 2;
        const answer = busiest.value * mins;
        const built = cmChoices(String(answer),
            cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;

        return {
            prompt: `On ${cmDayProse(busiest.key)} the feeder had `
                  + `${busiest.value} visits. If every bird stayed about `
                  + `${mins} minutes, how many minutes of birds was that altogether?`,
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band, ordered: true }),
            explain: `${busiest.value} × ${mins} = ${answer} minutes.`,
        };
    },
},

{
    id: 'word-feeder-empty',
    category: 'math',
    title: 'When does it run out?',
    bands: ['6-8'],
    build({ s, band, rng }) {
        const days = cmDaySeries(s);
        if (days.length < 3) return null;
        const perDay = Math.round(days.reduce((a, d) => a + d.value, 0) / days.length);
        if (perDay < 2) return null;

        const seedsPerVisit = 8;
        const capacity = perDay * seedsPerVisit * 5;   // about five days' worth
        const answer = Math.floor(capacity / (perDay * seedsPerVisit));

        const built = cmChoices(String(answer),
            cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;

        return {
            prompt: `Our feeder holds ${capacity} seeds, and a bird takes about `
                  + `${seedsPerVisit} seeds a visit. At this week's average of `
                  + `${perDay} visits a day, how many days until we refill it?`,
            ...built,
            chart: cmChart('Visits each day', days, { band, ordered: true, showValues: true }),
            explain: `${perDay} visits × ${seedsPerVisit} seeds = `
                   + `${perDay * seedsPerVisit} seeds a day. `
                   + `${capacity} ÷ ${perDay * seedsPerVisit} = ${answer} days.`,
        };
    },
},

// ── Math across the bands ───────────────────────────────────────
//
// The curriculum a K-8 class is actually working through, asked against this
// week's feeder. The feeder supplies the numbers; the skill being practised
// is the one named in the title.

{
    id: 'count-one-day',
    category: 'math',
    // Not "Counting": the picker lists this under Math, directly below a
    // whole subject called Counting, and "Math > Counting" reads as either
    // a mistake or a duplicate. The only title in all 104 that collided with
    // a subject name.
    title: 'Birds on one day',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const days = cmDaySeries(s).filter(d => d.value > 0 && d.value <= 20);
        if (!days.length) return null;
        const pick = cmShuffle(days, rng)[0];

        // Chart first, choices second. The options have to be spaced against
        // the scale the class will actually be reading — see
        // cmChartResolution. Built the other way round, a quiet Tuesday on a
        // busy week's axis got four options inside one gridline gap.
        const chart = cmChart('Visits each day', cmDaySeries(s),
                              { band, highlight: pick.key });
        const built = cmChartCountChoices(pick.value, rng, chart, 3);
        if (!built) return null;
        return {
            prompt: `How many birds came on ${cmDayProse(pick.key)}?`,
            ...built,
            chart,
            explain: `${pick.value} visits on ${cmDayProse(pick.key)}.`,
        };
    },
},

{
    id: 'odd-or-even',
    category: 'math',
    title: 'Odd and even',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        const days = cmDaySeries(s).filter(d => d.value > 0);
        if (!days.length) return null;
        const pick = cmShuffle(days, rng)[0];
        const answer = pick.value % 2 === 0 ? 'Even' : 'Odd';
        const built = cmChoices(answer, [answer === 'Even' ? 'Odd' : 'Even'], rng);
        if (!built) return null;
        return {
            prompt: `${pick.value} birds came on ${cmDayProse(pick.key)}. `
                  + 'Is that an odd number or an even number?',
            ...built,
            explain: pick.value % 2 === 0
                ? `${pick.value} splits into two equal groups, so it is even.`
                : `${pick.value} leaves one over when you split it in two, so it is odd.`,
        };
    },
},

{
    id: 'ordinal-rank',
    category: 'math',
    title: 'First, second, third',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        if (s.species.length < 4) return null;
        const place = 2 + Math.floor(rng() * 2);          // 2nd or 3rd
        const word  = ['', 'first', 'second', 'third', 'fourth'][place];
        const answer = s.species[place - 1].species;
        const built = cmChoices(answer,
            s.species.filter((_, i) => i !== place - 1).slice(0, 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `Put the birds in order, most visits first. Which bird is `
                  + `${word}?`,
            ...built,
            chart: cmChart('Visits by species this week', cmSpeciesSeries(s),
                           { band, showValues: true }),
            explain: `${answer} is ${word}, with `
                   + `${s.bySpecies.get(answer)} visits.`,
        };
    },
},

{
    id: 'clock-hour',
    category: 'math',
    title: 'Telling the time',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        // Design notes §11: telling the time from detection timestamps on an
        // analog clock. The clock face IS the question - the class has to
        // find the hour on a dial rather than read a digital label.
        const hours = s.byHour
            .map((n, h) => ({ h, n }))
            .filter(x => x.n > 0 && x.h >= 5 && x.h <= 20);
        if (hours.length < 3) return null;

        const busiest = hours.slice().sort((a, b) => b.n - a.n)[0];
        const h12 = busiest.h % 12 === 0 ? 12 : busiest.h % 12;
        const ampm = busiest.h < 12 ? 'in the morning' : 'in the afternoon';

        // K-2 reads the dial; the older band reads the distribution.
        const dial = band === 'k-2';

        // The dial carries a 12-hour position and nothing else, so on that
        // version the options must differ by WHERE THE HANDS POINT. Offering
        // "7 in the morning" against "7 in the afternoon" beside a clock that
        // shows both the same way is a question with two right answers and no
        // way to choose — so am/pm is dropped there, and the distractors are
        // drawn from distinct positions on the face.
        const answer = dial ? `${h12} o’clock` : `${h12} o’clock ${ampm}`;

        const seen = new Set([h12]);
        const pool = cmShuffle(hours.filter(x => x.h !== busiest.h), rng);
        const others = [];
        for (const x of pool) {
            const o12 = x.h % 12 === 0 ? 12 : x.h % 12;
            if (dial) {
                if (seen.has(o12)) continue;
                seen.add(o12);
                others.push(`${o12} o’clock`);
            } else {
                others.push(`${o12} o’clock ` + (x.h < 12 ? 'in the morning' : 'in the afternoon'));
            }
            if (others.length === 3) break;
        }
        const built = cmChoices(answer, others, rng);
        if (!built) return null;

        // K-2 gets a clock with hands on it and is asked to read it. The
        // older band gets the distribution and is asked to find the peak.
        //
        // These look like the same question and are not. Flagged on the K-2
        // version: "for this grade it would be better to show the hands of
        // the clock and ask them what time; having bubbles outside the clock
        // will confuse them." The blob chart asks a six-year-old to compare
        // circle areas and then map the biggest one back onto a dial — two
        // hard skills stacked, neither of which is telling the time, which is
        // what design notes §11 wanted the slide for in the first place.
        const series = hours.map(x => ({
            label: `${x.h % 12 === 0 ? 12 : x.h % 12}${x.h < 12 ? 'am' : 'pm'}`,
            value: x.n, key: String(x.h), hour: x.h,
        }));

        return {
            prompt: dial
                ? 'The birds were busiest at this time.\nLook at the clock — what time is it?'
                : 'Look at the clock. What time were the birds busiest?',
            ...built,
            // The older band's hands arrive with the answer, not before. Flagged
            // on the 3–5 version: "Should show clock hands as well?" — but on
            // this slide the hands would point at the answer, and the question
            // is to FIND that hour among the blobs. Drawn at the reveal, they
            // turn "the biggest blob" back into a time on a clock, which is
            // the bit of the K-2 slide this one was missing.
            chart: cmChart(dial ? 'What time is it?' : 'When the birds came', series,
                           { band, hours: true, kind: 'clock',
                             hands: dial ? { hour: busiest.h, minute: 0 } : null,
                             revealHands: dial ? null : { hour: busiest.h, minute: 0 } }),
            // Always the full phrase, even where the question dropped am/pm:
            // the reveal is where "7 o'clock" becomes "7 in the morning".
            explain: `${busiest.n} visits at ${h12} o’clock ${ampm}.`,
        };
    },
},

{
    id: 'multiply-days',
    category: 'math',
    title: 'Multiplication',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // The filter and the pick were the wrong way round: this took a day
        // at random and THEN refused if that day's count was awkward, so a
        // week with one quiet day and six busy ones failed six times in seven
        // for no reason anyone could see. Filter first, pick from what is
        // left.
        const days = cmDaySeries(s).filter(d => d.value >= 2 && d.value <= 15);
        if (!days.length) return null;
        const pick = cmShuffle(days, rng)[0];
        const weeks = 2 + Math.floor(rng() * 3);          // 2-4
        const answer = pick.value * weeks;
        const built = cmChoices(String(answer),
                                cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `There were ${pick.value} visits on ${cmDayProse(pick.key)}. `
                  + `If the next ${weeks} days were each exactly the same, how `
                  + 'many visits would that be altogether?',
            ...built,
            explain: `${pick.value} × ${weeks} = ${answer}.`,
        };
    },
},

{
    id: 'divide-share',
    category: 'math',
    title: 'Division',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const total = s.total;
        if (total < 8) return null;
        // 157 visits is an ordinary week and it divides by nothing, so
        // insisting on a clean divisor retired this question for the whole
        // fortnight. Sharing a job between groups does not stop being
        // arithmetic when it comes out uneven - somebody takes the extra, and
        // saying who is the part worth asking about.
        const clean = [2, 3, 4, 5].filter(n => total % n === 0 && total / n >= 2);
        const per = clean.length
            ? cmShuffle(clean, rng)[0]
            : cmShuffle([2, 3, 4, 5].filter(n => total / n >= 2), rng)[0];
        if (!per) return null;
        const answer = Math.floor(total / per);
        const rem    = total % per;
        const built = cmChoices(String(answer),
                                cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `Our feeder had ${total} visits this week. If ${per} groups of `
                  + 'children shared the job of counting them out as evenly as they '
                  + 'can, how many would each group count'
                  + (rem ? ', before anyone takes the leftovers?' : '?'),
            ...built,
            explain: rem
                ? `${total} ÷ ${per} = ${answer} each, with ${rem} left over. You `
                  + `cannot split ${rem} visit${rem === 1 ? '' : 's'} ${per} ways, so `
                  + `one group counts ${answer + rem} and the rest count ${answer}. `
                  + 'Deciding what happens to the remainder is part of the problem, '
                  + 'not a mistake in it.'
                : `${total} ÷ ${per} = ${answer} each, exactly.`,
        };
    },
},

{
    id: 'round-nearest-ten',
    category: 'math',
    title: 'Rounding',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const total = s.total;
        if (total < 12) return null;
        const answer = Math.round(total / 10) * 10;
        const opts = [answer - 10, answer, answer + 10, answer + 20]
            .filter(n => n >= 0);
        const built = cmChoices(String(answer),
                                cmShuffle(opts.filter(n => n !== answer), rng)
                                    .slice(0, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `Our feeder had ${total} visits this week. Rounded to the `
                  + 'nearest ten, about how many is that?',
            ...built,
            explain: `${total} rounds to ${answer}. Look at the ones digit: `
                   + `${total % 10} is ${total % 10 >= 5 ? '5 or more, so round up' : 'less than 5, so round down'}.`,
        };
    },
},

{
    id: 'fraction-of-week',
    category: 'math',
    title: 'Fractions',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const days = cmDaySeries(s);
        const withBirds = days.filter(d => d.value > 0).length;
        if (!days.length || !withBirds || withBirds === days.length) return null;
        const answer = `${withBirds} out of ${days.length}`;
        const built = cmChoices(answer,
            cmShuffle([1, 2, 3, 4, 5, 6, 7].filter(n => n !== withBirds), rng)
                .slice(0, 3).map(n => `${n} out of ${days.length}`), rng);
        if (!built) return null;
        return {
            prompt: 'On how many of the last 7 days did ANY bird come to our feeder?',
            ...built,
            chart: cmChart('Visits each day', days, { band, ordered: true }),
            explain: `${withBirds} of the 7 days had at least one visit, `
                   + `so ${withBirds}/${days.length} of the week.`,
        };
    },
},

{
    id: 'elapsed-hours',
    category: 'math',
    title: 'Elapsed time',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const active = s.byHour.map((n, h) => ({ h, n })).filter(x => x.n > 0);
        if (active.length < 2) return null;
        const first = active[0].h, last = active[active.length - 1].h;
        const answer = last - first;
        if (answer < 2) return null;

        const fmt = h => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
        const built = cmChoices(`${answer} hours`,
            cmShuffle([answer - 2, answer - 1, answer + 1, answer + 2]
                .filter(n => n > 0 && n !== answer), rng)
                .slice(0, 3).map(n => `${n} hours`), rng);
        if (!built) return null;
        return {
            prompt: `The first bird of the day arrived at ${fmt(first)} and the `
                  + `last one at ${fmt(last)}. How long was the feeder busy?`,
            ...built,
            explain: `From ${fmt(first)} to ${fmt(last)} is ${answer} hours.`,
        };
    },
},

{
    id: 'ratio-two-species',
    category: 'math',
    title: 'Ratios',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.species.length < 2) return null;
        const a = s.species[0], b = s.species[1];
        if (!a.n || !b.n) return null;

        const gcd = (x, y) => y ? gcd(y, x % y) : x;
        const g = gcd(a.n, b.n);
        const answer = `${a.n / g} : ${b.n / g}`;
        const built = cmChoices(answer,
            [`${a.n} : ${b.n + 1}`, `${b.n / g} : ${a.n / g}`, `${a.n / g + 1} : ${b.n / g}`], rng);
        if (!built) return null;
        return {
            prompt: `There were ${a.n} ${a.species} visits and ${b.n} ${b.species} `
                  + 'visits. What is that ratio in its simplest form?',
            ...built,
            chart: cmChart('Visits by species this week', cmSpeciesSeries(s),
                           { band, showValues: true }),
            explain: `${a.n} : ${b.n}, and both divide by ${g}, giving ${answer}.`,
        };
    },
},

{
    id: 'proportion-scale',
    category: 'math',
    title: 'Proportion',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (!s.species.length || s.total < 10) return null;
        const top = s.species[0];
        const share = top.n / s.total;
        if (share < 0.15 || share > 0.8) return null;

        const future = 100;
        const answer = Math.round(share * future);
        const built = cmChoices(String(answer),
                                cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `${top.n} of our ${s.total} visits this week were `
                  + `${top.species}. If the feeder gets ${future} visits next `
                  + 'month and the pattern holds, about how many would be '
                  + `${top.species}?`,
            ...built,
            explain: `${top.n}/${s.total} is about ${(share * 100).toFixed(0)}%, `
                   + `and ${(share * 100).toFixed(0)}% of ${future} is about ${answer}.`,
        };
    },
},

{
    id: 'integer-temp-change',
    category: 'math',
    title: 'Negative numbers',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.tempCoverage < 0.5 || s.dayTemp.size < 3) return null;
        const temps = [...s.dayTemp.entries()]
            .map(([day, t]) => ({ day, temp: Math.round(t.sum / t.n) }))
            .sort((a, b) => a.day.localeCompare(b.day));
        const a = temps[0], b = temps[temps.length - 1];
        const diff = b.temp - a.temp;
        if (Math.abs(diff) < 3) return null;

        const answer = `${diff > 0 ? '+' : ''}${diff}°`;
        const built = cmChoices(answer,
            [`${-diff > 0 ? '+' : ''}${-diff}°`,
             `${diff > 0 ? '+' : ''}${diff + 2}°`,
             `${a.temp + b.temp}°`], rng);
        if (!built) return null;
        return {
            prompt: `It was ${a.temp}° on ${cmDayProse(a.day)} and `
                  + `${b.temp}° on ${cmDayProse(b.day)}. What was the change `
                  + 'in temperature?',
            ...built,
            explain: `${b.temp} − ${a.temp} = ${diff}. A ${diff > 0 ? 'rise' : 'fall'} `
                   + `of ${Math.abs(diff)} degrees.`,
        };
    },
},

{
    id: 'probability-two-same',
    category: 'math',
    title: 'Compound probability',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (!s.species.length || s.total < 20) return null;
        const top = s.species[0];
        const p = top.n / s.total;
        if (p < 0.25 || p > 0.7) return null;

        const both = Math.round(p * p * 100);
        const built = cmChoices(`About ${both}%`,
            [`About ${Math.round(p * 100)}%`,
             `About ${Math.round(p * 200)}%`,
             `About ${Math.round(p * 50)}%`], rng);
        if (!built) return null;
        return {
            prompt: `About ${Math.round(p * 100)} out of every 100 visits are `
                  + `${top.species}. If two birds arrive, what is the chance BOTH `
                  + `are ${top.species}?`,
            ...built,
            explain: `Multiply the two chances: ${(p).toFixed(2)} × ${(p).toFixed(2)} `
                   + `≈ ${(p * p).toFixed(2)}, about ${both}%. Two things both `
                   + 'happening is always less likely than either one alone.',
        };
    },
},

{
    id: 'unit-rate',
    category: 'math',
    title: 'Unit rate',
    bands: ['6-8'],
    build({ s, band, rng }) {
        const active = s.byHour.map((n, h) => ({ h, n })).filter(x => x.n > 0);
        if (active.length < 4 || s.total < 20) return null;
        const span = active[active.length - 1].h - active[0].h + 1;
        if (span < 4) return null;
        const answer = (s.total / span).toFixed(1);
        const built = cmChoices(`${answer} per hour`,
            [`${(s.total / span * 2).toFixed(1)} per hour`,
             `${(s.total / span / 2).toFixed(1)} per hour`,
             `${(span / s.total).toFixed(1)} per hour`], rng);
        if (!built) return null;
        return {
            prompt: `There were ${s.total} visits this week, spread over about `
                  + `${span} daylight hours a day. What is the rate, in visits `
                  + 'per hour?',
            ...built,
            explain: `${s.total} ÷ ${span} ≈ ${answer} visits an hour. A unit `
                   + 'rate is always "how many per ONE of something".',
        };
    },
},

// ── Science ──────────────────────────────────────────────────────
//
// Most of these carry `needsData: false`: they are about birds rather than
// about this feeder's numbers, so they work on a week when nothing came. At
// a new feeder that is every week, which is the whole point.

{
    id: 'sci-what-birds-need',
    category: 'science',
    title: 'What living things need',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Food, water and a safe place',
            ['Only food', 'Only water', 'Toys to play with'], rng);
        if (!built) return null;
        return {
            prompt: 'Every living thing needs the same few things to stay alive. '
                  + 'What do the birds at our feeder need?',
            ...built,
            explain: 'Food, water, and somewhere safe to shelter and raise young. '
                   + 'A feeder gives one of the three — which is why a bush or '
                   + 'a tree nearby matters just as much as the seed.',
        };
    },
},

{
    id: 'sci-feathers',
    category: 'science',
    title: 'Body coverings',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Feathers', ['Fur', 'Scales', 'Shells'], rng);
        if (!built) return null;
        return {
            prompt: 'Cats have fur and fish have scales. What covers a bird?',
            ...built,
            explain: 'Feathers — and ONLY birds have them. Nothing else alive '
                   + 'grows a feather, so a feather on the ground is always a bird.',
        };
    },
},

{
    id: 'sci-baby-bird',
    category: 'science',
    title: 'Animal young',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('A chick', ['A puppy', 'A kitten', 'A calf'], rng);
        if (!built) return null;
        return {
            prompt: 'A baby dog is a puppy. What is a baby bird called?',
            ...built,
            explain: 'A chick. A very young one still in the nest is a nestling, '
                   + 'and one that has just left it is a fledgling.',
        };
    },
},

{
    id: 'sci-beak-shape',
    category: 'science',
    title: 'Adaptation',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Cracking seeds',
            ['Catching fish', 'Tearing meat', 'Sipping nectar'], rng);
        if (!built) return null;
        return {
            prompt: 'A cardinal has a short, thick, cone-shaped beak. What is a '
                  + 'beak that shape FOR?',
            ...built,
            explain: 'Cracking seeds. A beak is a tool, and its shape tells you '
                   + 'what the bird eats: long and thin for nectar, hooked for '
                   + 'meat, spear-shaped for fish.',
            fact: 'This is why a feeder full of sunflower seed attracts cardinals '
                + 'and finches but not herons.',
        };
    },
},

{
    id: 'sci-life-cycle',
    category: 'science',
    title: 'Life cycles',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Egg, nestling, fledgling, adult',
            ['Nestling, egg, adult, fledgling',
             'Egg, fledgling, nestling, adult',
             'Fledgling, egg, nestling, adult'], rng);
        if (!built) return null;
        return {
            prompt: 'Put a bird’s life in the right order.',
            ...built,
            explain: 'Egg → nestling (helpless, in the nest) → fledgling '
                   + '(out of the nest, still being fed) → adult. A fledgling '
                   + 'hopping on the ground has usually NOT been abandoned.',
        };
    },
},

{
    id: 'sci-why-migrate',
    category: 'science',
    title: 'Migration',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('The food they eat runs out',
            ['They get too cold', 'They get bored', 'The days get shorter'], rng);
        if (!built) return null;
        return {
            prompt: 'Many birds fly thousands of miles south for winter. What is '
                  + 'the main reason they go?',
            ...built,
            explain: 'Food. A bird in a good coat of feathers handles cold far '
                   + 'better than it handles a winter with no insects. Birds that '
                   + 'eat seeds, like cardinals and chickadees, mostly stay put.',
        };
    },
},

{
    id: 'sci-camouflage',
    category: 'science',
    title: 'Camouflage',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('She sits on the nest and must not be seen',
            ['She is younger than the male',
             'She cannot make bright colors',
             'Brown feathers are warmer'], rng);
        if (!built) return null;

        // The pair is the evidence. Without it this asks a class to reason
        // about a difference it never shows them — fine for a child who has
        // seen a cardinal pair, an act of faith for one who has not.
        const pair = cmSexedPair(rng);

        return {
            // No "s" on the species name: pluralising these by rule gives
            // "House Finchs", and the exceptions are not worth a table.
            prompt: pair
                ? `Here is a male and a female ${pair.species}. The male is bright `
                + 'and the female is plain brown. Why would being dull be an ADVANTAGE?'
                : 'In many birds the male is brightly colored and the female is '
                + 'plain brown. Why would being dull be an ADVANTAGE?',
            ...built,
            pair,
            about_bird: pair ? pair.species : null,
            explain: 'The female does most of the sitting on the nest, where being '
                   + 'invisible to a hawk matters more than being noticed by a '
                   + 'mate. Two jobs, two sets of feathers.',
        };
    },
},

{
    id: 'sci-food-chain',
    category: 'science',
    title: 'Food chains',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Sunflower → sparrow → hawk',
            ['Hawk → sparrow → sunflower',
             'Sparrow → sunflower → hawk',
             'Sunflower → hawk → sparrow'], rng);
        if (!built) return null;
        return {
            prompt: 'Which food chain runs the right way?',
            ...built,
            explain: 'The arrow means "is eaten by", so it always points the way '
                   + 'the ENERGY travels: from the plant, which made it from '
                   + 'sunlight, to whatever eats the thing before it.',
            fact: 'A hawk near a feeder is not a disaster — it is the food chain '
                + 'the feeder created, working.',
        };
    },
},

{
    id: 'sci-trophic-level',
    category: 'science',
    title: 'Energy in ecosystems',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('About 10%',
            ['About 1%', 'About 50%', 'About 90%'], rng);
        if (!built) return null;
        return {
            prompt: 'When a sparrow eats seeds, only some of that energy becomes '
                  + 'sparrow. Roughly how much passes up to the next level?',
            ...built,
            explain: 'About 10%. The rest is spent staying warm, moving and '
                   + 'breathing. It is why food chains are short and why there are '
                   + 'always far fewer hawks than sparrows.',
        };
    },
},

{
    id: 'sci-natural-selection',
    category: 'science',
    title: 'Natural selection',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Birds with thicker beaks survived and had chicks',
            ['Birds grew thicker beaks to cope',
             'Birds decided to eat different seeds',
             'The seeds became softer over time'], rng);
        if (!built) return null;
        return {
            prompt: 'After a drought left only tough, hard seeds, the finches on one '
                  + 'island had thicker beaks within a few years. What actually '
                  + 'happened?',
            ...built,
            explain: 'The beaks did not change — the BIRDS did. Thin-beaked '
                   + 'finches could not crack the hard seeds and died; thick-beaked '
                   + 'ones ate, bred, and passed it on. Selection acts on a '
                   + 'population, never on an individual.',
            fact: 'This was measured in real time on Daphne Major in the Galápagos, '
                + 'over a single drought.',
        };
    },
},

{
    id: 'sci-introduced-species',
    category: 'science',
    title: 'Introduced species',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('They were brought here by people',
            ['They flew here from Europe',
             'They evolved here recently',
             'They were blown off course in a storm'], rng);
        if (!built) return null;
        return {
            prompt: 'House Sparrows and European Starlings are two of the commonest '
                  + 'birds in North America, but neither is native. How did they '
                  + 'get here?',
            ...built,
            explain: 'People released them deliberately in the 1800s. Both spread '
                   + 'across the continent in decades and now compete with native '
                   + 'birds for the holes they nest in.',
        };
    },
},

{
    id: 'sci-variable',
    category: 'science',
    title: 'Designing an experiment',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('The temperature',
            ['The number of visits', 'The kind of seed', 'The time of day'], rng);
        if (!built) return null;
        return {
            prompt: 'We want to find out whether cold weather changes how many '
                  + 'birds visit. Which is the INDEPENDENT variable — the thing '
                  + 'we are testing the effect of?',
            ...built,
            explain: 'Temperature is the independent variable; the number of visits '
                   + 'is the dependent one, because it is what we measure. Keeping '
                   + 'the seed and the time of day the same is what makes the test '
                   + 'fair.',
        };
    },
},

// ── Geography ────────────────────────────────────────────────────

{
    id: 'geo-cardinal-range',
    category: 'geography',
    title: 'Where a bird lives',
    bands: ['3-5', '6-8'],
    needsData: false,
    build({ s, rng }) {
        const built = cmChoices('Oregon', ['Ohio', 'Georgia', 'Missouri'], rng);
        if (!built) return null;
        return {
            prompt: 'Northern Cardinals live across the eastern and central United '
                  + 'States, but not in the far west. In which of these states '
                  + 'would you NOT expect to find one?',
            ...built,
            image: cmShotFor(s, 'Northern Cardinal') || cmWonderPhoto('Northern Cardinal'),
            map: {
                highlight: ['me', 'nh', 'vt', 'ma', 'ri', 'ct', 'ny', 'nj', 'pa',
                            'de', 'md', 'va', 'wv', 'nc', 'sc', 'ga', 'fl', 'oh',
                            'in', 'il', 'mi', 'wi', 'ky', 'tn', 'al', 'ms', 'ar',
                            'la', 'mo', 'ia', 'ks', 'ne', 'ok', 'tx', 'sd'],
                caption: 'Roughly where Northern Cardinals live',
            },
            // The answer is a STATE, so the automatic rule finds no bird.
            // The question is still about the cardinal.
            about_bird: 'Northern Cardinal',
            explain: 'Oregon. The cardinal’s range stops around the Great Plains '
                   + '— it is a bird of the east, which is why seven eastern '
                   + 'states claim it and no western one does.',
        };
    },
},

{
    id: 'geo-hemisphere',
    category: 'geography',
    title: 'Hemispheres and seasons',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('It is summer there',
            ['It is winter there too',
             'The days are shorter there',
             'There is no winter at the equator'], rng);
        if (!built) return null;
        return {
            prompt: 'Arctic Terns leave the Arctic in autumn and fly to Antarctica. '
                  + 'Why is that worth a 22,000-mile trip?',
            ...built,
            explain: 'The seasons are flipped in the southern hemisphere, so the '
                   + 'tern arrives in the Antarctic summer. It chases daylight, and '
                   + 'sees more of it in a year than any other animal.',
        };
    },
},

{
    id: 'geo-continents',
    category: 'geography',
    title: 'Continents',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const picks = [
            { bird: 'Emperor Penguin', place: 'Antarctica', others: ['Africa', 'Europe', 'Asia'] },
            { bird: 'Superb Lyrebird', place: 'Australia',  others: ['South America', 'Africa', 'Europe'] },
            { bird: 'Bar-headed Goose', place: 'Asia',      others: ['Antarctica', 'Australia', 'North America'] },
        ];
        const pick = cmShuffle(picks, rng)[0];
        const built = cmChoices(pick.place, pick.others, rng);
        if (!built) return null;
        return {
            template_id: 'geo-continent-' + pick.place.toLowerCase().replace(/\s+/g, '-'),
            prompt: `On which continent would you find a wild ${pick.bird}?`,
            ...built,
            image: cmWonderPhoto(pick.bird),
            about_bird: pick.bird,
            explain: `The ${pick.bird} lives in ${pick.place}.`,
        };
    },
},

{
    id: 'geo-flyway',
    category: 'geography',
    title: 'Migration routes',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('They follow coastlines, rivers and mountain ranges',
            ['They follow roads and cities',
             'They each pick their own way',
             'They follow the warmest air'], rng);
        if (!built) return null;
        return {
            prompt: 'Millions of migrating birds funnel along the same few routes '
                  + 'every year, called flyways. What are they following?',
            ...built,
            explain: 'Coastlines, river valleys and mountain ranges — landscape '
                   + 'features that run the right way and offer food and shelter on '
                   + 'the journey. North America has four main flyways.',
        };
    },
},

// ── History ──────────────────────────────────────────────────────

{
    id: 'hist-passenger-pigeon',
    category: 'history',
    title: 'Extinction',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('It was the commonest bird in North America',
            ['It was always rare',
             'It only lived on one island',
             'It could not fly'], rng);
        if (!built) return null;
        return {
            prompt: 'The last Passenger Pigeon died in 1914. What is most surprising '
                  + 'about that?',
            ...built,
            explain: 'Flocks of billions once darkened the sky for hours. Hunting '
                   + 'and forest clearing took it from the commonest bird on the '
                   + 'continent to extinct in about fifty years — which is why '
                   + '"there are plenty of them" is not the same as "they are safe".',
        };
    },
},

{
    id: 'hist-feather-trade',
    category: 'history',
    title: 'Conservation',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('To decorate hats',
            ['To stuff pillows', 'To make paintbrushes', 'To write with'], rng);
        if (!built) return null;
        return {
            prompt: 'Around 1900, egrets and herons were hunted almost to extinction '
                  + 'in America. What were their feathers used for?',
            ...built,
            explain: 'Fashionable hats. The outcry led to some of the first bird '
                   + 'protection laws and to the founding of the Audubon societies '
                   + '— conservation in the United States effectively started '
                   + 'with this argument.',
        };
    },
},

// ── Language arts ────────────────────────────────────────────────
//
// Bird names turn out to be a good supply of exactly the things a primary
// language curriculum drills: syllables, compound words, alphabetical order,
// adjectives, and a pile of idioms nobody has explained to a nine-year-old.

{
    id: 'lang-syllables',
    category: 'language',
    title: 'Syllables',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        // Counted from the written name, so only names where the count is
        // not arguable are used.
        const KNOWN = { 'Blue Jay': 2, 'Cardinal': 3, 'Chickadee': 3, 'Wren': 1,
                        'Robin': 2, 'Sparrow': 2, 'Titmouse': 2, 'Nuthatch': 2,
                        'Goldfinch': 2, 'Woodpecker': 3, 'Mockingbird': 3,
                        'Starling': 2, 'Junco': 2, 'Dove': 1 };
        const here = s.species.map(x => cmShortName(x.species).charAt(0)
                                      + cmShortName(x.species).slice(1).toLowerCase());
        const usable = Object.keys(KNOWN).filter(w =>
            here.some(h => h.toLowerCase() === w.toLowerCase().split(' ').pop()));
        const pool = usable.length ? usable : Object.keys(KNOWN);

        const word = cmShuffle(pool, rng)[0];
        const n = KNOWN[word];
        const built = cmChoices(String(n),
            cmShuffle([1, 2, 3, 4].filter(x => x !== n), rng).slice(0, 3).map(String), rng);
        if (!built) return null;
        return {
            template_id: 'lang-syllables-' + word.toLowerCase().replace(/\s+/g, '-'),
            prompt: `Clap it out. How many syllables are in ${word.toUpperCase()}?`,
            ...built,
            explain: `${word} has ${n} — one clap for each beat you say.`,
        };
    },
},

{
    id: 'lang-compound-word',
    category: 'language',
    title: 'Compound words',
    bands: ['k-2', '3-5'],
    needsData: false,
    build({ rng }) {
        const picks = [
            { word: 'GOLDFINCH', parts: 'gold + finch', others: ['CARDINAL', 'SPARROW', 'JUNCO'] },
            { word: 'WOODPECKER', parts: 'wood + pecker', others: ['ROBIN', 'TITMOUSE', 'WREN'] },
            { word: 'MOCKINGBIRD', parts: 'mocking + bird', others: ['STARLING', 'CARDINAL', 'DOVE'] },
            { word: 'BLUEBIRD', parts: 'blue + bird', others: ['SPARROW', 'JUNCO', 'FINCH'] },
        ];
        const pick = cmShuffle(picks, rng)[0];
        const built = cmChoices(pick.word, pick.others, rng);
        if (!built) return null;
        return {
            template_id: 'lang-compound-' + pick.word.toLowerCase(),
            prompt: 'A compound word is two smaller words stuck together. Which of '
                  + 'these bird names is a compound word?',
            ...built,
            explain: `${pick.word} = ${pick.parts}.`,
        };
    },
},

{
    id: 'lang-alphabetical',
    category: 'language',
    title: 'Alphabetical order',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        if (s.species.length < 3) return null;
        const names = cmShuffle(s.species.map(x => x.species), rng).slice(0, 4);
        if (names.length < 3) return null;
        const first = names.slice().sort((a, b) => a.localeCompare(b))[0];
        const built = cmChoices(first, names.filter(n => n !== first), rng);
        if (!built) return null;
        return {
            prompt: 'If you put these birds in alphabetical order, which one comes '
                  + 'FIRST?',
            ...built,
            explain: `${first}. Compare the first letters; if those match, move on `
                   + 'to the second.',
        };
    },
},

{
    id: 'lang-adjective',
    category: 'language',
    title: 'Adjectives',
    bands: ['3-5'],
    build({ s, band, rng }) {
        const two = s.species
            .map(x => x.species)
            .filter(n => n.split(' ').length === 2
                      && /^(Northern|Eastern|Western|Southern|Blue|Red|White|American|Carolina|House|Mourning|Downy|Tufted)\b/.test(n));
        if (!two.length) return null;
        const name = cmShuffle(two, rng)[0];
        const [adj, noun] = name.split(' ');
        const built = cmChoices(adj, [noun, 'bird', 'feeder'], rng);
        if (!built) return null;
        return {
            prompt: `In the name "${name}", which word is the adjective — the `
                  + 'word that DESCRIBES?',
            ...built,
            explain: `"${adj}" describes which kind of ${noun} it is. Bird names `
                   + 'nearly all work this way: a describing word, then the family.',
        };
    },
},

{
    id: 'lang-idiom',
    category: 'language',
    title: 'Idioms',
    bands: ['3-5', '6-8'],
    needsData: false,
    build({ rng }) {
        const picks = [
            { idiom: 'a night owl',        means: 'Someone who stays up late',
              others: ['Someone who is very wise', 'Someone who is hard to find', 'Someone who eats little'] },
            { idiom: 'to eat like a bird', means: 'To eat very little',
              others: ['To eat very fast', 'To eat standing up', 'To eat only seeds'] },
            { idiom: 'a little bird told me', means: 'I heard it from someone I will not name',
              others: ['I guessed it', 'I read it somewhere', 'I made it up'] },
            { idiom: 'the early bird gets the worm', means: 'Whoever starts first does best',
              others: ['Mornings are difficult', 'Worms wake up early', 'Patience is rewarded'] },
        ];
        const pick = cmShuffle(picks, rng)[0];
        const built = cmChoices(pick.means, pick.others, rng);
        if (!built) return null;
        return {
            template_id: 'lang-idiom-' + pick.idiom.replace(/\W+/g, '-'),
            prompt: `What does it mean to call someone "${pick.idiom}"?`,
            ...built,
            explain: 'An idiom means something the words alone do not say — which '
                   + 'is why they are hard for anyone learning the language.',
            fact: 'Ironically, birds eat an enormous amount for their size: a '
                + 'chickadee can eat a third of its body weight in a day.',
        };
    },
},

{
    id: 'lang-onomatopoeia',
    category: 'language',
    title: 'Onomatopoeia',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Chickadee', ['Cardinal', 'Starling', 'Junco'], rng);
        if (!built) return null;
        return {
            prompt: 'An onomatopoeia is a word that sounds like the thing it names, '
                  + 'like BUZZ or SPLASH. Which of these birds is named after the '
                  + 'sound it makes?',
            ...built,
            explain: 'The chickadee says "chick-a-dee-dee-dee" and was named for it. '
                   + 'So were the killdeer, the whip-poor-will and the cuckoo.',
            about_bird: 'Carolina Chickadee',
        };
    },
},

{
    id: 'lang-prefix',
    category: 'language',
    title: 'Prefixes and roots',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('The study of birds',
            ['The study of eggs', 'The study of flight', 'The study of feathers'], rng);
        if (!built) return null;
        return {
            prompt: 'ORNITHOLOGY comes from the Greek "ornis", meaning bird, and '
                  + '"-ology", meaning the study of. What is ornithology?',
            ...built,
            explain: 'The study of birds. "-ology" gives you biology, geology and '
                   + 'hundreds more — learn the ending and you can take a guess '
                   + 'at any of them.',
        };
    },
},

// ── Art ──────────────────────────────────────────────────────────

{
    id: 'art-symmetry',
    category: 'art',
    title: 'Symmetry',
    bands: ['k-2', '3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Down the middle, head to tail',
            ['Across the middle, side to side',
             'Corner to corner',
             'A bird has no line of symmetry'], rng);
        if (!built) return null;
        return {
            prompt: 'A bird seen from the front is symmetrical. Where is its line '
                  + 'of symmetry?',
            ...built,
            // A DRAWING, NOT A PHOTOGRAPH, and that is the whole decision.
            //
            // Asked for: "it would be better as part of the reveal to show a
            // bird to see the symmetry." Right — and a feeder photograph is
            // the wrong way to grant it. Nearly every shot a camera gets is
            // side-on, which is the one view in which a bird's symmetry is
            // invisible, so the picture would quietly contradict the answer
            // the class had just been told was correct. There is no way to
            // ask the feeder for a head-on bird.
            //
            // So the reveal carries a diagram of the thing the question
            // actually describes: a bird seen FROM THE FRONT, with the line
            // down it. Inline SVG through the existing image path, so it
            // needs no new rendering and no network.
            image: { url: cmSymmetryDiagram() },
            image_on_reveal: true,
            explain: 'Straight down the middle: one wing, one eye and one foot on '
                   + 'each side, mirrored. Almost every animal is built this way, '
                   + 'which is why a drawing looks wrong the moment it is not. '
                   + 'You cannot see it in most feeder photos because the bird is '
                   + 'side-on — turn it to face you and the two halves match.',
        };
    },
},

{
    id: 'art-pattern',
    category: 'art',
    title: 'Pattern',
    bands: ['k-2', '3-5'],
    build({ s, band, rng, source }) {
        const pool = s.species
            .map(x => ({ species: x.species, look: speciesLook(x.species) }))
            .filter(x => x.look && /stripe|zebra|spot|bar|cap|necklace/i.test(x.look.feature));
        if (!pool.length) return null;
        const pick = cmShuffle(pool, rng)[0];
        const built = cmChoices(pick.species,
            cmShuffle(s.species.map(x => x.species).filter(n => n !== pick.species), rng)
                .slice(0, 3), rng);
        if (!built) return null;
        // "Our birds" is a lie when the week came from a partner's feeder,
        // and the prompt is the part that gets read aloud — the amber
        // partner badge beside it is small print nobody announces.
        const ours = !source || source.isHome;
        return {
            prompt: `Artists look for pattern: stripes, spots, bars. Which of `
                  + `${ours ? 'our' : 'these'} birds has ${pick.look.feature}?`,
            ...built,
            image: cmShotFor(s, pick.species),
            explain: `The ${pick.species} — look for ${pick.look.feature}.`,
            about_bird: pick.species,
        };
    },
},

{
    id: 'art-scale',
    category: 'art',
    title: 'Scale and proportion',
    bands: ['3-5', '6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Draw the head about as wide as the body is deep',
            ['Draw the head the same size as the body',
             'Draw the head twice the size of the body',
             'Size does not matter in a drawing'], rng);
        if (!built) return null;
        return {
            prompt: 'A drawing of a bird looks wrong when the proportions are off. '
                  + 'What is the usual rule of thumb for a songbird’s head?',
            ...built,
            explain: 'Roughly a third of the body length, and about as wide as the '
                   + 'body is deep. Artists block in simple shapes at the right '
                   + 'sizes first, then add feathers — proportion before detail.',
        };
    },
},

{
    id: 'art-complementary',
    category: 'art',
    title: 'Complementary colors',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Green', ['Blue', 'Orange', 'Yellow'], rng);
        if (!built) return null;
        return {
            prompt: 'On the color wheel, complementary colors sit opposite each '
                  + 'other and make each other look brighter. A cardinal is red — '
                  + 'which color is its complement?',
            ...built,
            explain: 'Green. It is exactly why a cardinal looks so startling against '
                   + 'summer leaves, and why photographers wait for that background.',
            about_bird: 'Northern Cardinal',
        };
    },
},

// ── Music ────────────────────────────────────────────────────────

{
    id: 'music-pitch',
    category: 'music',
    title: 'High and low',
    bands: ['k-2', '3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('The small bird',
            ['The big bird', 'They sound the same', 'It depends on the weather'], rng);
        if (!built) return null;
        return {
            prompt: 'A tiny chickadee and a big crow are both calling. Which one '
                  + 'makes the HIGHER sound?',
            ...built,
            explain: 'The small one. Smaller instruments make higher notes — a '
                   + 'piccolo against a tuba, a violin against a cello — and '
                   + 'birds are no different.',
        };
    },
},

{
    id: 'music-rhythm',
    category: 'music',
    title: 'Rhythm',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Short-short-LONG',
            ['LONG-LONG-LONG', 'Short-LONG-short', 'All the same length'], rng);
        if (!built) return null;
        return {
            prompt: 'The Eastern Towhee sings "drink your TEEEEA". Clap that rhythm. '
                  + 'What pattern is it?',
            ...built,
            explain: 'Two short beats and one long one. Writing a birdsong down as '
                   + 'a rhythm is how birders remember them, and it is the same '
                   + 'skill as reading a bar of music.',
            about_bird: 'Eastern Towhee',
        };
    },
},

{
    id: 'music-dawn-chorus',
    category: 'music',
    title: 'Why birds sing',
    bands: ['3-5', '6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('To claim a territory and attract a mate',
            ['Because they are happy',
             'To warn about the weather',
             'To call their chicks to feed'], rng);
        if (!built) return null;
        return {
            prompt: 'Birds sing loudest at dawn, before they eat. What is a song '
                  + 'actually FOR?',
            ...built,
            explain: 'Two jobs at once: "this patch is mine" and "I am healthy, nest '
                   + 'with me". Dawn air is still and sound carries furthest, so a '
                   + 'song costs least and reaches most just after first light.',
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Written from the standards, not from the data
// ════════════════════════════════════════════════════════════════════
//
//  Every template above was written by asking "what can we ask about this
//  week's birds?" and then checked against Florida's benchmarks after the
//  fact. These were written the other way round: `node tools/check-alignment.js
//  --gaps` listed 71 benchmarks in the catalogue that nothing asked about,
//  and each of these answers one of them.
//
//  That ordering matters more than it sounds. Asking what the data can
//  support produces a lot of counting and comparing, because that is what
//  detections are — and it never produces a box plot, a scatter plot, a
//  scaled pictograph or a question about telling an observation from an
//  inference, because nothing about a row in a table suggests them. Those
//  are the things a curriculum coordinator looks for.
//
//  THE GUARDS ARE STRICTER HERE, deliberately. A question about the spread
//  of a distribution needs a distribution: several of these refuse to build
//  below a threshold that has nothing to do with whether the arithmetic
//  would work. A box plot of five identical days is arithmetically fine and
//  pedagogically worthless.
// ════════════════════════════════════════════════════════════════════

// ── Reading a chart, K–2 and 3–5 ────────────────────────────────────

{
    // MA.2.DP.1.1 and MA.3.DP.1.1 both name "scaled pictographs", and the
    // scale is the whole lesson: a child who counts six birds and answers
    // six has read the picture and missed the chart.
    id: 'picto-read',
    category: 'counting',
    title: 'Read the picture graph',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        const top = s.species.slice(0, band === 'k-2' ? 4 : 5);
        if (top.length < 3) return null;

        // ⚠ THE QUESTION ASKS "ABOUT HOW MANY", AND IT HAS TO.
        //
        // The first version of this asked for the exact count, which a
        // pictograph cannot give: 46 visits against a key of 10 is drawn as
        // four and a half birds, and a class reading the chart perfectly
        // answers 45. Requiring the key to divide the row exactly was the
        // obvious fix and it was wrong too — against real counts (99, 46,
        // 36) no round key divides any of them, and the question simply
        // stopped building.
        //
        // So the question matches what the chart can actually say. Reading
        // a pictograph to the nearest half symbol IS the skill
        // MA.3.DP.1.2 names; pretending it is exact would teach a habit
        // that falls apart on the first real chart a child meets. The
        // explain says the true count and why it differs, which is a
        // better lesson than the one the exact question was trying to give.
        const chart = cmPictograph('Visits this week', cmSpeciesSeries(s, top.length),
                                   { band, highlight: top[1].species });
        // Null when no scale above 1 is warranted — at that size the tally
        // chart is the right chart and already exists.
        if (!chart) return null;

        // Whatever the small-row filter left, second row down: the top row
        // is the one a class can answer by recognising "the longest", which
        // is not the same as using the key.
        const pick = chart.series[1];
        if (!pick) return null;

        const units  = Math.round((pick.value / chart.per) * 2) / 2;
        const shown  = units * chart.per;
        const half   = units % 1 ? '½' : '';
        const label  = `${Math.floor(units) || ''}${half}`;

        const built = cmChoices(`about ${shown}`,
            // The wrong answer this question is FOR: the number of symbols,
            // read straight off the picture without using the key at all.
            [`about ${units}`, `about ${shown * 2}`, `about ${Math.round(shown / 2)}`], rng);
        if (!built) return null;

        return {
            prompt: `Use the key. About how many times did a ${pick.label} visit?`,
            ...built,
            chart,
            image: cmShotFor(s, pick.key),
            explain: `${label} bird symbol${units === 1 ? '' : 's'}, and each one stands `
                   + `for ${chart.per} visits — so about ${shown}, not ${units}. `
                   + (pick.value === shown
                      ? 'Here the chart happens to land exactly on the real count.'
                      : `The real count was ${pick.value}: a picture graph rounds to the `
                        + `nearest half symbol, which is why the question says "about".`),
            about_bird: pick.key,
        };
    },
},

{
    // ELA.1.R.2.1 and ELA.2.R.2.1 list graphs among the TEXT FEATURES a
    // child has to use to understand a text. A chart with its title taken
    // off is the cleanest way to ask whether they were reading it.
    id: 'chart-title',
    category: 'analysis',
    title: 'What is this chart about?',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        if (s.days.length < 5 || s.total < 10) return null;

        const built = cmChoices('How many birds came each day',
            ['How many different kinds of bird came',
             'What the weather was each day',
             'What time of day the birds came'], rng);
        if (!built) return null;

        const chart = cmChart('', cmDaySeries(s), { band, kind: 'bars' });
        if (!chart) return null;
        // The title is the answer, so it cannot also be the caption.
        chart.caption = 'This chart has lost its title';

        return {
            prompt: band === 'k-2'
                ? 'Someone rubbed out the title. What is this chart showing?'
                : 'The title is missing. What does this chart show?',
            ...built,
            chart,
            explain: 'One bar for each day, and each bar is as tall as the number of '
                   + 'visits that day. The labels along the bottom are days, so the '
                   + 'heights have to be a count of something per day.',
        };
    },
},

// ── Measures of centre and spread ───────────────────────────────────

{
    // MA.4.DP.1.2 names mode, median and range together. Median and range
    // already had questions; the mode did not.
    id: 'mode-daily',
    category: 'math',
    title: 'The most common count',
    bands: ['3-5', '6-8'],
    build({ s, band, rng }) {
        if (s.days.length < 6) return null;

        const counts = new Map();
        s.days.forEach(d => counts.set(d.n, (counts.get(d.n) || 0) + 1));
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);

        // A mode that only ties for first is not a mode a class can name,
        // and "there is no mode" is a fair answer we are not asking for.
        if (!best.length || best[0][1] < 2) return null;
        if (best.length > 1 && best[1][1] === best[0][1]) return null;

        const mode = best[0][0];
        const vals = s.days.map(d => d.n);
        const mean = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);

        const built = cmChoices(String(mode),
            [String(mean), String(Math.max(...vals))]
                .concat(cmNumberDistractors(mode, rng, 1).map(String)), rng);
        if (!built) return null;

        return {
            prompt: 'What is the MODE of the daily visit counts this week?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band, showValues: true }),
            explain: `${vals.slice().sort((a, b) => a - b).join(', ')} — `
                   + `${mode} appears ${best[0][1]} times, more than any other count. `
                   + `The mode is the value that happens most, not the biggest value `
                   + `and not the average.`,
        };
    },
},

{
    // MA.6.DP.1.3 — read the five-number summary off a box plot.
    id: 'box-quartile',
    category: 'math',
    title: 'Reading a box plot',
    bands: ['6-8'],
    build({ s14, rng }) {
        const vals = s14.days.map(d => d.n);
        if (vals.length < 8) return null;

        const chart = cmBoxPlot('Daily visits over the last two weeks', vals,
                                { xLabel: 'visits in a day' });
        if (!chart) return null;

        const f = chart.five;
        const ask = cmShuffle([
            { k: 'median', v: f.med,
              why: 'half the days were below it and half above' },
            { k: 'lower quartile', v: f.q1,
              why: 'a quarter of the days were quieter than this' },
            { k: 'upper quartile', v: f.q3,
              why: 'three quarters of the days were below this' },
        ], rng)[0];

        const others = [f.min, f.max, f.med, f.q1, f.q3]
            .filter(v => v !== ask.v).map(String);
        const built = cmChoices(String(ask.v), [...new Set(others)].slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: `What is the ${ask.k} of the daily visit counts?`,
            ...built,
            chart,
            explain: `${ask.v} — ${ask.why}. The box runs from the lower quartile `
                   + `(${f.q1}) to the upper quartile (${f.q3}); the heavy line inside `
                   + `it is the median (${f.med}), and the whiskers reach the quietest `
                   + `day (${f.min}) and the busiest (${f.max}).`,
        };
    },
},

{
    // MA.6.DP.1.4 — describe spread and distribution: symmetry, skewness,
    // gaps, clusters, outliers. A histogram is the chart it names, and it
    // is just bars over bins.
    id: 'histogram-spread',
    category: 'analysis',
    title: 'The shape of the data',
    bands: ['6-8'],
    build({ s14, band, rng }) {
        const vals = s14.days.map(d => d.n);
        if (vals.length < 10) return null;

        const max = Math.max(...vals), min = Math.min(...vals);
        if (max - min < 4) return null;                 // nothing to describe

        const binSize = cmNiceStep(max - min);
        const bins = new Map();
        vals.forEach(v => {
            const b = Math.floor(v / binSize) * binSize;
            bins.set(b, (bins.get(b) || 0) + 1);
        });
        if (bins.size < 3) return null;

        const series = [...bins.entries()].sort((a, b) => a[0] - b[0])
            .map(([b, n]) => ({ label: `${b}–${b + binSize - 1}`, value: n, key: String(b) }));

        // Where the mean sits relative to the median is the honest test of
        // skew, and it is the one a class can check for itself afterwards.
        const sorted = vals.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const gap = (mean - median) / (max - min);

        const answer = gap > 0.08  ? 'Most days are quiet, with a few much busier ones'
                     : gap < -0.08 ? 'Most days are busy, with a few much quieter ones'
                     : 'The days are spread fairly evenly around the middle';

        const built = cmChoices(answer, [
            'Most days are quiet, with a few much busier ones',
            'Most days are busy, with a few much quieter ones',
            'The days are spread fairly evenly around the middle',
            'Every day had almost exactly the same number of visits',
        ].filter(x => x !== answer).slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: 'Each bar counts the DAYS that fell in that range of visits. '
                  + 'Which best describes the shape?',
            ...built,
            chart: cmChart('How many days fell in each range', series,
                           { band, kind: 'bars', plain: true, showValues: true }),
            explain: `The mean is ${mean.toFixed(1)} and the median is ${median}. `
                   + (Math.abs(gap) <= 0.08
                      ? 'They are close, so the distribution is roughly symmetric.'
                      : `The mean is pulled ${mean > median ? 'up' : 'down'} away from `
                        + `the median, which is what a tail on the `
                        + `${mean > median ? 'high' : 'low'} side does to it.`),
        };
    },
},

{
    // MA.6.DP.1.6 — how a change in the data moves the centre and the
    // spread. Asked as a thought experiment on this week's real numbers,
    // which is what "given a real-world scenario" is asking for.
    id: 'center-shift',
    category: 'math',
    title: 'What one big day does',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.days.length < 6) return null;
        const vals = s.days.map(d => d.n);
        const max = Math.max(...vals);
        if (max < 4) return null;

        const extra = max * 3;
        const sorted = vals.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const med0 = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const mean0 = vals.reduce((a, b) => a + b, 0) / vals.length;

        const v2 = vals.concat([extra]).sort((a, b) => a - b);
        const m2 = Math.floor(v2.length / 2);
        const med1 = v2.length % 2 ? v2[m2] : (v2[m2 - 1] + v2[m2]) / 2;
        const mean1 = v2.reduce((a, b) => a + b, 0) / v2.length;

        // Only worth asking where the two really do behave differently —
        // that difference IS the benchmark.
        if (!(mean1 - mean0 > Math.abs(med1 - med0) + 0.5)) return null;

        const built = cmChoices('The mean moves a lot; the median barely moves',
            ['Both move by about the same amount',
             'The median moves a lot; the mean barely moves',
             'Neither changes, because it is only one day'], rng);
        if (!built) return null;

        return {
            prompt: `Suppose tomorrow a flock arrives and we record ${extra} visits in `
                  + `one day. What happens to this week's mean and median?`,
            ...built,
            chart: cmChart('Visits each day this week', cmDaySeries(s),
                           { band, showValues: true }),
            explain: `Mean ${mean0.toFixed(1)} → ${mean1.toFixed(1)}, median ${med0} → `
                   + `${med1}. The mean adds every value up, so one huge day drags it; `
                   + `the median only cares which value sits in the middle, and one `
                   + `extra day at the top shifts that by one place at most. That is `
                   + `why an outlier is a reason to quote the median.`,
        };
    },
},

// ── Two variables at once ───────────────────────────────────────────

{
    // MA.8.DP.1.1 and MA.8.DP.1.2 — construct a scatter plot from
    // bivariate data and describe the association. Temperature and visits
    // are the only two numbers a feeder measures on the same days, which
    // makes this the one honest scatter plot in the whole module.
    id: 'scatter-temp',
    category: 'analysis',
    title: 'Temperature against visits',
    bands: ['6-8'],
    build({ s14, rng }) {
        const pts = [];
        s14.days.forEach(d => {
            const t = s14.dayTemp.get(d.day);
            if (t && t.n >= 3) {
                pts.push({ x: Math.round(t.sum / t.n), y: d.n,
                           label: cmDayAxisLabel(d.day),
                           color: cmHeatColor(0.5) });
            }
        });
        if (pts.length < 7) return null;

        // Colour by temperature once the range is known, so the plot says
        // cold-to-warm twice over — position and hue.
        const xs = pts.map(p => p.x);
        const lo = Math.min(...xs), hi = Math.max(...xs);
        if (hi - lo < 6) return null;              // no real range to look at
        pts.forEach(p => { p.color = cmHeatColor((p.x - lo) / (hi - lo)); });

        const chart = cmScatter('Each dot is one day', pts,
            { xLabel: 'average temperature (°F)', yLabel: 'visits that day',
              fit: true, revealFit: true });
        if (!chart) return null;

        const slope = chart.fit ? chart.fit.slope : 0;
        const spread = (Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))) || 1;
        const strength = Math.abs(slope) * (hi - lo) / spread;

        const answer = strength < 0.35 ? 'No clear pattern either way'
                     : slope > 0       ? 'More visits on the warmer days'
                                       : 'More visits on the colder days';
        const built = cmChoices(answer, [
            'More visits on the warmer days',
            'More visits on the colder days',
            'No clear pattern either way',
        ].filter(x => x !== answer), rng);
        if (!built) return null;

        return {
            prompt: 'Each dot is one day: how warm it was, and how many birds came. '
                  + 'What pattern of association do you see?',
            ...built,
            chart,
            explain: answer === 'No clear pattern either way'
                ? 'The dots scatter without leaning either way. That is a real result, '
                + 'not a failed one — plenty of pairs of measurements are unrelated, '
                + 'and saying so is the honest reading.'
                : `The dots lean ${slope > 0 ? 'upward' : 'downward'} to the right: `
                + `about ${Math.abs(slope).toFixed(1)} ${slope > 0 ? 'more' : 'fewer'} `
                + `visits for every extra degree. A lean is an association, not a `
                + `cause — warmer days are also longer and calmer.`,
        };
    },
},

{
    // MA.8.DP.1.3 — informally fit a straight line. "Informally" is the
    // operative word, so the question is about what a good line DOES
    // rather than about calculating one.
    id: 'fit-line',
    category: 'analysis',
    title: 'Drawing the line',
    bands: ['6-8'],
    build({ s14, rng }) {
        const pts = [];
        s14.days.forEach(d => {
            const t = s14.dayTemp.get(d.day);
            if (t && t.n >= 3) pts.push({ x: Math.round(t.sum / t.n), y: d.n });
        });
        if (pts.length < 8) return null;

        const chart = cmScatter('The same days, with a line through them', pts,
            { xLabel: 'average temperature (°F)', yLabel: 'visits that day', fit: true });
        if (!chart || !chart.fit) return null;

        const built = cmChoices(
            'As close to as many dots as possible, with about as many above as below',
            ['Through the highest dot and the lowest dot',
             'Through the first dot and the last dot',
             'Through as many dots exactly as it can, ignoring the rest'], rng);
        if (!built) return null;

        return {
            prompt: 'Where should a line of best fit go?',
            ...built,
            chart,
            explain: 'A fitted line is a summary of ALL the dots, so it is judged by '
                   + 'the whole cloud, not by any two of them. Joining the extremes '
                   + 'lets the two least typical days decide the answer — which is '
                   + 'the opposite of what a summary is for.',
        };
    },
},

{
    // MA.7.DP.1.4 — proportional reasoning on a circle graph. The donut
    // chart already existed; nothing asked a proportional question of it.
    id: 'circle-graph',
    category: 'math',
    title: 'Reading a circle graph',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.total < 40 || s.species.length < 3) return null;
        const top = s.species[0];
        const share = top.n / s.total;
        if (share < 0.15 || share > 0.7) return null;   // a wedge you can judge

        const degrees = Math.round(share * 360 / 5) * 5;
        const chart = cmChart('Share of this week’s visits', cmSpeciesSeries(s, 6),
                              { band, kind: 'donut', highlight: top.species });
        if (!chart) return null;

        const built = cmChoices(`about ${degrees}°`,
            [`about ${degrees + 45}°`, `about ${Math.max(15, degrees - 40)}°`,
             `about ${Math.min(350, degrees + 90)}°`], rng);
        if (!built) return null;

        return {
            prompt: `The ${top.species} made ${top.n} of our ${s.total} visits. `
                  + `Roughly how big is its slice, in degrees?`,
            ...built,
            chart,
            explain: `${top.n} out of ${s.total} is about ${Math.round(share * 100)}%, `
                   + `and a whole circle is 360°. ${Math.round(share * 100)}% of 360° `
                   + `is about ${degrees}°.`,
            about_bird: top.species,
        };
    },
},

{
    // MA.7.DP.1.2 — compare two populations using centre and variability.
    // This is the question the pooled data source exists for: it cannot be
    // asked of one feeder at all.
    id: 'compare-feeders',
    category: 'comparison',
    title: 'Two feeders, side by side',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (!s.isPool || !s.feeders || s.feeders.length < 2) return null;

        const ranked = s.feeders.slice().sort((a, b) => b.total - a.total);
        const [a, b] = ranked;
        if (!a || !b || b.total < 8) return null;

        const per = x => x.days.length ? x.total / x.days.length : 0;
        const aPer = per(a), bPer = per(b);
        // Close averages make this a coin toss rather than a comparison.
        if (Math.abs(aPer - bPer) < Math.max(1, aPer * 0.25)) return null;

        const winner = aPer > bPer ? a : b;
        const built = cmChoices(winner.name,
            [aPer > bPer ? b.name : a.name,
             'They are about the same',
             'There is no way to tell from this'], rng);
        if (!built) return null;

        const series = [
            { label: a.name, value: Math.round(aPer * 10) / 10, key: 'a' },
            { label: b.name, value: Math.round(bPer * 10) / 10, key: 'b' },
        ];

        return {
            prompt: 'Which of these two feeders is busier on a typical day?',
            ...built,
            chart: cmChart('Average visits per day', series,
                           { band, kind: 'hbars', plain: true }),
            explain: `${a.name} averaged ${aPer.toFixed(1)} visits a day and `
                   + `${b.name} averaged ${bPer.toFixed(1)}. Totals alone would not `
                   + `settle it — a feeder switched on halfway through the fortnight `
                   + `has fewer days to add up, which is why the comparison is per day.`,
        };
    },
},

// ── Probability ─────────────────────────────────────────────────────

{
    // MA.7.DP.2.1 — determine the sample space for a simple experiment.
    // Built from the species this feeder actually has, so the sample space
    // is a real one the class can check.
    id: 'sample-space',
    category: 'math',
    title: 'All the possible outcomes',
    bands: ['6-8'],
    build({ s, rng }) {
        // 12, not 9. A pooled community feeder routinely sees ten or more
        // species in a week, and the question was simply never asked on
        // one. n x n is still a sample space a class can reason about at
        // twelve; past that the number stops meaning anything.
        if (s.species.length < 3 || s.species.length > 12) return null;
        const n = s.species.length;

        const built = cmChoices(String(n * n),
            [String(n * 2), String(n), String(n * (n - 1))], rng);
        if (!built) return null;

        return {
            prompt: `${n} different species visited this week. If we write down the `
                  + `species of the next bird AND the one after it, how many different `
                  + `pairs could we end up with?`,
            ...built,
            explain: `${n} choices for the first bird, and the same ${n} for the second `
                   + `— the first bird does not use anything up — so ${n} × ${n} = `
                   + `${n * n}. That full list of outcomes is the sample space. It `
                   + `includes the ${n} pairs where the same species turns up twice.`,
        };
    },
},

// ── Nature of science ───────────────────────────────────────────────

{
    // SC.4.N.1.6 — keep records that carefully distinguish actual
    // observations from ideas and inferences about them. Asked against a
    // real photograph from this feeder, which is the only way to ask it
    // that is not a vocabulary question.
    id: 'observe-or-infer',
    category: 'science',
    title: 'Saw it, or worked it out?',
    bands: ['3-5', '6-8'],
    build({ s, rng }) {
        // The photograph is here to be looked at, not named, so a middling
        // one beats no question - but take the clearest the feeder has.
        const shot = s.snapshots.find(r => cmConfPct(r) >= CM_CONF_SHOW) || s.snapshots[0];
        if (!shot) return null;

        const when = new Date(shot.detected_at);
        const hour = when.getHours();

        const built = cmChoices(
            `The bird is ${hour < 12 ? 'hungry' : 'about to fly south'}`,
            ['The bird is at the feeder',
             'The bird has a beak',
             'The photo was taken in daylight'], rng);
        if (!built) return null;

        return {
            prompt: 'Three of these you can SEE in the photo. One is something '
                  + 'somebody worked out. Which is the inference?',
            ...built,
            image: { url: shot.image_url, detection_id: shot.id },
            explain: 'An observation is what the senses record; an inference is what '
                   + 'you conclude from it. We can see the bird, the beak and the '
                   + 'daylight. Why it came, and where it is going, are not in the '
                   + 'photograph — they may well be true, and they are still not '
                   + 'observations.',
            detection_id: shot.id,
        };
    },
},

{
    // SC.8.N.1.3 — "results support" or "fail to support", and science
    // does not offer conclusive proof. Phrased against a real claim about
    // this feeder so the hedge has something to be a hedge ABOUT.
    id: 'results-support',
    category: 'science',
    title: 'What the data can and cannot say',
    bands: ['6-8'],
    build({ s, rng }) {
        if (s.total < 25 || !s.species.length) return null;
        const top = s.species[0];

        const built = cmChoices(
            `Our results SUPPORT the idea that ${top.species}s are the commonest `
            + `visitor here`,
            [`Our results PROVE that ${top.species}s are the commonest visitor here`,
             `Our results prove that ${top.species}s are the commonest bird in the state`,
             `Our results say nothing at all about which bird is commonest`], rng);
        if (!built) return null;

        return {
            prompt: `${top.n} of our ${s.total} visits this week were ${top.species}s. `
                  + `Which sentence should go in the write-up?`,
            ...built,
            explain: 'Scientists write "support" and "fail to support" rather than '
                   + '"prove", because another week could always come out differently. '
                   + 'One feeder, one week, cannot speak for the state either — but it '
                   + 'is real evidence about this feeder, so "says nothing" is wrong too.',
            about_bird: top.species,
        };
    },
},

{
    // SC.7.N.1.2 — differentiate replication (by others) from repetition
    // (multiple trials). A community with several feeders is a replication
    // the class did not have to arrange.
    id: 'replication-repetition',
    category: 'science',
    title: 'Repeating and replicating',
    bands: ['6-8'],
    build({ rng }) {
        const built = cmChoices(
            'Another school counts the birds at THEIR feeder',
            ['We count again the next day',
             'We count for a second week at our own feeder',
             'Two of us count the same hour and compare'], rng);
        if (!built) return null;

        return {
            prompt: 'Our class counts birds at our feeder every day for a week. '
                  + 'Which of these would be a REPLICATION rather than a repetition?',
            ...built,
            explain: 'Repetition is doing your own trial again — more days, more weeks, '
                   + 'two of you counting together. Replication is somebody ELSE '
                   + 'getting the same result independently, which is the stronger '
                   + 'check, because it cannot share your mistakes or your feeder.',
        };
    },
},

{
    // MA.6.DP.1.1 — recognise and formulate a statistical question. The
    // distinguishing feature is variability in the answers, which is
    // exactly what a week of feeder data has.
    id: 'stat-question',
    category: 'analysis',
    title: 'Which is a statistical question?',
    bands: ['6-8'],
    build({ rng }) {
        const built = cmChoices(
            'How many birds visit our feeder in a day?',
            ['How many birds visited our feeder yesterday?',
             'What is the name of the bird in this photo?',
             'What time did the first bird arrive this morning?'], rng);
        if (!built) return null;

        return {
            prompt: 'A statistical question is one you expect to get a RANGE of '
                  + 'answers to. Which of these is one?',
            ...built,
            explain: 'The other three each have one right answer you could look up. '
                   + '"How many in a day" varies from day to day, so answering it '
                   + 'means collecting a set of numbers and summarising them — which '
                   + 'is what makes it statistical.',
        };
    },
},

// ── Classifying what came ───────────────────────────────────────────

{
    // SC.3.L.15.1 — classify animals into major groups by physical
    // characteristics and behaviours. The one benchmark that mentions
    // birds by name, and nothing asked it.
    id: 'classify-animal',
    category: 'science',
    title: 'What makes it a bird?',
    bands: ['3-5'],
    build({ s, rng }) {
        const sp = s.species.length ? s.species[0].species : null;

        const built = cmChoices('Feathers, a beak, and it lays eggs',
            ['It can fly and it lays eggs',
             'It has two legs and it can fly',
             'It builds a nest and eats seeds'], rng);
        if (!built) return null;

        return {
            prompt: sp
                ? `Scientists put the ${sp} in the same group as every other bird. `
                  + `What puts it there?`
                : 'What puts an animal in the bird group?',
            ...built,
            image: sp ? cmShotFor(s, sp) : null,
            explain: 'Feathers are the giveaway — no other animal alive has them. '
                   + 'Flight is not: bats and most insects fly, and ostriches, '
                   + 'penguins and kiwis do not. Nests and seeds are things some '
                   + 'birds do, not things that make them birds.',
            about_bird: sp,
        };
    },
},

{
    // SC.1.L.16.1 — young resemble their parents, but individuals vary.
    // Both halves matter, and the second half is the one usually skipped.
    id: 'parents-and-variation',
    category: 'science',
    title: 'Like their parents',
    bands: ['k-2'],
    build({ rng }) {
        const built = cmChoices('They look mostly like their parents, but not exactly',
            ['They look exactly like their parents',
             'They look nothing like their parents',
             'They choose what they will look like'], rng);
        if (!built) return null;

        return {
            prompt: 'When baby birds grow up, what do they look like?',
            ...built,
            explain: 'Young cardinals grow up red like their parents — that is why we '
                   + 'can tell a cardinal from a jay at all. But no two are identical: '
                   + 'one is a little bigger, one a little brighter. Both parts are '
                   + 'true at once.',
        };
    },
},

{
    // SC.2.L.17.2 — living things are everywhere, but each can only live
    // where its basic needs are met. A feeder is a habitat the class is
    // watching, which makes this concrete rather than definitional.
    id: 'habitat-needs',
    category: 'science',
    title: 'Why birds come here',
    bands: ['k-2'],
    build({ rng }) {
        const built = cmChoices('Because they can find food, water and shelter here',
            ['Because every animal can live anywhere',
             'Because they like our school',
             'Because somebody told them to come'], rng);
        if (!built) return null;

        return {
            prompt: 'Birds come to our feeder, but a fish could not live here. Why do '
                  + 'the birds come?',
            ...built,
            explain: 'Living things are found all over the Earth, but each kind can '
                   + 'only live where its needs are met. Our feeder has seed, and '
                   + 'there are trees nearby to hide in. A fish needs water to breathe, '
                   + 'so this is not a place a fish can live.',
        };
    },
},

// ── Geography, from where the feeders actually are ──────────────────

{
    // SS.5.G.1.2 — use latitude and longitude to locate places. Real
    // coordinates, from a real feeder, which is the difference between
    // this and a worksheet.
    id: 'geo-latlong',
    category: 'geography',
    title: 'Finding it by coordinates',
    bands: ['3-5', '6-8'],
    build({ s, rng }) {
        const row = s.rows.find(r => isFinite(+r.latitude) && isFinite(+r.longitude)
                                  && +r.latitude !== 0 && +r.longitude !== 0);
        if (!row) return null;

        const lat = +row.latitude, lng = +row.longitude;
        const ns = lat >= 0 ? 'north' : 'south';
        const ew = lng >= 0 ? 'east' : 'west';

        const built = cmChoices(
            `${Math.abs(lat).toFixed(1)}° ${ns} of the Equator, `
            + `${Math.abs(lng).toFixed(1)}° ${ew} of the Prime Meridian`,
            [`${Math.abs(lng).toFixed(1)}° ${ns} of the Equator, `
             + `${Math.abs(lat).toFixed(1)}° ${ew} of the Prime Meridian`,
             `${Math.abs(lat).toFixed(1)}° ${ew} of the Equator, `
             + `${Math.abs(lng).toFixed(1)}° ${ns} of the Prime Meridian`,
             `${Math.abs(lat).toFixed(1)}° ${ns} of the Prime Meridian, `
             + `${Math.abs(lng).toFixed(1)}° ${ew} of the Equator`], rng);
        if (!built) return null;

        return {
            prompt: `A feeder in this lesson sits at ${lat.toFixed(1)}, `
                  + `${lng.toFixed(1)}. Where is that?`,
            ...built,
            explain: `Latitude comes first and measures north or south of the Equator; `
                   + `longitude comes second and measures east or west of the Prime `
                   + `Meridian. ${lat.toFixed(1)} is latitude, so ${Math.abs(lat).toFixed(1)}° `
                   + `${ns}. ${lng.toFixed(1)} is longitude, so `
                   + `${Math.abs(lng).toFixed(1)}° ${ew}.`,
        };
    },
},

{
    // SS.3.G.1.1 — use thematic maps, tables, charts, graphs AND PHOTOS to
    // analyse geographic information. The lesson's own chart is the
    // geographic information, which is the point.
    id: 'geo-read-chart',
    category: 'geography',
    title: 'What the chart tells you about the place',
    bands: ['3-5'],
    build({ s, band, rng }) {
        if (s.species.length < 4 || s.total < 20) return null;

        const built = cmChoices('Which kinds of bird live around here',
            ['How big the state is',
             'How many people live here',
             'What the weather will do tomorrow'], rng);
        if (!built) return null;

        return {
            prompt: 'Geographers use charts like this one to learn about a place. '
                  + 'What does this chart tell you about ours?',
            ...built,
            chart: cmChart('Birds recorded here this week', cmSpeciesSeries(s, 6),
                           { band, kind: 'hbars' }),
            explain: 'A list of which birds turn up, and how often, describes the '
                   + 'living things of a place — which is geography as much as it is '
                   + 'science. It says nothing about area, population or tomorrow, '
                   + 'because none of those was measured.',
        };
    },
},

// ── Reading an argument ─────────────────────────────────────────────

{
    // ELA.3.R.2.4 and ELA.4.R.2.4 — identify a claim and the evidence
    // used to support it. The class's own chart is the evidence, so the
    // question is about whether the claim goes beyond it.
    id: 'claim-evidence',
    category: 'language',
    title: 'Does the evidence back the claim?',
    bands: ['3-5', '6-8'],
    build({ s, band, rng }) {
        if (s.total < 20 || s.species.length < 3) return null;
        const top = s.species[0];

        const built = cmChoices(
            `${top.species}s came to our feeder more often than any other bird this week`,
            [`${top.species}s are the most common bird in the world`,
             `${top.species}s are the friendliest birds`,
             `${top.species}s will come to our feeder again next week`], rng);
        if (!built) return null;

        return {
            prompt: 'Which claim does this chart actually support?',
            ...built,
            chart: cmChart('Visits this week', cmSpeciesSeries(s, 6),
                           { band, highlight: top.species }),
            explain: 'The chart counts visits to one feeder in one week. That supports '
                   + 'a claim about this feeder and this week, and nothing wider. The '
                   + 'others might be true, but the evidence in front of us does not '
                   + 'show them — and "friendliest" was never measured at all.',
            about_bird: top.species,
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Second batch from the gap list
// ════════════════════════════════════════════════════════════════════
//
//  Same method as the first: `node tools/check-alignment.js --gaps` named
//  49 benchmarks nothing asked about, and these answer the ones a feeder
//  can honestly evidence.
//
//  WEIGHTED TOWARDS PHOTOGRAPHS AND CLIPS ON PURPOSE. A teacher asked for
//  "more questions that include bird photos and clips", and it happens
//  that the benchmarks still uncovered are mostly Nature of Science —
//  observation, inference, evidence, records, repeatability — which are
//  the ones that NEED a real picture. A question about careful looking
//  with nothing to look at is a definition.
//
//  WHAT IS STILL NOT HERE, AND WHY.
//  The six music benchmarks want melodic and rhythmic patterns compared
//  by ear, and we have no audio. Writing them against printed words
//  would be pretending. They stay in the gap list until bird song does.
//  The "collect and represent" benchmarks (MA.*.DP.1.1, MA.6.DP.1.5)
//  stay too: our charts do the representing, and a child choosing an
//  option is not doing what those say. MA.7.DP.1.5 — CHOOSE an
//  appropriate representation — is the one of that family a multiple
//  choice can honestly carry, and it is here.
// ════════════════════════════════════════════════════════════════════

// ── Looking carefully, with something to look at ────────────────────

{
    // SC.K.N.1.5 and SC.1.N.1.4 together: what careful observation can
    // and cannot tell you, asked over a real photograph of a real bird
    // that really came.
    id: 'observe-carefully',
    category: 'science',
    title: 'What can looking tell us?',
    bands: ['k-2'],
    build({ s, rng }) {
        // The photograph is here to be looked at, not named, so a middling
        // one beats no question - but take the clearest the feeder has.
        const shot = s.snapshots.find(r => cmConfPct(r) >= CM_CONF_SHOW) || s.snapshots[0];
        if (!shot) return null;

        const built = cmChoices('What colors it has',
            ['What it ate for breakfast',
             'How old it is',
             'Whether it has babies'], rng);
        if (!built) return null;

        return {
            prompt: 'Look at our photo carefully. Which of these can you find out '
                  + 'just by LOOKING?',
            ...built,
            image: { url: shot.image_url, detection_id: shot.id },
            explain: 'Careful looking tells you colors, size and shape — real things, '
                   + 'and you can show somebody else the same photo and they will '
                   + 'see them too. Breakfast, age and babies are not in the picture. '
                   + 'Scientists are careful about that difference.',
            detection_id: shot.id,
        };
    },
},

{
    // SC.1.N.1.4 — ask "how do you know?" — and the answer is the point:
    // because the camera kept a record, which is SC.1.N.1.3 as well.
    id: 'how-do-you-know',
    category: 'science',
    title: 'How do you know?',
    bands: ['k-2'],
    build({ s, rng }) {
        if (!s.species.length) return null;
        const sp = s.species[0].species;

        const built = cmChoices('Show them the photo the camera took',
            ['Say it louder',
             'Ask them to believe you',
             'Guess again tomorrow'], rng);
        if (!built) return null;

        return {
            prompt: `You tell a friend a ${sp} came to our feeder. They ask, `
                  + `"how do you know?" What is the best thing to do?`,
            ...built,
            image: cmShotFor(s, sp),
            image_on_reveal: true,
            explain: '"How do you know?" is a fair question and it always has a good '
                   + 'answer: show the evidence. Our camera keeps a picture of every '
                   + 'visit, so we never have to say "just trust me".',
            about_bird: sp,
        };
    },
},

{
    // SC.2.N.1.2 and SC.3.N.1.2 — different groups, same tools, different
    // answers. A clip is the honest way to ask it: everybody watches the
    // same few seconds and the counts really do differ.
    id: 'same-tools-different-counts',
    category: 'science',
    title: 'Two groups, two answers',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        const clip = cmPickClip(s, rng);
        if (!clip) return null;

        const built = cmChoices('Watch it again together and agree how to count',
            ['The bigger number must be right',
             'The group that finished first is right',
             'Nobody can ever know'], rng);
        if (!built) return null;

        return {
            prompt: band === 'k-2'
                ? 'Two groups watched this same clip. One counted 3 birds and one '
                  + 'counted 4. What should they do?'
                : 'Two groups watched this same clip with the same tools and got '
                  + 'different counts — 3 and 4. What is the scientific thing to do?',
            ...built,
            clip: { url: clip.video_url, detection_id: clip.id },
            explain: 'Different groups using the same tools often get slightly '
                   + 'different results, and that is normal rather than a mistake by '
                   + 'one of them. Scientists go back to the evidence and work out '
                   + 'WHY — did one group count a bird that landed twice?',
            detection_id: clip.id,
        };
    },
},

{
    // SC.2.N.1.4 — the same investigation repeated should reach similar
    // conclusions. Our feeder does it every single day, which is a better
    // example than anything invented.
    id: 'repeat-the-count',
    category: 'science',
    title: 'Doing it again',
    bands: ['k-2'],
    build({ s, rng }) {
        if (s.days.length < 5) return null;

        const built = cmChoices('Close to the same, but not exactly the same',
            ['Exactly the same every time',
             'Completely different every time',
             'It would stop working'], rng);
        if (!built) return null;

        return {
            prompt: 'We count the birds at our feeder every day. If we do it again '
                  + 'next week, what should we expect?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band: 'k-2' }),
            explain: 'A good investigation gives you a similar answer when you do it '
                   + 'again — that is how you know it was a real result. Not identical, '
                   + 'though: birds are not machines. Wildly different every time would '
                   + 'mean something was wrong with how we were counting.',
        };
    },
},

{
    // SC.1.N.1.3 and SC.3.N.1.3 — keeping records. The class already has
    // the best possible one, so the question is about what makes it good.
    id: 'keeping-records',
    category: 'science',
    title: 'Why we write it down',
    bands: ['k-2', '3-5'],
    build({ s, band, rng }) {
        if (s.total < 10) return null;

        const built = cmChoices('Because we would forget, and a record can be checked',
            ['Because the birds want us to',
             'Because it makes the birds come back',
             'Because it is a rule'], rng);
        if (!built) return null;

        return {
            prompt: band === 'k-2'
                ? 'Our feeder writes down every bird it sees. Why is that a good idea?'
                : 'Our feeder keeps a record of every visit. Why do scientists keep '
                  + 'records of what they observe?',
            ...built,
            chart: cmChart('What the record looks like', cmDaySeries(s),
                           { band, showValues: true }),
            explain: `This chart only exists because something wrote down all `
                   + `${s.total} visits as they happened. A record turns "I think `
                   + `Thursday was busy" into something anyone can check — including `
                   + `you, next month, when you have forgotten.`,
        };
    },
},

{
    // SC.3.N.1.7, SC.4.N.1.7 and SC.5.N.2.1 — what empirical evidence IS,
    // and that an explanation has to be tied to it.
    id: 'evidence-or-opinion',
    category: 'science',
    title: 'Evidence, or just an idea?',
    bands: ['3-5'],
    build({ s, rng }) {
        if (!s.species.length || s.total < 15) return null;
        const top = s.species[0];

        const built = cmChoices(
            `${top.species}s visited ${top.n} times this week`,
            [`${top.species}s are the prettiest birds`,
             `${top.species}s like our feeder best`,
             `${top.species}s are happy here`], rng);
        if (!built) return null;

        return {
            prompt: 'Which of these is EVIDENCE — something that was observed or '
                  + 'measured — rather than an idea about it?',
            ...built,
            image: cmShotFor(s, top.species),
            explain: `${top.n} visits is a measurement: the camera counted them, and `
                   + `anybody can check. "Prettiest" is an opinion, and "likes it best" `
                   + `and "is happy" are explanations somebody made up to fit the `
                   + `number. They might even be right — they are still not evidence.`,
            about_bird: top.species,
        };
    },
},

// ── Looking, as an artist ───────────────────────────────────────────

{
    // VA.3.C.1.2 and VA.5.C.1.2 — reflect on and interpret an image using
    // observation. The feeder's own photograph is the work being read.
    id: 'art-read-the-photo',
    category: 'art',
    title: 'Reading a picture',
    bands: ['3-5'],
    build({ s, rng }) {
        // The photograph is here to be looked at, not named, so a middling
        // one beats no question - but take the clearest the feeder has.
        const shot = s.snapshots.find(r => cmConfPct(r) >= CM_CONF_SHOW) || s.snapshots[0];
        if (!shot) return null;

        const built = cmChoices(
            'Describe what is actually in it, then say what it makes you think',
            ['Decide straight away whether you like it',
             'Work out how expensive the camera was',
             'Find out who took it before looking'], rng);
        if (!built) return null;

        return {
            prompt: 'Artists look at an image before they judge it. What is the first '
                  + 'thing to do with this photograph?',
            ...built,
            image: { url: shot.image_url, detection_id: shot.id },
            explain: 'Describe first, interpret second: what is in the frame, where the '
                   + 'light is, what is sharp and what is blurred — then what it makes '
                   + 'you feel. Deciding whether you like it first tends to stop you '
                   + 'looking at all.',
            detection_id: shot.id,
        };
    },
},

// ── Numbers, K-2 ────────────────────────────────────────────────────

{
    // MA.1.NSO.1.4 and MA.2.NSO.1.3 — plot, order and compare whole
    // numbers, using the week the class has in front of them.
    id: 'order-the-days',
    category: 'math',
    title: 'Putting days in order',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const days = s.days.filter(d => d.n > 0);
        if (days.length < 4) return null;

        const sorted = days.slice().sort((a, b) => a.n - b.n);
        const answer = sorted[sorted.length - 1];

        // Only the TOP has to be unambiguous. Rejecting every week with any
        // repeated count at all was the first version of this, and it never
        // built once — real daily counts repeat constantly, and a tie between
        // Tuesday and Thursday down in the middle does not stop "which day
        // comes last" having one answer.
        if (answer.n === sorted[sorted.length - 2].n) return null;

        // Distractors from days with DIFFERENT counts, so no option is as
        // defensible as the answer.
        const seen = new Set([answer.n]);
        const others = sorted.filter(d => !seen.has(d.n) && seen.add(d.n))
                             .slice(0, 3)
                             .map(d => cmDayAxisLabel(d.day));
        if (others.length < 2) return null;

        const built = cmChoices(cmDayAxisLabel(answer.day), others, rng);
        if (!built) return null;

        return {
            prompt: 'If we put the days in order from FEWEST birds to MOST, '
                  + 'which day comes last?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band }),
            explain: `In order: ${sorted.map(d => `${cmDayAxisLabel(d.day)} (${d.n})`)
                        .join(', ')}. Last means the biggest.`,
        };
    },
},

{
    // MA.1.NSO.2.3 — ten more and ten less than a two-digit number.
    id: 'ten-more-ten-less',
    category: 'math',
    title: 'Ten more, ten less',
    bands: ['k-2'],
    build({ s, rng }) {
        const pick = cmShuffle(s.days.filter(d => d.n >= 10 && d.n <= 89), rng)[0];
        if (!pick) return null;

        const answer = pick.n + 10;
        const built = cmChoices(String(answer),
            [String(pick.n - 10), String(pick.n + 1), String(pick.n + 100)], rng);
        if (!built) return null;

        return {
            prompt: `There were ${pick.n} visits on ${cmDayProse(pick.day)}. `
                  + `What is TEN MORE than ${pick.n}?`,
            ...built,
            explain: `${pick.n} + 10 = ${answer}. Ten more changes the tens digit and `
                   + `leaves the ones alone. Ten LESS would be ${pick.n - 10}.`,
        };
    },
},

{
    // MA.2.NSO.1.4 — round to the nearest 10. The 3-5 band already has a
    // rounding question; this is the two-digit one.
    id: 'round-to-ten',
    category: 'math',
    title: 'Rounding to ten',
    bands: ['k-2'],
    build({ s, rng }) {
        const pick = cmShuffle(s.days.filter(d => d.n > 0 && d.n <= 99 && d.n % 10 !== 0),
                               rng)[0];
        if (!pick) return null;

        const answer = Math.round(pick.n / 10) * 10;
        const other  = answer === Math.floor(pick.n / 10) * 10
            ? answer + 10 : answer - 10;
        const built = cmChoices(String(answer),
            [String(other), String(pick.n), String(answer + 10)], rng);
        if (!built) return null;

        return {
            prompt: `${pick.n} birds came on ${cmDayProse(pick.day)}. Rounded to the `
                  + `nearest TEN, about how many is that?`,
            ...built,
            explain: `${pick.n} is closer to ${answer} than to ${other}, so it rounds `
                   + `to ${answer}. Rounding is for when "about" is enough.`,
        };
    },
},

{
    // MA.2.AR.1.1 — a two-step addition and subtraction problem out of
    // the week's own numbers.
    id: 'two-step-k2',
    category: 'math',
    title: 'Two steps',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const days = s.days.filter(d => d.n > 0);
        if (days.length < 3) return null;
        const [a, b] = cmShuffle(days, rng).slice(0, 2);
        if (!a || !b) return null;

        const flew = Math.max(1, Math.round((a.n + b.n) / 3));
        const answer = a.n + b.n - flew;
        if (answer < 1) return null;

        const built = cmChoices(String(answer),
            [String(a.n + b.n), String(a.n + b.n + flew), String(Math.abs(a.n - b.n))], rng);
        if (!built) return null;

        return {
            prompt: `${a.n} birds came on ${cmDayProse(a.day)} and ${b.n} came on `
                  + `${cmDayProse(b.day)}. If ${flew} of them flew away again, how many `
                  + `were left?`,
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s),
                           { band, showValues: true }),
            explain: `Two steps: first add, ${a.n} + ${b.n} = ${a.n + b.n}. Then take `
                   + `away, ${a.n + b.n} − ${flew} = ${answer}.`,
        };
    },
},

// ── Numbers, 3-5 ────────────────────────────────────────────────────

{
    // MA.4.AR.3.2 — generate, describe and extend a pattern with a rule.
    // The rule is invented, not found in the data: feeder counts do not
    // follow one, and pretending otherwise would be the dishonest version.
    id: 'extend-pattern',
    category: 'math',
    title: 'Following a rule',
    bands: ['3-5'],
    build({ s, rng }) {
        if (!s.species.length) return null;
        const start = 3 + Math.floor(rng() * 5);
        const step  = 2 + Math.floor(rng() * 4);
        const seq   = [start, start + step, start + 2 * step, start + 3 * step];
        const next  = start + 4 * step;

        const built = cmChoices(String(next),
            [String(next + step), String(next - 1), String(start + 3 * step + 1)], rng);
        if (!built) return null;

        return {
            prompt: `We put out ${start} scoops of seed in week 1, then add ${step} `
                  + `more every week: ${seq.join(', ')}… How many scoops in week 5?`,
            ...built,
            explain: `The rule is "add ${step} each time". Week 4 was ${seq[3]}, so `
                   + `week 5 is ${seq[3]} + ${step} = ${next}. Describing the rule in `
                   + `words is what lets you jump to any week without listing them all.`,
        };
    },
},

{
    // MA.5.AR.1.1 — multi-step, more than one operation.
    id: 'multi-step-seed',
    category: 'math',
    title: 'More than one step',
    bands: ['3-5'],
    build({ s, band, rng }) {
        if (s.total < 20 || s.days.length < 5) return null;
        const perScoop = 5 + Math.floor(rng() * 5);
        const cost = 2;
        const scoops = Math.ceil(s.total / perScoop);
        const answer = scoops * cost;

        const built = cmChoices(`$${answer}`,
            [`$${scoops}`, `$${s.total * cost}`, `$${Math.round(answer / 2)}`], rng);
        if (!built) return null;

        return {
            prompt: `Our feeder had ${s.total} visits this week. One scoop of seed `
                  + `feeds about ${perScoop} visits, and a scoop costs $${cost}. `
                  + `About how much did this week cost?`,
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band }),
            explain: `Two operations: ${s.total} ÷ ${perScoop} ≈ ${scoops} scoops, then `
                   + `${scoops} × $${cost} = $${answer}. Dividing first and multiplying `
                   + `second — doing it the other way round answers a different question.`,
        };
    },
},

{
    // MA.4.FR.1.3 — equivalent fractions, and the "why" clause of that
    // benchmark: what happens to numerator and denominator.
    id: 'equivalent-fractions',
    category: 'math',
    title: 'The same fraction, written twice',
    bands: ['3-5'],
    build({ s, rng }) {
        const days = s.days.filter(d => d.n > 0).length;
        if (days < 4 || days > 7) return null;

        // Halves are the one family that lands on friendly numbers whatever
        // the week looks like.
        const built = cmChoices('2/4',
            ['1/4', '2/3', '3/4'], rng);
        if (!built) return null;

        return {
            prompt: 'Birds came on some days and not others. If they came on HALF of '
                  + 'the days, which of these is the same as 1/2?',
            ...built,
            explain: '2/4 is the same amount as 1/2: both the top and the bottom have '
                   + 'been doubled, so the size of each piece halved and you have twice '
                   + 'as many. 2/3 and 3/4 are bigger than a half; 1/4 is smaller.',
        };
    },
},

{
    // MA.3.M.1.2 — a real-world problem with TEMPERATURES, which is the
    // one measurement our feeders record and almost nothing used.
    id: 'temp-difference',
    category: 'math',
    title: 'How much colder?',
    bands: ['3-5'],
    build({ s, rng }) {
        const temps = s.days
            .map(d => ({ day: d.day, t: s.dayTemp.get(d.day) }))
            .filter(x => x.t && x.t.n >= 3)
            .map(x => ({ day: x.day, deg: Math.round(x.t.sum / x.t.n) }));
        if (temps.length < 4) return null;

        const warm = temps.reduce((a, b) => (b.deg > a.deg ? b : a));
        const cold = temps.reduce((a, b) => (b.deg < a.deg ? b : a));
        const diff = warm.deg - cold.deg;
        if (diff < 4) return null;

        const built = cmChoices(`${diff}°`,
            [`${warm.deg}°`, `${cold.deg}°`, `${diff + 10}°`], rng);
        if (!built) return null;

        return {
            prompt: `The warmest day this week was ${warm.deg}° and the coldest was `
                  + `${cold.deg}°. How much colder was the coldest day?`,
            ...built,
            chart: cmChart('Temperature each day',
                temps.map(x => ({ label: cmDayAxisLabel(x.day), value: x.deg,
                                  key: x.day, color: cmHeatColor(
                                      (x.deg - cold.deg) / Math.max(1, diff)) })),
                { band: '3-5', plain: false }),
            explain: `${warm.deg} − ${cold.deg} = ${diff} degrees. A difference between `
                   + `two measurements is a subtraction, even though both numbers are `
                   + `temperatures rather than counts.`,
        };
    },
},

// ── Geography ───────────────────────────────────────────────────────

{
    // SS.1.G.1.2 — the key elements of a map. Asked about the map this
    // class actually uses to find the feeders.
    id: 'map-elements',
    category: 'geography',
    title: 'Parts of a map',
    bands: ['k-2'],
    build({ rng }) {
        const built = cmChoices('A compass rose, so you know which way is north',
            ['A photograph of every bird',
             'The names of everyone who looked at it',
             'A list of the days of the week'], rng);
        if (!built) return null;

        return {
            prompt: 'We use a map to find where our feeders are. What does every good '
                  + 'map need?',
            ...built,
            explain: 'A map needs a title to say what it shows, a key to say what the '
                   + 'symbols mean, and a compass rose to say which way is north. '
                   + 'Without north, "it is above the river" does not tell you where to go.',
        };
    },
},

{
    // SS.2.G.1.3 — the Equator and the Poles, reached through migration,
    // which is the reason a class has to care where the Equator is.
    id: 'equator-poles',
    category: 'geography',
    title: 'The line round the middle',
    bands: ['k-2'],
    build({ rng }) {
        const built = cmChoices('The Equator',
            ['The North Pole', 'The South Pole', 'The Prime Meridian'], rng);
        if (!built) return null;

        return {
            prompt: 'Some birds fly south every winter to stay warm. What is the name '
                  + 'of the line around the middle of the Earth, where it is warmest?',
            ...built,
            explain: 'The Equator runs round the middle of the globe and is the warmest '
                   + 'part of the Earth. The Poles are the cold ends, top and bottom. '
                   + 'The Prime Meridian is a line too — but it runs the other way, '
                   + 'top to bottom.',
        };
    },
},

{
    // SS.4.G.1.3 — how weather impacts Florida. Our own temperature
    // record against our own visit record, which beats a textbook.
    id: 'weather-impact',
    category: 'geography',
    title: 'Weather and wildlife',
    bands: ['3-5'],
    build({ s, rng }) {
        const temps = s.days
            .map(d => ({ n: d.n, t: s.dayTemp.get(d.day) }))
            .filter(x => x.t && x.t.n >= 3)
            .map(x => ({ n: x.n, deg: x.t.sum / x.t.n }));
        if (temps.length < 5) return null;

        const built = cmChoices('Record the weather and the birds, then compare them',
            ['Decide now and look later',
             'Ask somebody in another state',
             'Only count on warm days'], rng);
        if (!built) return null;

        return {
            prompt: 'Florida’s weather changes what lives here and when. How would '
                  + 'you find out whether weather changes the birds at OUR feeder?',
            ...built,
            explain: 'Our feeder already records the temperature with every visit, so '
                   + 'the two measurements can be lined up and compared. Only counting '
                   + 'on warm days would decide the answer before you started — which '
                   + 'is why scientists record everything, including the days that look '
                   + 'boring.',
        };
    },
},

// ── Words ───────────────────────────────────────────────────────────

{
    // ELA.3.V.1.2, ELA.4.V.1.2 and ELA.5.V.1.2 — Greek and Latin roots.
    // Bird names are full of them, which is why "tri-color" is a lesson
    // and not a list to memorise.
    id: 'roots-in-names',
    category: 'language',
    title: 'Roots in bird names',
    bands: ['3-5'],
    build({ rng }) {
        const picks = [
            { word: 'Tricolored Heron', part: 'TRI',  means: 'three',
              also: 'tricycle, triangle, triplets' },
            { word: 'Bicolored Hawk',   part: 'BI',   means: 'two',
              also: 'bicycle, binoculars, biweekly' },
            { word: 'Rufous Hummingbird', part: 'RUFOUS', means: 'reddish',
              also: 'rufescent' },
        ];
        const p = cmShuffle(picks, rng)[0];
        const others = ['five', 'small', 'loud'].filter(x => x !== p.means);
        const built = cmChoices(p.means, others.slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: `A ${p.word} gets its name from the part "${p.part}". What does `
                  + `that part mean?`,
            ...built,
            explain: `${p.part} means "${p.means}" — the same root turns up in `
                   + `${p.also}. Knowing a handful of roots lets you work out words you `
                   + `have never seen, which is the whole reason to learn them.`,
        };
    },
},

{
    // ELA.1.R.2.3 — the same information given in a picture and in words,
    // and whether they agree. Our chart and our sentence are the pair.
    id: 'chart-and-words',
    category: 'language',
    title: 'The picture and the words',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const days = s.days.filter(d => d.n > 0);
        if (days.length < 4) return null;
        const busiest = days.reduce((a, b) => (b.n > a.n ? b : a));

        const built = cmChoices('They say the same thing in two different ways',
            ['The chart is right and the words are wrong',
             'The words are right and the chart is wrong',
             'They are about different birds'], rng);
        if (!built) return null;

        return {
            prompt: `The chart shows our week. The words say: "${
                      cmDayAxisLabel(busiest.day)} was our busiest day." How do the `
                  + `picture and the words go together?`,
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band,
                           highlight: busiest.day }),
            explain: 'A chart and a sentence can carry the same information. The tallest '
                   + 'bar and the word "busiest" are the same fact — one is quicker to '
                   + 'see, the other is quicker to say. Good readers check that the '
                   + 'picture and the words agree.',
        };
    },
},

// ── 6-8 ─────────────────────────────────────────────────────────────

{
    // MA.7.DP.1.5 — CHOOSE an appropriate graphical representation. The
    // one benchmark in the "represent" family a multiple choice can carry
    // honestly, because choosing is the verb.
    id: 'which-chart',
    category: 'analysis',
    title: 'Which chart should we draw?',
    bands: ['6-8'],
    build({ s, rng }) {
        if (s.species.length < 3 || s.days.length < 5) return null;

        const built = cmChoices('A bar chart, one bar per species',
            ['A line graph, one point per species',
             'A box plot of the species names',
             'A scatter plot of species against species'], rng);
        if (!built) return null;

        return {
            prompt: 'We want to show how many visits each SPECIES made this week. '
                  + 'Which representation fits that data?',
            ...built,
            explain: 'Species are categories, not a sequence, so bars are right: each '
                   + 'one stands alone and heights compare directly. A line would claim '
                   + 'the species run in order and that the space between them means '
                   + 'something. A box plot needs numbers to find quartiles in, and a '
                   + 'scatter plot needs two measurements per thing.',
        };
    },
},

{
    // SC.6.L.15.1 — why organisms are classified by shared characteristics,
    // with the Linnaean system by name. Every detection we record carries
    // a Linnaean name whether the class notices or not.
    id: 'linnaean-names',
    category: 'science',
    title: 'Two names for every bird',
    bands: ['6-8'],
    build({ rng }) {
        const built = cmChoices(
            'The first name is the group it shares features with; the second is its own',
            ['The first is the colour and the second is the size',
             'The first is who found it and the second is where',
             'They are the same name in two languages'], rng);
        if (!built) return null;

        return {
            prompt: 'A Northern Cardinal’s scientific name is Cardinalis cardinalis, '
                  + 'and a Blue Jay’s is Cyanocitta cristata. What do the two parts mean?',
            ...built,
            explain: 'Linnaeus’ system gives every species a genus and a species '
                   + 'name. The genus groups organisms that share characteristics — '
                   + 'Cyanocitta holds the jays — and the second name picks out one of '
                   + 'them. Classification is a claim about shared features, which is '
                   + 'why it changes when the evidence does.',
        };
    },
},

{
    // SC.7.L.17.2 — relationships among organisms. A feeder is a
    // competition experiment running in the courtyard, which makes this
    // the rare ecology benchmark a class can watch rather than read.
    id: 'feeder-competition',
    category: 'science',
    title: 'What is happening at the feeder',
    bands: ['6-8'],
    build({ s, rng }) {
        if (s.species.length < 3) return null;
        const [a, b] = s.species.slice(0, 2).map(x => x.species);

        const built = cmChoices('Competition',
            ['Mutualism', 'Parasitism', 'Commensalism'], rng);
        if (!built) return null;

        return {
            prompt: `${a}s and ${b}s both come to our feeder, and there is only so much `
                  + `seed. What is the relationship between them called?`,
            ...built,
            chart: cmChart('Visits this week', cmSpeciesSeries(s, 6),
                           { band: '6-8', kind: 'hbars' }),
            explain: 'Competition: two species needing the same limited resource. '
                   + 'Mutualism would mean both gain, parasitism that one feeds off the '
                   + 'other, commensalism that one gains and the other is unaffected. '
                   + 'A feeder makes competition visible because the resource is in one '
                   + 'place and we are counting who gets it.',
            about_bird: a,
        };
    },
},

{
    // MA.8.DP.2.3 — a real-world probability problem over a repeated
    // experiment, with a prediction at the end of it.
    id: 'predict-from-probability',
    category: 'math',
    title: 'Predicting from a probability',
    bands: ['6-8'],
    build({ s, band, rng }) {
        if (s.total < 40 || s.species.length < 3) return null;
        const top = s.species[0];
        const p = top.n / s.total;
        // 0.70, not 0.60. The first ceiling was a guess and it was wrong by
        // three points: the commonest bird on the live feeder sits at 63%,
        // so the question never built once on real data. There IS a real
        // ceiling — past about three quarters the prediction is just "nearly
        // all of them" and the donut's biggest slice swallows the rest — but
        // it is not where I first put it.
        if (p < 0.15 || p > 0.70) return null;

        const nextN = 50;
        const answer = Math.round(p * nextN);
        const built = cmChoices(String(answer),
            [String(nextN), String(Math.round(answer / 2)), String(Math.min(nextN, answer * 2))], rng);
        if (!built) return null;

        return {
            prompt: `${top.n} of our ${s.total} visits this week were ${top.species}s. `
                  + `Of the NEXT 50 visits, about how many would you predict?`,
            ...built,
            chart: cmChart('Share of this week’s visits', cmSpeciesSeries(s, 6),
                           { band, kind: 'donut', highlight: top.species }),
            explain: `${top.n} out of ${s.total} is about ${Math.round(p * 100)}%, and `
                   + `${Math.round(p * 100)}% of 50 is about ${answer}. A prediction from `
                   + `a probability is an expectation, not a promise — the next 50 could `
                   + `easily come out a few either side.`,
            about_bird: top.species,
        };
    },
},

{
    // SC.4.L.17.4 — ways animals and humans impact the environment. A
    // feeder is a human intervention in an ecosystem, which the class is
    // running, which makes the question uncomfortable in a useful way.
    id: 'feeder-impact',
    category: 'science',
    title: 'What a feeder changes',
    bands: ['3-5'],
    build({ s, rng }) {
        if (s.total < 15) return null;

        const built = cmChoices('It changes where birds go and how many gather there',
            ['It has no effect at all',
             'It makes birds fly faster',
             'It changes what colour the birds are'], rng);
        if (!built) return null;

        return {
            prompt: 'Putting up a feeder is something PEOPLE did to this place. What '
                  + 'does it change?',
            ...built,
            explain: 'A feeder concentrates birds somewhere they would not otherwise '
                   + 'gather — which is how we get to watch them, and also why feeders '
                   + 'have to be kept clean: crowding spreads disease. People change '
                   + 'environments even when they are trying to help, and noticing that '
                   + 'is part of the science.',
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Music, now that there is something to listen to
// ════════════════════════════════════════════════════════════════════
//
//  These six benchmarks were the last block of the gap list and they were
//  blocked on one thing: every one of them asks a class to compare
//  melodic and rhythmic patterns BY EAR. Written against printed words
//  they would have been vocabulary questions wearing a music label, which
//  is the exact over-claiming classroom-alignment.js exists to prevent.
//
//  With real recordings they are the questions the benchmarks describe.
//  Each one plays an actual bird and asks about what was heard.
//
//  ⚠ EVERY ONE REFUSES TO BUILD WITHOUT ITS AUDIO. Not a graceful
//  degradation to a text version — that text version is precisely the
//  thing that would be a lie. No recording, no question.
// ════════════════════════════════════════════════════════════════════

{
    // MU.K.O.1.2 — similarities and differences in melodic phrases and
    // rhythm patterns. Two birds, played one after the other.
    id: 'music-same-or-different',
    category: 'music',
    title: 'Same or different?',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        // Both of these repeat, which is what the question is about. The
        // chickadee is the clearer example and is ogg-only; the sparrow is
        // the mp3 fallback for browsers that will not take ogg.
        const rec = cmPlayableSound(['Carolina Chickadee', 'White-throated Sparrow']);
        if (!rec) return null;
        const chick = /chickadee/i.test(rec.file);

        const built = cmChoices('It repeats the same few notes over and over',
            ['Every part of it is different',
             'It is one long note that never changes',
             'It gets faster and faster until it stops'], rng);
        if (!built) return null;

        return {
            prompt: `Listen to the ${chick ? 'chickadee' : 'sparrow'}. What happens `
                  + `to its pattern?`,
            ...built,
            sound: rec,
            explain: (chick
                ? 'A chickadee repeats: chick-a-dee-dee-dee, then again. '
                : 'The sparrow repeats: Peabody, Peabody, Peabody. ')
                   + 'Hearing '
                   + 'that something comes back is the first thing musicians listen '
                   + 'for — a pattern you have heard before is what holds a piece of '
                   + 'music together.',
        };
    },
},

{
    // MU.2.O.1.1 — identify basic elements of music in an excerpt. Pitch
    // is the element, and two birds a long way apart on it make the
    // comparison audible rather than theoretical.
    id: 'music-high-or-low',
    category: 'music',
    title: 'High and low, for real',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const high = cmPlayableSound(['Carolina Chickadee', 'Tufted Titmouse',
                                      'Northern Cardinal']);
        const low  = cmPlayableSound(['American Crow', 'Barred Owl']);
        if (!high || !low) return null;

        const built = cmChoices('Pitch — how high or low a sound is',
            ['Tempo — how fast it goes',
             'Dynamics — how loud it is',
             'Timbre — what kind of thing is making it'], rng);
        if (!built) return null;

        return {
            prompt: 'Listen to this bird, then think of a crow. Which part of music '
                  + 'is most different between them?',
            ...built,
            sound: high,
            explain: 'Pitch. A chickadee sings high and a crow calls low, and that is '
                   + 'the same difference as between the right-hand and left-hand ends '
                   + 'of a piano. Tempo is speed, dynamics is loudness, and timbre is '
                   + 'what makes a flute and a violin sound unlike each other even on '
                   + 'the same note.',
        };
    },
},

{
    // MU.2.S.3.4 — match an aural pattern with a written one. The
    // mnemonics birders use ARE written rhythm patterns, which makes this
    // the most natural fit of the six.
    id: 'music-match-written',
    category: 'music',
    title: 'Match what you hear',
    bands: ['k-2', '3-5'],
    needsData: false,
    build({ rng }) {
        const rec = cmPlayableSound('Barred Owl');
        if (!rec) return null;

        const built = cmChoices('Who COOKS for you? Who COOKS for you ALL?',
            ['Drink your teeeeea',
             'chick-a-dee-dee-dee',
             'Old Sam Peabody, Peabody, Peabody'], rng);
        if (!built) return null;

        return {
            prompt: 'Listen. Which written pattern matches the rhythm you heard?',
            ...built,
            sound: rec,
            explain: 'Eight syllables, said twice, with the stress falling on COOKS '
                   + 'both times. Birders write songs down as words for exactly this '
                   + 'reason — a written pattern you can check against what your ears '
                   + 'just did is how you learn to trust them.',
        };
    },
},

{
    // MU.2.O.3.1 — describe changes in tempo and dynamics WITHIN a work.
    // The towhee is the right bird: a slow opening and a fast trill, in
    // one phrase, every time.
    id: 'music-tempo-change',
    category: 'music',
    title: 'When the speed changes',
    bands: ['k-2', '3-5'],
    needsData: false,
    build({ rng }) {
        const rec = cmPlayableSound('Eastern Towhee');
        if (!rec) return null;

        const built = cmChoices('It starts slow and then speeds up into a trill',
            ['It stays at exactly the same speed all the way through',
             'It starts fast and then slows right down',
             'It stops and starts at random'], rng);
        if (!built) return null;

        return {
            prompt: 'Listen to the whole phrase. What happens to the SPEED inside it?',
            ...built,
            sound: rec,
            explain: '"Drink your teeeeea" — two slow notes, then the tea runs away '
                   + 'into a fast trill. A change of tempo inside one phrase is '
                   + 'something composers do deliberately, and this bird does it every '
                   + 'single time.',
        };
    },
},

{
    // MU.3.H.1.3 — identify timbre. Two birds of very different size make
    // timbre separable from pitch, which is the hard part of the idea.
    id: 'music-timbre',
    category: 'music',
    title: 'What kind of sound is it?',
    bands: ['3-5'],
    needsData: false,
    build({ rng }) {
        const rec = cmPlayableSound(['Mourning Dove', 'Barred Owl']);
        if (!rec) return null;

        const built = cmChoices('Soft and breathy, like blowing over a bottle',
            ['Bright and metallic, like a triangle',
             'Scratchy and rough, like a guiro',
             'Sharp and clicky, like claves'], rng);
        if (!built) return null;

        return {
            prompt: 'Listen. Which instrument has the closest TIMBRE — the closest '
                  + 'kind of sound — to this bird?',
            ...built,
            sound: rec,
            explain: 'Timbre is what makes two sounds at the same pitch and loudness '
                   + 'still sound unlike each other. A dove’s coo is soft and hollow, '
                   + 'with the air audible in it — much closer to blowing over a bottle '
                   + 'than to anything struck or scraped.',
        };
    },
},

{
    // MU.1.C.1.3 — pitched against unpitched. Birds divide the same way
    // instruments do, which is the connection worth making: a song has a
    // tune you could sing, a call does not.
    id: 'music-pitched-unpitched',
    category: 'music',
    title: 'A tune, or just a noise?',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const rec = cmPlayableSound(['American Crow', 'Blue Jay']);
        if (!rec) return null;

        const built = cmChoices('Unpitched, like a drum — you could not sing it',
            ['Pitched, like a xylophone — you could sing it back',
             'It is both at the same time',
             'It is silent'], rng);
        if (!built) return null;

        return {
            prompt: 'Instruments are pitched, like a xylophone, or unpitched, like a '
                  + 'drum. Listen to this bird. Which is it most like?',
            ...built,
            sound: rec,
            explain: 'A crow’s caw is a harsh noise with no clear note in it, so '
                   + 'there is nothing to sing back — like a drum or a woodblock. A '
                   + 'cardinal whistles real notes you could find on a xylophone. Birds '
                   + 'split the same way our instruments do.',
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Charts the class builds
// ════════════════════════════════════════════════════════════════════
//
//  The last of the gap list, and the reason it was last. Ten benchmarks
//  say COLLECT AND REPRESENT, CREATE, CONSTRUCT — and for two batches of
//  questions there was nothing honest to point at, because choosing one
//  of four options is not representing anything. They sat in --gaps on
//  purpose rather than being tagged against a multiple choice.
//
//  Each of these hands the class a table of real counts and an empty
//  chart, and they build it. The table is itself one of the
//  representations the benchmarks name, so the question is "turn this
//  representation into that one", which is the actual skill.
//
//  They refuse to build unless the step divides every count exactly:
//  the interaction is pressing + until the bar is right, and a target
//  the steps cannot land on is a bar the class can never finish. Quiet
//  weeks and awkward numbers mean no question rather than an
//  approximate one.
// ════════════════════════════════════════════════════════════════════

{
    // MA.1.DP.1.1 and MA.2.DP.1.1 — represent data with tally marks or
    // pictographs. One mark per visit at this age: the counting is the
    // lesson, and a key would be a second idea on top of it.
    id: 'build-tally',
    category: 'counting',
    title: 'Build the tally chart',
    bands: ['k-2'],
    build({ s }) {
        // DAYS, not visits. A week has seven of them, so every bar is
        // short enough for a five-year-old to build by pressing, and the
        // numbers are exact rather than rounded.
        const spec = cmBuildSpec('Days each bird came', cmDaysSeenSeries(s, 4),
            { kind: 'tally', unit: 'day', maxPresses: 7, maxRows: 4 });
        if (!spec) return null;

        return {
            prompt: 'The table says how many DAYS each bird came. Build the chart to '
                  + 'match — one mark for every day.',
            choices: [{ label: 'We built it correctly' }, { label: 'We needed another go' }],
            correct_index: 0,
            build: spec,
            explain: 'Reading a chart somebody else drew and drawing one yourself are '
                   + 'different skills, and the second is the one that makes the first '
                   + 'stick. Every mark stands for one day, so the row is as long as '
                   + 'the number beside it.',
        };
    },
},

{
    // MA.3.DP.1.1 — scaled pictographs and scaled bar graphs. The KEY is
    // the step up from the K-2 version: the chart no longer moves one at
    // a time, so the class has to divide before they press.
    id: 'build-pictograph',
    category: 'counting',
    title: 'Build the picture graph',
    bands: ['3-5'],
    build({ s }) {
        const spec = cmBuildSpec('Our picture graph', cmSpeciesSeries(s, 5),
            { kind: 'picto', scaled: true, unit: 'visit',
              steps: [2, 5, 10, 20, 25], maxPresses: 10 });
        if (!spec) return null;

        return {
            prompt: `Each bird on this graph stands for ${spec.step} visits. Work out how `
                  + `many birds each row needs, then build it.`,
            choices: [{ label: 'We built it correctly' }, { label: 'We needed another go' }],
            correct_index: 0,
            build: spec,
            explain: `With a key of ${spec.step}, a row is the count divided by `
                   + `${spec.step}, to the nearest whole bird. A picture graph rounds — `
                   + `that is the deal you make for a chart you can read across the `
                   + `room — so the heights are close to the counts rather than equal `
                   + `to them. Reading one without its key gives the wrong answer every `
                   + `time.`,
        };
    },
},

{
    // MA.5.DP.1.1 and SS.5.G.1.4 — construct a chart to display data,
    // including geographic data. Days rather than species, so it is a
    // different build from the pictograph in the same band.
    id: 'build-bar-chart',
    category: 'counting',
    title: 'Build the bar chart',
    bands: ['3-5', '6-8'],
    build({ s }) {
        // How many DIFFERENT species each day — a small whole number, so
        // the bars are exact. "How many visits" would need rounding, and a
        // bar chart that rounds is the wrong lesson for this benchmark.
        const perDay = s.days
            .map(d => ({ label: cmDayAxisLabel(d.day),
                         value: (s.daySpec.get(d.day) || new Map()).size,
                         key: d.day }))
            .filter(r => r.value > 0);

        const spec = cmBuildSpec('Kinds of bird each day', perDay,
            { kind: 'bars', unit: 'kind of bird', units: 'kinds of bird',
              maxPresses: 12, maxRows: 5 });
        if (!spec) return null;

        return {
            prompt: 'The table says how many DIFFERENT kinds of bird came each day. '
                  + 'Build the bar chart to match.',
            choices: [{ label: 'We built it correctly' }, { label: 'We needed another go' }],
            correct_index: 0,
            build: spec,
            explain: 'A bar chart turns a column of numbers into something you can '
                   + 'compare at a glance — which is the point of drawing one, and why '
                   + 'the heights have to be right rather than roughly right. Notice '
                   + 'this counts KINDS of bird, not visits: a day with forty doves and '
                   + 'nothing else is a short bar.',
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Temperature, which the feeder has recorded all along
// ════════════════════════════════════════════════════════════════════
//
//  Every detection carries a temperature and almost nothing read it.
//  These do, and they are shaped by what the research actually found
//  rather than by what feels true:
//
//  · Project FeederWatch volunteers' counts, matched against local
//    weather across 23 species, found birds visit feeders MORE as
//    temperatures dip below average — and found no relationship with
//    precipitation or wind speed. The null result is the more useful
//    half for a classroom.
//  · A 2023 radio-tracking study of Tufted Titmice found more feeder
//    visits in cold, snowy weather.
//  · A 2021 Behavioral Ecology study of Downy Woodpeckers and
//    White-breasted Nuthatches found that the activity of a bird's
//    SOCIAL PARTNERS explained its foraging better than overnight
//    temperature did.
//
//  That last one is why cold-weather-means-more-birds is not taught
//  here as a fact. Our feeder's own week is the evidence, and a class
//  that finds the opposite has found something real about their week
//  rather than having got the question wrong.

{
    // The FeederWatch finding, tested against this class's own fortnight
    // rather than asserted. Below-average days against above-average
    // days is exactly how that study framed it.
    id: 'temp-below-average',
    category: 'analysis',
    title: 'Colder than usual',
    bands: ['6-8'],
    build({ s14, band, rng }) {
        const days = [];
        s14.days.forEach(d => {
            const t = s14.dayTemp.get(d.day);
            if (t && t.n >= 3) days.push({ day: d.day, n: d.n, deg: t.sum / t.n });
        });
        if (days.length < 7) return null;

        const mean = days.reduce((a, b) => a + b.deg, 0) / days.length;
        const cold = days.filter(d => d.deg <  mean);
        const warm = days.filter(d => d.deg >= mean);
        if (cold.length < 2 || warm.length < 2) return null;

        const per = g => g.reduce((a, b) => a + b.n, 0) / g.length;
        const coldPer = per(cold), warmPer = per(warm);
        // A difference smaller than a quarter is not something a class can
        // read off a chart, and calling it one would teach the opposite of
        // the lesson.
        if (Math.abs(coldPer - warmPer) < Math.max(1, Math.min(coldPer, warmPer) * 0.25)) return null;

        const colder = coldPer > warmPer;
        const built = cmChoices(
            colder ? 'On the colder-than-usual days' : 'On the warmer-than-usual days',
            [colder ? 'On the warmer-than-usual days' : 'On the colder-than-usual days',
             'Exactly the same on both',
             'The chart cannot tell us'], rng);
        if (!built) return null;

        return {
            prompt: 'Split our fortnight into days colder than average and days warmer '
                  + 'than average. Which group got more visits per day?',
            ...built,
            chart: cmChart('Visits per day, split by temperature', [
                { label: 'Colder than average', value: Math.round(coldPer * 10) / 10, key: 'c',
                  color: cmHeatColor(0.1) },
                { label: 'Warmer than average', value: Math.round(warmPer * 10) / 10, key: 'w',
                  color: cmHeatColor(0.9) },
            ], { band, kind: 'hbars' }),
            explain: 'Our average was ' + Math.round(mean) + '°. Colder days averaged '
                   + coldPer.toFixed(1) + ' visits, warmer days ' + warmPer.toFixed(1)
                   + '. Across 23 species, Project FeederWatch found birds visit more as '
                   + 'temperatures dip below average — so our week '
                   + (colder ? 'agrees with that' : 'does NOT agree, which is worth '
                      + 'explaining rather than explaining away')
                   + '. One fortnight at one feeder is not enough to settle it either way.',
        };
    },
},

{
    // The null result, which is the harder and more useful idea: a
    // variable that was measured and turned out not to matter.
    id: 'temp-what-else',
    category: 'science',
    title: 'What else could it be?',
    bands: ['6-8'],
    build({ s14, rng }) {
        if (s14.tempCoverage < 0.5 || s14.days.length < 7) return null;

        const built = cmChoices(
            'Watch for other things that change with the cold, like daylight and wind',
            ['Decide the cold causes it and stop there',
             'Ignore the temperature from now on',
             'Only count birds on cold days'], rng);
        if (!built) return null;

        return {
            prompt: 'Suppose our colder days really did have more visits. What should a '
                  + 'scientist do next?',
            ...built,
            explain: 'Cold days are also shorter, often windier, and come later in the '
                   + 'season — so "cold" arrives bundled with several other changes and '
                   + 'any of them could be doing the work. Researchers who matched '
                   + 'feeder counts to weather found temperature mattered but wind and '
                   + 'rain did not, and another study found that what a bird’s '
                   + 'NEIGHBOURS were doing predicted its feeding better than the '
                   + 'temperature did. Finding a pattern is the start of the work.',
        };
    },
},

{
    // MA.3.M.1.2 territory at 3-5: a real measurement question where the
    // answer is often "no", which is the point.
    id: 'temp-coldest-busiest',
    category: 'analysis',
    title: 'Was the coldest day the busiest?',
    bands: ['3-5'],
    build({ s14, band, rng }) {
        const days = [];
        s14.days.forEach(d => {
            const t = s14.dayTemp.get(d.day);
            if (t && t.n >= 3 && d.n > 0) days.push({ day: d.day, n: d.n, deg: Math.round(t.sum / t.n) });
        });
        if (days.length < 6) return null;

        const coldest = days.reduce((a, b) => (b.deg < a.deg ? b : a));
        const busiest = days.reduce((a, b) => (b.n > a.n ? b : a));
        // ⚠ FOR THE COLOUR SCALE ONLY, and it must be the WARMEST day
        // rather than the busiest. Scaling the heat ramp by the busiest
        // day's temperature is comparing a count against a temperature,
        // and when the busiest day IS the coldest the denominator
        // collapses to zero and every bar comes out the same colour.
        const warmest = days.reduce((a, b) => (b.deg > a.deg ? b : a));
        const span = Math.max(1, warmest.deg - coldest.deg);
        const same = coldest.day === busiest.day;

        const built = cmChoices(same ? 'Yes — they were the same day'
                                     : 'No — the busiest day was a different one',
            [same ? 'No — the busiest day was a different one'
                  : 'Yes — they were the same day',
             'There was no coldest day',
             'We did not measure the temperature'], rng);
        if (!built) return null;

        return {
            prompt: 'Was our COLDEST day also our BUSIEST day?',
            ...built,
            chart: cmChart('Temperature each day',
                days.map(d => ({ label: cmDayAxisLabel(d.day), value: d.deg, key: d.day,
                                 sub: d.n + ' visits',
                                 color: cmHeatColor((d.deg - coldest.deg) / span) })),
                { band, showValues: true }),
            explain: 'The coldest day was ' + cmDayAxisLabel(coldest.day) + ' at '
                   + coldest.deg + '° with ' + coldest.n + ' visits; the busiest was '
                   + cmDayAxisLabel(busiest.day) + ' with ' + busiest.n + '. '
                   + (same
                      ? 'This time they match — but one week matching is not proof, it is '
                        + 'one week matching.'
                      : 'They are different days, and that is a real result. People expect '
                        + 'cold to mean hungry birds, and sometimes it does — but what '
                        + 'actually happened is what the data says.'),
        };
    },
},


// ════════════════════════════════════════════════════════════════════
//  Three more the research suggested, and the feeder can answer
// ════════════════════════════════════════════════════════════════════
//
//  · Feeder watchers have argued for years about whether birds feed in
//    two bursts with a quiet middle. A study of black-capped chickadees
//    found their feeder visits were always bimodal, peaking around half
//    past eight and three o'clock with the dip shrinking as the day got
//    busier. An earlier study that EXPECTED that shape did not find it
//    and suggested mild weather had taken the pressure off. A winter
//    study with tagged birds found several species peaked in the
//    afternoon instead.
//  · Project FeederWatch volunteers recorded one bird making another
//    give way, tens of thousands of times, and the result was the first
//    dominance ranking of 136 North American feeder species. Heavier
//    birds generally displaced lighter ones; a follow-up found mass
//    tracked dominance closely. Not perfectly, though - some species
//    punch well above their weight, woodpeckers especially.
//
//  The disagreement is the reason both of these are questions rather
//  than facts. A class whose feeder comes out the other way has found
//  something about their feeder, not got the answer wrong, and that is
//  what SC.8.N.1.3 means by "results support" and "fail to support".

{
    id: 'shape-of-the-day',
    category: 'time',
    title: 'The shape of the day',
    bands: ['6-8'],
    build({ s14, band, rng }) {
        if (s14.total < 40) return null;
        const h = s14.byHour;

        // Only the hours the feeder is actually awake for. Counting the
        // empty small hours would flatten every shape into "one spike".
        let lo = 0, hi = 23;
        while (lo < 24 && !h[lo]) lo++;
        while (hi >= 0 && !h[hi]) hi--;
        if (hi - lo < 5) return null;

        const span = [];
        for (let i = lo; i <= hi; i++) span.push({ h: i, n: h[i] });
        const peak = span.reduce((a, b) => (b.n > a.n ? b : a));
        const mean = span.reduce((a, b) => a + b.n, 0) / span.length;

        // A second peak has to be a separate EVENT, not the shoulder of the
        // first one. The first version of this took the tallest hour two or
        // more away from the peak and then checked the valley, which on a
        // real fortnight picked 6am as the "second peak" of an 8am peak -
        // the same morning rush, two hours wide - and then rejected the
        // whole thing because there is no valley inside a single rush.
        //
        // So the valley is tested for EVERY candidate, and the tallest hour
        // that genuinely sits across a valley wins. The bar for the second
        // peak is also much lower than it first was: it has to beat an
        // average hour, not two thirds of the busiest one. Our own feeder
        // settled that - a 75-visit dawn rush, four visits an hour through
        // the middle of the day, and 27 again at five o'clock is two spells
        // by any reading, and a 0.6 threshold called it one.
        let second = null;
        span.forEach(x => {
            if (Math.abs(x.h - peak.h) < 2) return;
            // Better than an average hour is not enough on a quiet feeder:
            // twenty-one visits at dawn and five at three o'clock is one
            // spell and a trickle, and calling the trickle a second peak put
            // a conclusion in a class's mouth that the chart does not carry.
            if (x.n < Math.max(4, peak.n * 0.25)) return;
            const a = Math.min(peak.h, x.h), b = Math.max(peak.h, x.h);
            const trough = span.filter(y => y.h > a && y.h < b)
                               .reduce((m, y) => Math.min(m, y.n), Infinity);
            if (!isFinite(trough)) return;
            if (trough > Math.min(peak.n, x.n) * 0.5) return;
            if (!second || x.n > second.n) second = { h: x.h, n: x.n, dip: trough };
        });
        const twoPeaked = !!second;

        // Where the one peak sits, when there is only one. "Quieter either
        // side of it" was the only single-peak answer on offer and it was
        // flatly untrue of a feeder whose busiest hour is the first hour it
        // is awake, which is the commonest shape there is.
        const width = hi - lo;
        const third = peak.h <= lo + width / 3 ? 'early'
                    : peak.h >= hi - width / 3 ? 'late' : 'mid';
        const flat = peak.n <= mean * 1.6;

        const ANSWERS = {
            two:   'Two busy spells with a quieter patch in between',
            early: 'Busiest first thing, then quieter all day',
            late:  'Quiet early, then busiest near the end of the day',
            mid:   'One busy spell in the middle of the day',
            flat:  'About the same all day long',
        };
        const key = twoPeaked ? 'two' : flat ? 'flat' : third;
        const built = cmChoices(ANSWERS[key],
            cmShuffle(Object.keys(ANSWERS).filter(k => k !== key)
                            .map(k => ANSWERS[k]), rng), rng);
        if (!built) return null;

        return {
            prompt: 'Look at the shape of our fortnight hour by hour. Which of these '
                  + 'describes it best?',
            ...built,
            chart: cmChart('Visits by hour, whole fortnight',
                span.map(x => ({ label: fmtHourShort(x.h), value: x.n, key: String(x.h) })),
                { band, ordered: true, kind: 'line', maxBars: CHART_MAX_HOURS }),
            explain: 'Our busiest hour was ' + fmtHourShort(peak.h) + ' with '
                   + peak.n + ' visits, against ' + mean.toFixed(1) + ' in an average hour'
                   + (twoPeaked
                      ? ', and a second spell around ' + fmtHourShort(second.h)
                        + ' with the quiet patch between them down to ' + second.dip + '.'
                      : '.')
                   + ' Researchers watching chickadees at feeders found two peaks every '
                   + 'time, around half past eight and three o’clock, with the midday '
                   + 'dip shrinking on busier days — but an earlier study that expected '
                   + 'that shape did not find it, and a winter study of tagged birds '
                   + 'found several species busiest in the afternoon instead. So our '
                   + 'fortnight '
                   + (twoPeaked ? 'supports the two-peak picture'
                                : 'does not support the two-peak picture')
                   + '. Saying which is the whole job; "results support" and "results '
                   + 'fail to support" are the honest words for it either way.',
        };
    },
},

{
    id: 'who-gives-way',
    category: 'science',
    title: 'Who gives way?',
    bands: ['6-8'],
    build({ s, band, rng }) {
        const sized = s.species
            .map(x => ({ species: x.species, n: x.n, size: CM_BIRD_SIZE[x.species] }))
            .filter(x => x.size === 'small' || x.size === 'large');
        const small = sized.filter(x => x.size === 'small');
        const large = sized.filter(x => x.size === 'large');
        // Only ever small against large. Anything closer than that and the
        // published weights overlap, which would make this a guess dressed
        // up as a question.
        if (!small.length || !large.length) return null;

        const big = cmShuffle(large, rng)[0];
        const wee = cmShuffle(small, rng)[0];
        const built = cmChoices(big.species,
            [wee.species, 'Whichever one got there first', 'They would share the perch'], rng);
        if (!built) return null;

        return {
            prompt: `Both the ${big.species} and the ${wee.species} came to our feeder `
                  + 'this week. If they arrived at the same perch at the same moment, '
                  + 'which one would you EXPECT to make the other give way?',
            ...built,
            image: cmShotFor(s, big.species),
            image_on_reveal: true,
            explain: `The ${big.species}, because it is much the bigger bird. Project `
                   + 'FeederWatch volunteers recorded one bird displacing another tens '
                   + 'of thousands of times and built the first dominance ranking for '
                   + '136 feeder species: the heavier bird usually wins, and a follow-up '
                   + 'study found weight tracked rank closely. Usually, not always — '
                   + 'some birds rank far above their weight, woodpeckers in particular, '
                   + 'and the researchers were surprised by several of their own results. '
                   + '"Expect" is doing real work in that question: it is a prediction '
                   + 'from a pattern, and our camera has not watched these two meet.',
            about_bird: big.species,
        };
    },
},

{
    id: 'not-a-bird',
    category: 'science',
    title: 'Not a bird',
    bands: ['3-5'],
    build({ s14, rng }) {
        if (!s14.others || !s14.others.size) return null;
        const name = cmShuffle([...s14.others.keys()], rng)[0];
        const group = cmAnimalGroup(name);
        if (!group) return null;

        const GROUPS = { mammal: 'A mammal', reptile: 'A reptile',
                         amphibian: 'An amphibian', insect: 'An insect' };
        // "A bird" goes in FIRST. It is the distractor that matters, because
        // the camera is a bird camera and the class has spent the lesson
        // being told that is what it watches - and building the list the
        // other way round sliced it off the end every time.
        const built = cmChoices(GROUPS[group],
            ['A bird'].concat(cmShuffle(Object.keys(GROUPS)
                .filter(k => k !== group).map(k => GROUPS[k]), rng)).slice(0, 3), rng);
        if (!built) return null;

        const n = s14.others.get(name);
        // "a Deer" mid-sentence reads as a proper noun. Bird names are
        // capitalised because they are species names; these are common nouns
        // and the detector just happens to shout them.
        const low = String(name).toLowerCase();
        return {
            prompt: `Our camera watches for birds, but it photographs whatever turns up `
                  + `— and this fortnight it caught a ${low}. Which group of animals `
                  + `does a ${low} belong to?`,
            ...built,
            explain: `A ${low} is not a bird: ${GROUPS[group].toLowerCase()}. It turned `
                   + `up ${n === 1 ? 'once' : n + ' times'} in our fortnight, and the counting `
                   + 'questions leave it out for exactly that reason — "how many bird '
                   + 'visits" has to mean birds. Sorting what the camera sees into groups '
                   + 'is the same job scientists do with every new animal they find, and '
                   + 'the camera cannot do it for us.',
        };
    },
},

// ═════════════════════════════════════════════════════════════════════
//  The number beside the bird's name
// ═════════════════════════════════════════════════════════════════════
//
//  Every detection has carried a confidence figure since the first one, and
//  until now the lesson used it only to sort photographs. That is a waste of
//  the single most honest thing our camera produces: a machine saying out
//  loud how sure it is, and being wrong sometimes anyway.
//
//  It is also the one place a feeder can teach what a confidence score is
//  WITHOUT a worksheet, because the class can see the bird. The research is
//  blunt about the limits:
//
//    · Calibration - the agreement between a model's stated confidence and
//      how often it is actually right - is not something a classifier gets
//      for free. A model can be accurate overall and badly calibrated, and
//      wrong answers are often given with high confidence.
//    · Work on BirdNET, the model behind Merlin's sound ID, found that
//      raising the confidence threshold raises the share of identifications
//      that are correct but cuts the number of detections you keep. The same
//      work found that a single global threshold performs only moderately
//      and that good thresholds differ species by species.
//    · A score reflects how closely the input matched what the model was
//      trained on. It is not a promise about the bird.
//
//  So none of these questions says the percentage is a probability of being
//  right. They say a higher number is a better bet, which is true, and they
//  say where that stops being true, which is the part worth a lesson.

{
    // MA.7.DP.2.2 wants a child given a probability to interpret the
    // likelihood and compare two of them. Our camera hands them two, about
    // two birds they can see, which beats a bag of marbles.
    id: 'confidence-compare',
    category: 'science',
    title: 'How sure is sure?',
    bands: ['6-8'],
    build({ s14, rng }) {
        const scored = s14.rows
            .map(r => ({ sp: r.species, c: cmConfPct(r) }))
            .filter(x => x.c > 0)
            .sort((a, b) => b.c - a.c);
        if (scored.length < 2) return null;

        // Different species, and a gap wide enough that the comparison is
        // not noise wearing a decimal point.
        const hi = scored[0];
        const lo = scored.slice().reverse()
                         .find(x => x.sp !== hi.sp && hi.c - x.c >= 20);
        if (!lo) return null;

        const built = cmChoices(`The ${hi.sp}`,
            [`The ${lo.sp}`,
             'Both are equally likely to be right',
             'The percentage cannot tell us anything about that'], rng);
        if (!built) return null;

        return {
            prompt: 'Beside every bird it finds, our camera writes down how sure it '
                  + `is. This fortnight it was ${Math.round(hi.c)}% sure about a `
                  + `${hi.sp}, and only ${Math.round(lo.c)}% sure about a `
                  + `${lo.sp}. Which identification is MORE LIKELY to be right?`,
            ...built,
            explain: `The ${hi.sp}, at ${Math.round(hi.c)}%. A higher number is a `
                   + 'better bet — but it is a bet, not a promise. The figure says '
                   + 'how closely the picture matched the birds the computer was '
                   + 'trained on, which is not the same as how likely it is to be '
                   + 'right, and a computer can be confident and wrong at the same '
                   + 'time. Researchers testing BirdNET, the model behind Merlin’s '
                   + 'sound ID, found exactly that: scores had to be read species by '
                   + `species. So ${Math.round(lo.c)}% is worth checking ourselves, `
                   + `and ${Math.round(hi.c)}% is worth checking too — just less `
                   + 'urgently.',
            about_bird: hi.sp,
        };
    },
},

{
    // This started life as "which species was the camera least sure about,
    // on average", tagged MA.7.DP.1.2. Production killed it: the species
    // means on a real feeder come out 46.7, 51.2, 63.0, 65.3, 66.4, 67.7 and
    // 85.8, and the two lowest are 4.5 points apart with three sightings
    // each. A question resting on that gap would be teaching a class to read
    // noise as a finding, which is the opposite of the point.
    //
    // The spread WITHIN one species is where the signal actually is, and it
    // is enormous: 177 Northern Cardinals from 38% to 97%, 60 Mourning Doves
    // from 36% to 95%. Same bird, same feeder, same camera. So the camera's
    // uncertainty is mostly about the PHOTOGRAPH, not about the species -
    // which is both the honest reading and the more useful lesson.
    //
    // MA.6.DP.1.4: given a histogram, describe and interpret the spread.
    id: 'confidence-same-bird',
    category: 'science',
    title: 'The same bird, twice',
    bands: ['6-8'],
    build({ s14, band, rng }) {
        const by = new Map();
        s14.rows.forEach(r => {
            const c = cmConfPct(r);
            if (!c) return;
            if (!by.has(r.species)) by.set(r.species, []);
            by.get(r.species).push(c);
        });

        // Enough sightings for a spread to be a spread, and a spread wide
        // enough to be worth explaining. Most sightings of one species, to
        // give the histogram something to show.
        const pick = [...by.entries()]
            .map(([sp, v]) => ({ sp, v, n: v.length,
                                 lo: Math.min(...v), hi: Math.max(...v) }))
            .filter(x => x.n >= 10 && x.hi - x.lo >= 30)
            .sort((a, b) => b.n - a.n)[0];
        if (!pick) return null;

        const built = cmChoices(
            'How clear each photo happened to be — the angle, the light, how much '
            + 'of the bird showed',
            ['The birds later in the fortnight were easier to recognise',
             'The low-scoring ones were probably a different species',
             'The camera gets less sure as its battery runs down'], rng);
        if (!built) return null;

        const bins = [];
        for (let b = 30; b < 100; b += 10) {
            bins.push({ label: `${b}\u2013${b + 9}`,
                        value: pick.v.filter(c => c >= b && c < b + 10).length });
        }

        return {
            // Kept short on purpose. The first draft ran eleven lines on a
            // projector and pushed two of the four options off the bottom of
            // the screen, which no amount of good content survives.
            prompt: `Our camera recorded ${pick.n} sightings of the ${pick.sp} this `
                  + `fortnight — and it was ${Math.round(pick.hi)}% sure about one of `
                  + `them, ${Math.round(pick.lo)}% about another. Same species, same `
                  + 'feeder, same camera. What best explains the spread?',
            ...built,
            image: cmShotFor(s14, pick.sp),
            image_on_reveal: true,
            chart: cmChart(`How sure the camera was about the ${pick.sp}, %`,
                bins, { band, ordered: true }),
            explain: `The photograph, not the bird. All ${pick.n} of these were the `
                   + `same species, and the camera's confidence still ran from `
                   + `${Math.round(pick.lo)}% to ${Math.round(pick.hi)}% — a spread of `
                   + `${Math.round(pick.hi - pick.lo)} points. A bird half behind a `
                   + 'branch, facing away, in bad light or caught mid-flap looks much '
                   + 'less like the pictures the computer learned from than one sitting '
                   + 'square on the perch in the sun. The people who build these models '
                   + 'report the same thing: accuracy that swings from around 97% down '
                   + 'to about 60% depending on conditions. So a low score is usually a '
                   + 'complaint about the photo rather than a doubt about the species — '
                   + 'and it still does not prove the high-scoring one was right.',
            about_bird: pick.sp,
        };
    },
},

{
    // MA.6.DP.1.4 — given a histogram, describe and interpret the spread.
    // The whole question is what the shape of this distribution costs you if
    // you cut it off at 80, which is the benchmark's own work.
    id: 'confidence-threshold',
    category: 'science',
    title: 'Where to draw the line',
    bands: ['6-8'],
    build({ s14, band, rng }) {
        const conf = s14.rows.map(cmConfPct).filter(c => c > 0);
        if (conf.length < 30) return null;

        const strict = conf.filter(c => c >= 80).length;
        // The question is about a cost, so there has to be one: keep it for
        // feeders where raising the bar actually throws most of the
        // fortnight away, and where it does not throw away everything.
        if (!strict || strict / conf.length > 0.45) return null;

        const bins = [];
        for (let b = 30; b < 100; b += 10) {
            bins.push({ label: `${b}–${b + 9}`,
                        value: conf.filter(c => c >= b && c < b + 10).length });
        }

        const built = cmChoices(
            'We would trust every sighting we kept more, and we would lose most of them',
            ['We would trust every sighting we kept more, and lose none of them',
             'We would end up with more sightings than we started with',
             'Nothing would change except the labels'], rng);
        if (!built) return null;

        return {
            prompt: `Our camera logged ${conf.length} sightings this fortnight, and was `
                  + `80% sure or better about only ${strict} of them. What would we `
                  + 'gain, and what would we lose, if we threw away everything below '
                  + '80%?',
            ...built,
            chart: cmChart('How sure the camera was, in ten-point bands',
                bins, { band, ordered: true }),
            explain: `Both at once. We would keep ${strict} of ${conf.length} sightings `
                   + `— about ${Math.round(strict / conf.length * 100)}% — and every one `
                   + 'we kept would be a better bet. We would also throw away '
                   + `${conf.length - strict} real visits by real birds, because a bird `
                   + 'the camera was only 60% sure about is usually still a bird. '
                   + 'Researchers testing BirdNET found this exact trade: a higher '
                   + 'threshold raises the share of identifications that are correct '
                   + 'and cuts how many you keep. There is no setting that avoids the '
                   + 'choice. Where you draw the line depends on what the mistake '
                   + 'would cost — and that is a decision about your question, not a '
                   + 'fact about the camera.',
        };
    },
},

{
    // SC.7.N.1.6 — empirical evidence is the CUMULATIVE body of observations.
    // One camera, one feeder, one fortnight is the smallest possible slice of
    // that, and a rarity label is the place a class can see why it matters.
    id: 'rarity-one-sighting',
    category: 'science',
    title: 'What counts as rare',
    bands: ['6-8'],
    build({ s14, rng }) {
        // Counted off the rows rather than the summary tally, because the
        // question wants to NAME the unusual birds, and four sightings that
        // are four different species is not "this bird".
        const labelled = s14.rows.filter(r => cmRarityLabel(r));
        if (labelled.length < 20) return null;
        const odd   = labelled.filter(r => cmRarityLabel(r) !== 'Common');
        const oddSp = [...new Set(odd.map(r => r.species))];

        // Two directions, because a fortnight that saw nothing unusual is
        // the commoner case by far and has a better question in it than a
        // null.
        if (odd.length) {
            const many = odd.length > 1;
            const subj = many ? 'these birds' : 'this bird';
            const names = oddSp.length === 1 ? `the ${oddSp[0]}`
                        : oddSp.length === 2 ? `the ${oddSp[0]} and the ${oddSp[1]}`
                        : oddSp.length <= 4
                            ? oddSp.slice(0, -1).map(x => `the ${x}`).join(', ')
                              + `, and the ${oddSp[oddSp.length - 1]}`
                            : '';
            const built = cmChoices(
                `That ${subj} ${many ? 'are' : 'is'} not often seen around HERE \u2014 and `
                + `${many ? 'a few sightings are' : 'one sighting is'} a start, not a `
                + 'finding',
                [`That ${subj} ${many ? 'are' : 'is'} rare everywhere in the world`,
                 'That the camera made a mistake',
                 `That no one else has ever recorded ${many ? 'them' : 'one'}`], rng);
            if (!built) return null;
            return {
                prompt: 'Our camera labels every sighting Common, Uncommon or Rare for '
                      + `this area. Of the ${labelled.length} sightings it labelled this `
                      + `fortnight, ${odd.length} ${many ? 'were' : 'was'} not Common`
                      + (names ? ` \u2014 ${names}` : '') + '. What does that actually '
                      + 'tell us?',
                ...built,
                explain: 'Rarity labels are LOCAL. eBird, the biggest record of bird '
                       + 'sightings there is, decides what to flag using a filter kept '
                       + 'for each region by reviewers who live there \u2014 not one '
                       + 'national list \u2014 so the same species can be routine in one '
                       + 'county and flagged in the next, and a bird can be flagged '
                       + 'simply for turning up out of season. Those filters are built '
                       + 'from years of records by thousands of people. Our one camera, '
                       + `at one feeder, over ${labelled.length} labelled sightings in a `
                       + 'fortnight, is a very small piece of that. It is worth '
                       + 'recording and it is not enough to conclude anything on its '
                       + 'own, which is what makes it evidence rather than proof.',
            };
        }

        const built = cmChoices(
            'Only that nothing unusual came to OUR feeder, in OUR fortnight',
            ['That there are no uncommon birds in our area',
             'That our camera cannot recognise an unusual bird',
             'That we have now seen every species that lives here'], rng);
        if (!built) return null;
        return {
            prompt: 'Our camera labels every sighting Common, Uncommon or Rare for this '
                  + `area. All ${labelled.length} of the sightings it labelled this `
                  + 'fortnight came back Common. What does that tell us?',
            ...built,
            explain: 'Not much about the neighbourhood, and quite a lot about our '
                   + 'sample. One camera pointed at one feeder for two weeks sees the '
                   + 'birds that use that feeder, at that time of year \u2014 and the '
                   + 'commonest birds are common precisely because they turn up most. '
                   + 'An unusual bird is unusual: a fortnight is nowhere near long '
                   + 'enough to say it is not around. This is why rarity filters are '
                   + 'built from years of records by thousands of people rather than '
                   + 'from any one observer, however careful. Our fortnight is one '
                   + 'honest contribution to that pile, not a verdict.',
        };
    },
},

// ════════════════════════════════════════════════════════════════════
//  Statistics the community site already draws, in the classroom
// ════════════════════════════════════════════════════════════════════
//
//  Every benchmark is covered, so none of these close a gap. They are
//  here because the Stats tab on the community site computes a dozen
//  things no lesson has ever used — streaks, first sightings, species
//  that have stopped coming, which two birds share a day — and a class
//  watching the same feeder deserves the questions their teacher can
//  already see the answers to.
//
//  VARIETY IS A REAL PROBLEM, not a nicety: a class running a lesson
//  every day meets the whole set in a fortnight, which is exactly why
//  the ordering code bothers to push repeats to the back.

{
    // The Records tab counts consecutive active days. A streak is a
    // pattern in time, and it is the kind of number a class can check
    // itself on the following morning.
    id: 'stat-streak',
    category: 'counting',
    title: 'Days in a row',
    bands: ['3-5'],
    build({ s14, band, rng }) {
        const days = s14.days;
        if (days.length < 8) return null;

        // ⚠ PER SPECIES, NOT PER FEEDER. The first version asked for the
        // longest run of days ANY bird came, and on a live feeder that is
        // every day in the window — the answer is "all of them", which a
        // class can say without counting anything, so the guard threw the
        // question away and it never built once on real data.
        //
        // One bird's run is a real streak: it starts, it breaks, and
        // finding it means reading along the row looking for the gap.
        // ⚠ WALK THE SPECIES LIST. Taking the commonest bird was the
        // second version of this and it failed the same way as the first:
        // on a live feeder the top species turns up EVERY day, so its run
        // is the whole window and the answer is "all of them" again.
        // Fixing "any bird" by going per-species only moved the problem
        // down one level. A streak is only a question when it breaks, so
        // this looks for a bird whose run actually does.
        let pick = null, best = 0;
        for (const cand of s14.species.slice(0, 6)) {
            const onDay = new Set();
            s14.daySpec.forEach((m, day) => { if (m.has(cand.species)) onDay.add(day); });

            let b = 0, run = 0;
            days.forEach(d => { run = onDay.has(d.day) ? run + 1 : 0; if (run > b) b = run; });
            if (b >= 2 && b < days.length) { pick = cand; best = b; break; }
        }
        if (!pick) return null;

        const onDay = new Set();
        s14.daySpec.forEach((m, day) => { if (m.has(pick.species)) onDay.add(day); });

        const built = cmChartCountChoices(best, rng, null, 3);
        if (!built) return null;

        return {
            prompt: 'What is the longest run of days IN A ROW that a ' + pick.species
                  + ' came?',
            ...built,
            chart: cmChart(pick.species + ' each day',
                days.map(d => ({ label: cmDayAxisLabel(d.day),
                                 value: onDay.has(d.day) ? 1 : 0, key: d.day })),
                { band, kind: 'bars', plain: true, showValues: false }),
            image: cmShotFor(s14, pick.species),
            explain: best + ' days in a row. A single missed day breaks a run, so '
                   + 'counting one means hunting for the gaps rather than for the '
                   + 'busy days.',
            about_bird: pick.species,
        };
    },
},

{
    // "New arrivals" on the Records tab: a species whose first sighting
    // in the window is recent. For a class this is the question that
    // makes a feeder feel alive — something turned up that was not here
    // before.
    id: 'stat-new-arrival',
    category: 'science',
    title: 'Who is new?',
    bands: ['3-5', '6-8'],
    build({ s14, rng }) {
        const first = new Map();
        s14.rows.forEach(r => {
            const t = new Date(r.detected_at).getTime();
            if (!first.has(r.species) || t < first.get(r.species)) first.set(r.species, t);
        });
        if (first.size < 4) return null;

        const cutoff = Date.now() - 5 * 86400000;
        const fresh = [...first.entries()].filter(e => e[1] >= cutoff).map(e => e[0]);
        const old   = [...first.entries()].filter(e => e[1] <  cutoff).map(e => e[0]);

        // ⚠ ONE NEWCOMER ON THE SLIDE, not one newcomer in the fortnight.
        // The first version demanded exactly one recent arrival across the
        // whole feeder, and a real community had three — so it never
        // built. What the question actually needs is that only one of the
        // FOUR OPTIONS is new, which is a property of the options.
        if (!fresh.length || old.length < 3) return null;
        const answer = cmShuffle(fresh, rng)[0];

        const built = cmChoices(answer, cmShuffle(old, rng).slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: 'Three of these birds have been coming all fortnight. One only '
                  + 'turned up in the last few days. Which is the newcomer?',
            ...built,
            image: cmShotFor(s14, answer),
            image_on_reveal: true,
            explain: 'The ' + answer + '. Birds move with the seasons and with what '
                   + 'there is to eat, so the list of who comes to a feeder is never '
                   + 'finished — which is the reason to write it down every day.',
            about_bird: answer,
        };
    },
},

{
    // The Pairs tab counts how often two species share a day. That is
    // co-occurrence, and it is the evidence behind the relationships
    // SC.7.L.17.2 names.
    id: 'stat-pair-days',
    category: 'science',
    title: 'Seen on the same day',
    bands: ['6-8'],
    build({ s14, rng }) {
        const SEP = ' & ';
        const pairs = new Map();
        s14.daySpec.forEach(m => {
            const sp = [...m.keys()].sort();
            for (let i = 0; i < sp.length; i++) {
                for (let j = i + 1; j < sp.length; j++) {
                    const k = sp[i] + SEP + sp[j];
                    pairs.set(k, (pairs.get(k) || 0) + 1);
                }
            }
        });
        if (pairs.size < 4) return null;

        const ranked = [...pairs.entries()].sort((a, b) => b[1] - a[1]);
        // A tie at the top has two right answers.
        if (ranked[0][1] < 3 || ranked[0][1] === ranked[1][1]) return null;

        const built = cmChoices(ranked[0][0], ranked.slice(1, 4).map(e => e[0]), rng);
        if (!built) return null;

        return {
            prompt: 'Which of these pairs of birds turned up on the SAME day most often?',
            ...built,
            explain: ranked[0][0] + ' shared ' + ranked[0][1] + ' days. Two species at '
                   + 'one feeder are after the same seed — but sharing a day is not '
                   + 'sharing a minute, and the camera cannot tell you which. That gap '
                   + 'between what the data shows and what you would like it to show is '
                   + 'the thing worth noticing.',
        };
    },
},

{
    // The Life List gives every species its own peak hour. One species
    // at a time is a sharper question than "when is the feeder busy",
    // because the answer genuinely differs per bird.
    id: 'stat-species-hour',
    category: 'time',
    title: 'When does this bird come?',
    bands: ['3-5'],
    build({ s, band, rng }) {
        if (!s.species.length) return null;
        const pick = s.species[0];

        const hours = new Array(24).fill(0);
        s.rows.forEach(r => {
            if (r.species === pick.species) hours[new Date(r.detected_at).getHours()]++;
        });
        const peak = hours.indexOf(Math.max(...hours));
        if (hours[peak] < 3) return null;

        // Only hours this bird was actually seen, so every wrong option is
        // still a bar on the chart rather than an hour nothing happened.
        const seen = hours.map((n, h) => ({ n: n, h: h }))
                          .filter(x => x.n > 0 && x.h !== peak);
        if (seen.length < 2) return null;

        const built = cmChoices(fmtHourShort(peak),
            cmShuffle(seen, rng).slice(0, 3).map(x => fmtHourShort(x.h)), rng);
        if (!built) return null;

        return {
            prompt: 'At what time of day did the ' + pick.species + ' come most often?',
            ...built,
            chart: cmChart(pick.species + ' by hour',
                hours.map((n, h) => ({ label: fmtHourShort(h), value: n, key: String(h) }))
                     .filter(r => r.value > 0),
                { band, ordered: true, maxBars: CHART_MAX_HOURS }),
            image: cmShotFor(s, pick.species),
            explain: 'Most ' + pick.species + ' visits were around ' + fmtHourShort(peak)
                   + '. Different birds keep different hours at the same feeder, so '
                   + '"when is it busy" has a different answer for every one of them.',
            about_bird: pick.species,
        };
    },
},

{
    // MA.6.GR.1.1 — plot rational ordered pairs in ALL FOUR quadrants.
    //
    // Counts and temperatures are positive, so a chart of them never
    // leaves the first quadrant and the benchmark's own clause goes
    // unmet. CHANGES are signed by nature: a day that was colder and
    // quieter than the one before is genuinely (−, −). That is what
    // makes the feeder able to carry this at all.
    id: 'plot-the-change',
    category: 'math',
    title: 'Plot the day',
    bands: ['6-8'],
    build({ s14, rng }) {
        // Days that have both a temperature and a previous day to compare
        // with, as (change in temperature, change in visits).
        const pts = [];
        for (let i = 1; i < s14.days.length; i++) {
            const a = s14.days[i - 1], b = s14.days[i];
            const ta = s14.dayTemp.get(a.day), tb = s14.dayTemp.get(b.day);
            if (!ta || !tb || ta.n < 3 || tb.n < 3) continue;
            const dT = Math.round(tb.sum / tb.n) - Math.round(ta.sum / ta.n);
            const dV = b.n - a.n;
            if (dT === 0 || dV === 0) continue;         // on an axis, not in a quadrant
            pts.push({ day: b.day, x: dT, y: dV });
        }
        if (pts.length < 3) return null;

        // Small enough to read on a grid. Visits swing far more than
        // degrees do, so the y value is scaled to tens and the prompt
        // says so rather than quietly redefining the number.
        const usable = pts.map(p => ({ ...p, y: Math.round(p.y / 10) }))
                          .filter(p => Math.abs(p.x) <= 8 && Math.abs(p.y) <= 8 && p.y !== 0);
        if (!usable.length) return null;

        const pick = cmShuffle(usable, rng)[0];

        return {
            prompt: `On ${cmDayProse(pick.day)} it was ${Math.abs(pick.x)}° `
                  + `${pick.x > 0 ? 'warmer' : 'colder'} than the day before, and we had `
                  + `about ${Math.abs(pick.y)} ten${Math.abs(pick.y) === 1 ? '' : 's'} `
                  + `${pick.y > 0 ? 'more' : 'fewer'} visits. Plot that day as `
                  + `(${pick.x}, ${pick.y}).`,
            choices: [{ label: 'We plotted it correctly' }, { label: 'We needed another go' }],
            correct_index: 0,
            grid: {
                range: 8, target: { x: pick.x, y: pick.y },
                caption: 'Change from the day before',
                xLabel: 'degrees warmer →',
                yLabel: '↑ tens more visits',
            },
            explain: `(${pick.x}, ${pick.y}) — along first, then up or down. `
                   + `${pick.x < 0 ? 'A negative x goes LEFT of zero' : 'A positive x goes RIGHT of zero'} `
                   + `and ${pick.y < 0 ? 'a negative y goes DOWN' : 'a positive y goes UP'}, which puts `
                   + `it in quadrant ${pick.x > 0 && pick.y > 0 ? 'I'
                      : pick.x < 0 && pick.y > 0 ? 'II'
                      : pick.x < 0 ? 'III' : 'IV'}.`,
        };
    },
},

{
    // MA.6.DP.1.5 — "create box plots and histograms to represent sets of
    // numerical data". A histogram is bars over BINS, so the build
    // machinery already fits; what makes it a histogram rather than a bar
    // chart is that the class has to decide which bin each day falls in
    // before they can build anything.
    //
    // The raw numbers are listed in the prompt rather than pre-sorted into
    // the table, because sorting them IS the work. Every other build hands
    // the class a finished table; this one hands them a pile.
    id: 'build-histogram',
    category: 'analysis',
    title: 'Build the histogram',
    bands: ['6-8'],
    build({ s14 }) {
        const vals = s14.days.map(d => d.n).filter(n => n > 0);
        if (vals.length < 8) return null;

        const max = Math.max(...vals), min = Math.min(...vals);
        if (max - min < 4) return null;                 // nothing to bin

        const width = cmNiceStep(max - min);
        const bins = new Map();
        vals.forEach(v => {
            const b = Math.floor(v / width) * width;
            bins.set(b, (bins.get(b) || 0) + 1);
        });
        if (bins.size < 3 || bins.size > 6) return null;

        const series = [...bins.entries()].sort((a, b) => a[0] - b[0])
            .map(([b, n]) => ({ label: `${b}–${b + width - 1}`, value: n }));

        const spec = cmBuildSpec('Our histogram', series,
            { kind: 'bars', unit: 'day', maxPresses: 10, maxRows: 6 });
        if (!spec) return null;

        return {
            prompt: `Here are our daily visit counts: ${vals.join(', ')}. Sort them into `
                  + `the bins and build the histogram — each bar counts the DAYS that `
                  + `fell in that range.`,
            choices: [{ label: 'We built it correctly' }, { label: 'We needed another go' }],
            correct_index: 0,
            build: spec,
            explain: `Each bar counts days, not visits — that is the difference between a `
                   + `histogram and the bar chart of the week. The bins are `
                   + `${width} wide, so a day with ${vals[0]} visits goes in the `
                   + `${Math.floor(vals[0] / width) * width}–${
                     Math.floor(vals[0] / width) * width + width - 1} bin.`,
        };
    },
},

{
    // ELA.2.V.1.2 — base words and affixes. Bird vocabulary is unusually
    // honest material for this: a feeder really is a thing that feeds,
    // and a nestling really is a small thing in a nest, so the affix is
    // doing visible work rather than being a spelling rule.
    id: 'lang-base-words',
    category: 'language',
    title: 'Words inside words',
    bands: ['k-2'],
    needsData: false,
    build({ rng }) {
        const picks = [
            { word: 'FEEDER',   base: 'feed',  affix: '-er',
              means: 'a thing that feeds', also: 'teacher, baker, singer' },
            { word: 'NESTLING', base: 'nest',  affix: '-ling',
              means: 'a little one in the nest', also: 'duckling, gosling' },
            { word: 'SINGING',  base: 'sing',  affix: '-ing',
              means: 'doing it right now', also: 'flying, eating, looking' },
        ];
        const p = cmShuffle(picks, rng)[0];

        const built = cmChoices(p.base.toUpperCase(),
            picks.filter(x => x.base !== p.base).map(x => x.base.toUpperCase())
                 .concat(['BIRD']).slice(0, 3), rng);
        if (!built) return null;

        return {
            prompt: `Find the smaller word hiding inside ${p.word}.`,
            ...built,
            explain: `${p.base.toUpperCase()} + ${p.affix} = ${p.word} — `
                   + `${p.means}. The same ending turns up in ${p.also}, so once you `
                   + `can spot it you can work out words nobody has taught you.`,
        };
    },
},

{
    // SC.K.N.1.1 — "collaborate with a partner to collect information."
    //
    // ⚠ THIS IS AN ACTIVITY, AND THE QUESTION HAS TO BE HONEST ABOUT
    // THAT. It sat uncovered through three batches because there is no
    // multiple choice that makes a child collaborate. What there is: a
    // clip both partners watch, a count they each make ALONE, and then a
    // comparison — and the comparison is a real answer the class can
    // report, which is what makes this a question rather than an
    // instruction with a tick box after it.
    //
    // The information really is collected by the pair, which is the
    // benchmark. That it also lands on "two careful people can disagree"
    // is the same lesson SC.2.N.1.2 teaches three years later.
    id: 'partner-count',
    category: 'science',
    title: 'Count it with a partner',
    bands: ['k-2'],
    build({ s, rng }) {
        const clip = cmPickClip(s, rng);
        if (!clip) return null;

        const built = cmChoices('Watch it again together and count out loud',
            ['The one who counted more is right',
             'The one who finished first is right',
             'Stop counting and pick a number'], rng);
        if (!built) return null;

        return {
            prompt: 'Watch with your partner. Both of you count the birds on your own '
                  + '— no talking. Now compare. If your numbers are different, what '
                  + 'should you do?',
            ...built,
            clip: { url: clip.video_url, detection_id: clip.id },
            explain: 'Two people watching the same thing often count differently, and '
                   + 'that is not one of you being careless — it is why scientists '
                   + 'collect information together and check each other. Watching again '
                   + 'and counting out loud is what settles it.',
            detection_id: clip.id,
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
/**
 * The lesson you can build when the feeder has told you nothing.
 *
 * Only templates that declare `needsData: false` - they take a band and a
 * random seed and nothing else. Deliberately a separate, smaller function
 * rather than a flag threaded through the main one: the main path assumes a
 * summary exists and reads it in a dozen places, and making every one of
 * those tolerate null would be a much larger and much more fragile change
 * than having an honest second path for an honest second situation.
 */
function buildDataFreeQuestions(room, o) {
    const band = room.grade_band || 'k-2';
    const seed = `${room.id}|${cmDayKey(new Date())}|nodata`;
    cmChartRotation = 0;

    const picked = classroomPickSet(room, o.challenge);

    const out = [];
    for (const t of CLASSROOM_TEMPLATES) {
        if (t.needsData !== false) continue;
        if (!classroomTemplateAllowed(t, band, picked)) continue;
        let q = null;
        try {
            q = t.build({ s: CM_EMPTY_SUMMARY, s14: CM_EMPTY_SUMMARY, band,
                          rng: cmRng(seed + '|' + t.id), feeder: null,
                          source: null, room });
        } catch (e) {
            console.warn(`[classroom] data-free template "${t.id}" failed:`, e);
            continue;
        }
        if (!q || !q.choices || q.choices.length < 2) continue;
        if (t.guessFirst) q.guess_first = true;
        if (!q.about_bird) q.about_bird = q.wonder_bird || null;

        out.push({
            template_id: q.template_id || t.id,
            category: t.category, title: t.title, grade_band: band,
            scope: 'none', from_partner: false,
            ...q,
        });
    }

    // The teacher's own questions need no feeder data either, so a quiet
    // feeder is no reason to drop them — if anything it is when a class most
    // needs a question that is about something it did this week.
    // No source here — this is the data-free path, taken when the feeder
    // has nothing. A teacher's chart has nothing to draw either, so
    // cmOwnChart returns null and the question goes up without one.
    const own = cmOwnLessonQuestions(room, o, band, seed, null);
    const ordered = own.front.concat(
        cmShuffle(out.concat(own.pool), cmRng(seed + '|order')));
    const offered = CLASSROOM_TEMPLATES.filter(t =>
        classroomTemplateAllowed(t, band, picked)).length;
    return {
        questions: o.all ? ordered : ordered.slice(0, classroomQuizSize(room, o)),
        built: ordered.length,
        offered,
        no_data: true,
    };
}

// A summary shaped like a real one, holding nothing. Lets the data-free
// templates use the same helpers without each of them guarding for null.
const CM_EMPTY_SUMMARY = {
    feederId: null, name: null, isHome: true, rows: [], total: 0,
    species: [], bySpecies: new Map(), days: [], byDay: new Map(),
    byHour: new Array(24).fill(0), daySpec: new Map(), snapshots: [], clips: [],
    distinct: 0, avgTemp: null, tempCoverage: 0, dayTemp: new Map(),
    nonBird: 0, others: new Map(), byRarity: new Map(),
    isPool: false, feeders: [],
};

/**
 * How many questions this classroom's session asks.
 *
 * A class doing this every morning wants one or two; a class doing it once a
 * week wants six or eight. Both are the same product used differently, so the
 * number lives on the classroom rather than in a constant here.
 */
/**
 * Which templates this classroom is allowed to ask, as a Set — or null for
 * "all of them", which is the default and what every classroom had before
 * teachers could curate.
 *
 * A teacher covering telling-the-time this fortnight wants the clock question
 * every day; one who has not taught percentages yet wants them off the board.
 * Both are the same request: let me say which questions this room can ask.
 *
 * Empty and absent mean the same thing on purpose. A teacher who unticks the
 * last box has not asked for a lesson with no questions in it, and the server
 * collapses the two cases for the same reason — one case to handle, not two.
 */
function classroomPickSet(room, challenge) {
    // A live challenge OVERRIDES the class's own list rather than narrowing
    // it. Narrowing would give each class a different pool, which is the one
    // thing a challenge exists to stop, and a class whose curated list missed
    // the challenge's subject would get no questions at all.
    //
    // Safe because the band filter is separate: classroomTemplateAllowed
    // still asks whether the template exists for this class's grade band, so
    // a K-2 room in a challenge built from 6-8 questions gets the K-2 ones,
    // not an impossible lesson.
    const ch = challenge;
    if (ch && ch.question_mode === 'templates' && Array.isArray(ch.template_picks)
        && ch.template_picks.length) {
        return new Set(ch.template_picks);
    }
    if (ch && ch.question_mode === 'categories' && Array.isArray(ch.categories)
        && ch.categories.length) {
        const want = new Set(ch.categories);
        return new Set(CLASSROOM_TEMPLATES.filter(t => want.has(t.category)).map(t => t.id));
    }

    const picks = room && room.template_picks;
    if (!Array.isArray(picks) || !picks.length) return null;
    return new Set(picks);
}

/**
 * The challenge a class is in right now, or null.
 *
 * Null on ANY failure, including a site that has not had the migration
 * applied. A lesson must never fail to start because the scoreboard had
 * nothing to say, and "no challenge today" is the ordinary case rather than
 * an error worth showing a teacher in front of a room.
 */
async function classroomActiveChallenge(roomId) {
    const { data, error } = await sbRpc('classroom_active_challenge',
        { p_classroom_id: roomId }, true);
    if (error || !data) return null;
    return data;
}

/**
 * Is this template allowed in this room, in this band?
 *
 * The band test is not redundant with the picker: a teacher curates a list,
 * then moves the class up a grade band, and the half of their list that does
 * not exist in the new band must drop out quietly rather than producing
 * nothing. Picks are a filter ON TOP of what the band offers, never instead.
 */
function classroomTemplateAllowed(t, band, picked) {
    return t.bands.includes(band) && (!picked || picked.has(t.id));
}

function classroomQuizSize(room, o) {
    const n = Number((o && o.limit) || (room && room.questions_per_session));
    return Number.isFinite(n) && n >= 1 && n <= 20
        ? Math.round(n)
        : CLASSROOM_QUESTIONS_PER_SESSION;
}

// ── Questions a teacher writes for their own class ───────────
//
// Until these existed a teacher could only SUGGEST a question, and the
// suggestion waited in the digest for somebody to turn it into a template.
// That is still the path for a question every class should get. It is the
// wrong path for "we read about owls this morning — ask them which bird
// hunts at night", which is for one class, this week, and should not wait
// on anybody. setup-classroom-teacher-questions.sql has the server side.

/**
 * This classroom's own questions, with their photos ready to show.
 *
 * Never fatal. A database without the migration, or a network hiccup,
 * means a lesson made of the usual questions — not no lesson.
 */
async function loadClassroomOwnQuestions(roomId) {
    const { data, error } = await sbRpc('classroom_teacher_questions_list',
        { p_classroom_id: roomId }, true);
    if (error || !Array.isArray(data)) return [];
    // A private school feeder's photo arrives as a private:// marker, exactly
    // like the lesson's other snapshots, and needs the same signing before it
    // can go in an <img>.
    if (typeof signPrivateMedia === 'function') {
        try { await signPrivateMedia(data); } catch { /* shown unsigned, or not at all */ }
    }
    return data;
}

/**
 * Turn a classroom's switched-on questions into lesson questions, split into
 * the ones that go to the FRONT of the lesson and the ones that take their
 * turn with everything else.
 *
 * The rule a teacher can predict: a question they have just written comes
 * up in the next lesson. After that it is a question like any other — the
 * recent-repeat logic sends it to the back for a fortnight, so a class does
 * not meet "which bird hunts at night?" every morning until somebody
 * remembers to switch it off.
 *
 * The front is capped at half the lesson. A teacher who writes eight
 * questions on a Sunday gets a lesson that is still mostly about the
 * feeder; the rest wait their turn in the pool rather than being lost.
 *
 * Left out entirely while a school challenge is running. A challenge is a
 * scoreboard across classes, and a class answering its own teacher's
 * questions is not playing the same game as the class next door.
 */
/**
 * The chart a teacher asked their question to carry.
 *
 * ⚠ THE SPEC IS STORED; THE NUMBERS ARE NOT. A question saved in October
 * that kept its October bar chart would be showing a class last term's
 * week — the chart is evidence for a question about THIS week, so the
 * spec says which shape over which series and the data is whatever the
 * feeder holds when the lesson runs.
 *
 * Null whenever the source has nothing to draw, which is an ordinary
 * outcome: the question still works, it simply has no chart beside it.
 */
function cmOwnChart(spec, source, band) {
    if (!spec || !spec.kind || !source) return null;

    const s = cmWindow(source, 7);
    let series = null, caption = '';
    if (spec.source === 'days') {
        series = cmDaySeries(s);
        caption = 'Visits each day this week';
    } else if (spec.source === 'species') {
        series = cmSpeciesSeries(s, 6);
        caption = 'Visits by species this week';
    } else if (spec.source === 'hours') {
        series = s.byHour.map((n, h) => ({ label: fmtHourShort(h), value: n, key: String(h) }))
                         .filter(r => r.value > 0)
                         .slice(0, CHART_MAX_HOURS);
        caption = 'When the birds came';
    }
    if (!series || series.length < 2) return null;

    if (spec.kind === 'picto') {
        return cmPictograph(caption, series, { band });
    }

    const chart = cmChart(caption, series, {
        band, kind: spec.kind,
        ordered: spec.source === 'days' || spec.source === 'hours',
        hours:   spec.source === 'hours',
    });

    // ⚠ cmChart SUBSTITUTES RATHER THAN REFUSES. Asked for a shape the
    // data cannot carry — a line across species, a circle of twenty-four
    // hours — it quietly returns a different one, which is right inside a
    // lesson and wrong here: a teacher who picks Line and is handed bars
    // has been ignored without being told. Reported as exactly that, with
    // five combinations named.
    //
    // So a teacher's explicit choice is honoured or refused, never
    // swapped. cmOwnChartWhyNot turns the refusal into a sentence.
    if (!chart || chart.kind !== spec.kind) return null;
    return chart;
}

/**
 * Why a shape cannot be drawn over this data, in words a teacher can act
 * on. Null when it can.
 *
 * These are the same rules CHART_KINDS_OK enforces, said out loud. They
 * are duplicated deliberately: that table answers "may I?" in a boolean,
 * and a dropdown needs "why not, and what should I pick instead?".
 */
function cmOwnChartWhyNot(kind, source, band) {
    if (!kind) return null;

    if (kind === 'line' && source === 'species') {
        return 'A line says the things along the bottom run in order and that the gaps '
             + 'between them mean something. Species have no order, so a line would draw '
             + 'a trend that does not exist. Try days or hours — or bars for species.';
    }
    if (kind === 'donut' && source !== 'species') {
        return 'A circle shows how a whole splits up, which needs a handful of slices — '
             + 'seven days or twenty-four hours are too many to tell apart. Circles work '
             + 'over species.';
    }
    if (kind === 'dots' && band !== 'k-2') {
        return 'A tally draws one mark per visit, which only stays countable for K–2 '
             + 'numbers. For this grade band try bars, or a picture graph with a key.';
    }
    if (kind === 'dots' && source !== 'days') {
        return 'A tally draws one mark per visit, so it needs short rows. Species and '
             + 'hours run too long to count. Try it over days, or use bars.';
    }
    return null;
}

/**
 * Why THIS WEEK'S numbers defeated a shape that is otherwise legal.
 *
 * ⚠ "NOT ENOUGH DATA" IS NOT ALWAYS THE REASON, and saying it when the
 * opposite is true sends a teacher looking for more birds. A tally draws
 * one mark per visit: on a feeder taking thirty-five visits a day it
 * fails because there are too MANY, and the fix is a picture graph with
 * a key rather than waiting a week.
 */
function cmOwnChartDataWhyNot(spec, source) {
    const thin = 'Your feeders have not recorded enough this week to draw that one. '
               + 'The question still works — it just goes up without a chart until '
               + 'there is more data.';
    if (!spec || !source) return thin;

    if (spec.kind === 'dots') {
        const s = cmWindow(source, 7);
        const vals = spec.source === 'species' ? s.species.map(x => x.n)
                   : spec.source === 'hours'   ? s.byHour.filter(n => n > 0)
                   : s.days.map(d => d.n);
        if (vals.length && Math.max(...vals) > DOTS_MAX_VALUE) {
            return 'There are too many visits this week to draw one mark each — the rows '
                 + 'would run off the board. A picture graph with a key counts the same '
                 + 'data in a few symbols.';
        }
    }
    return thin;
}

/**
 * The sources a given shape can honestly be drawn over.
 *
 * Used to rebuild the second dropdown when the first changes, so a
 * teacher cannot pick a pair that will not draw.
 */
function cmOwnChartSources(kind, band) {
    return ['days', 'species', 'hours']
        .filter(src => !cmOwnChartWhyNot(kind, src, band));
}

// Short hour label for a teacher's hour chart. cmChart's own clock path
// wants real hours; this is just an axis label.
function fmtHourShort(h) {
    if (h === 0)  return '12a';
    if (h === 12) return '12p';
    return h < 12 ? h + 'a' : (h - 12) + 'p';
}

function cmOwnLessonQuestions(room, o, band, seed, source) {
    const none = { front: [], pool: [] };
    if (o.challenge) return none;

    const own = (Array.isArray(o.own) ? o.own : []).filter(x =>
        x && x.active && Array.isArray(x.choices) && x.choices.length >= 2
          && x.correct_index != null && x.choices[x.correct_index] != null);
    if (!own.length) return none;

    const qs = own.map(x => {
        const right = String(x.choices[x.correct_index]);
        // Shuffled like every other question. A teacher types the right
        // answer first more often than not, and "it's always A" is a pattern
        // a class finds by the third question.
        const built = cmChoices(right,
            x.choices.filter((_, i) => i !== x.correct_index).map(String),
            cmRng(seed + '|own|' + x.id));
        if (!built) return null;
        return {
            template_id: 'teacher:' + x.id,
            // The teacher's own subject when they picked one. It drives the
            // pill on the review card and the grouping in the picker, so a
            // science question they wrote reads as science rather than as
            // the catch-all "teacher".
            category: x.category || 'teacher',
            title: x.owned === false ? 'A shared question' : 'Your question',
            grade_band: band, scope: 'none', from_partner: false,
            prompt: x.prompt,
            ...built,
            explain: x.explain || null,
            image: x.image_url ? { url: x.image_url, detection_id: x.detection_id } : null,
            detection_id: x.detection_id || null,
            // A clip the teacher chose. Same shape the template clips use,
            // so classroomClipHtml needs no special case.
            video: x.video_url
                ? { url: x.video_url, detection_id: x.clip_detection_id } : null,
            // A chart over the class's own data, built here rather than
            // stored: the spec says which shape over which series, and the
            // numbers are whatever this week actually holds.
            chart: cmOwnChart(x.chart_spec, source, band),
            // The feeder burns the species name into the bottom of every
            // snapshot. A teacher asking "who is this?" over their own photo
            // would be handing out the answer, so the caption is cropped
            // until the reveal, as it is on the identification questions.
            crop_caption: true,
            // The benchmarks the teacher tagged it with, carried onto the
            // question so the coverage report counts it like any other.
            // Without this a lesson's report silently omits whatever the
            // teacher wrote themselves, which under-sells the lesson.
            standards: Array.isArray(x.standards) ? x.standards : [],
            // The "read more" button on the reveal, when the right answer is a
            // bird this file knows — the same rule the templates use.
            about_bird: SPECIES_LOOKS[right] ? right : null,
            own: true,
            // Whose it is. Without this an adopted question wore a "your
            // question" pill in the owning teacher's own review screen,
            // which is exactly backwards.
            owned: x.owned !== false,
        };
    }).filter(Boolean);

    const recent = new Set(Array.isArray(o.recent) ? o.recent : []);
    const fresh = qs.filter(q => !recent.has(q.template_id));
    const seen  = qs.filter(q =>  recent.has(q.template_id));
    const cap   = Math.max(1, Math.floor(classroomQuizSize(room, o) / 2));
    return { front: fresh.slice(0, cap), pool: fresh.slice(cap).concat(seen) };
}

function buildClassroomQuestions(room, data, opts) {
    const o = opts || {};
    const source = cmPickSource(data);

    // A feeder with nothing on it used to mean no lesson at all: the function
    // gave up here and the stage said "not enough data yet". That was true
    // when every question was computed from detections. It is not true now -
    // the fact slides, the color and language questions and the state-bird
    // map need no feeder data whatsoever, and a new feeder that birds have
    // not found yet is EXACTLY when a class needs them.
    //
    // Roland Park is the case in point: a courtyard feeder with five
    // detections in a fortnight, about to be shown to four teachers.
    if (!source || !source.total) {
        return { ...buildDataFreeQuestions(room, o), source: null };
    }

    const s    = cmWindow(source, 7);
    const s14  = source;
    const band = room.grade_band || 'k-2';
    const seed = `${room.id}|${cmDayKey(new Date())}|${source.feederId}`;

    // Same lesson, same charts, whether this is the review pass or the class.
    cmChartRotation = 0;
    const feeder = source.name;

    const picked = classroomPickSet(room, o.challenge);

    const out = [];
    for (const t of CLASSROOM_TEMPLATES) {
        if (!classroomTemplateAllowed(t, band, picked)) continue;
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

        // Show the values on the chart unless they ARE the answer.
        //
        // Three separate flags said the same thing: "each bar should have the
        // total on top", "vertical axis values need to be added", "charts
        // need to be easy to see values". The original rule - hide until the
        // reveal, so reading the chart is the exercise - is right for exactly
        // one case and wrong everywhere else. Asking a class to estimate a
        // bar against a gridline turns a question about birds into a question
        // about eyesight, and when two days are close it has no answer at all.
        //
        // So the numbers go on, except where a choice IS one of the plotted
        // values, which is the case where printing them answers the question.
        if (q.chart && !q.chart.showValues) {
            // `plotted` is what the chart SHOWS, which is not always the
            // underlying value. A pictograph rounds to the nearest half
            // symbol: the row holds 46 but the picture says 45, and the
            // question's answer is "about 45". Comparing the choices
            // against 46 found no match, concluded that printing the
            // numbers was safe, and would have printed 46 beside a row
            // whose correct answer was 45.
            const plotted = new Set((q.chart.plotted || q.chart.series)
                                        .map(r => String(r.value)));
            // Except on a clock, whose answers are TIMES. "7 o'clock" carries a
            // 7 that is an hour, not a count, so matching it against the
            // plotted counts was a coincidence detector — and a busy hour of
            // 3 to 12 visits makes the coincidence routine. Measured at four
            // weeks in six. Each one sent the clock down the branch below and
            // replaced it with bars, so a K-2 class was told "Look at the
            // clock — what time is it?" with no clock on the board, and the
            // 3–5 reveal-only hands never drew. Printing the counts does not
            // name the hour; finding it on the dial is still the question.
            const givesItAway = q.chart.kind !== 'clock' && (q.choices || []).some(c =>
                (String(c.label).match(/\d+/g) || []).some(num => plotted.has(num)));
            if (!givesItAway) {
                q.chart.showValues = true;
            } else if (!CHART_KINDS_READABLE.has(q.chart.kind)) {
                // The numbers are staying hidden because printing them would
                // answer the question — which means the DRAWING is now the
                // only way to answer it, and some shapes cannot be read that
                // precisely. A donut has no scale; a clock's blobs encode
                // size, not an exact count.
                //
                // This is how "how many Northern Cardinals came this week?"
                // reached a class with no way to answer it: the kind rotation
                // handed that question a chart with no axis, and the rotation
                // runs on how many charts the lesson has drawn so far, so it
                // only bites in a full lesson and never in a one-question
                // test. Bars always carry a labelled, gridded scale.
                q.chart.kind = 'bars';
            }
        }

        if (t.guessFirst) q.guess_first = true;

        // Which bird this question is ABOUT, for the "read more" button on
        // the reveal. A fact slide names its bird; everything else is about
        // the bird in its answer, where that answer is a species we know.
        if (!q.about_bird) {
            const answer = (q.correct_index != null && q.choices && q.choices[q.correct_index])
                ? String(q.choices[q.correct_index].label) : '';
            q.about_bird = q.wonder_bird || (SPECIES_LOOKS[answer] ? answer : null);
        }

        out.push({
            template_id: t.id,
            category:    t.category,
            title:       t.title,
            grade_band:  band,
            scope:       source.isPool ? 'community'
                       : source.isHome ? 'home' : 'partner',
            source_feeder_id:   source.feederId,
            source_feeder_name: source.name,
            // A pooled lesson is not "from a partner" — there is no single
            // other feeder to name, and the amber badge that phrase drives
            // would be pointing at nothing.
            from_partner: !source.isHome && !source.isPool,
            ...q,
        });
    }

    // The teacher's own: the new ones go straight after the opening
    // identification question; the rest join the pool, where the recent-repeat
    // ordering below treats them exactly like any template.
    const own = cmOwnLessonQuestions(room, o, band, seed, source);

    const rng = cmRng(seed + '|order');
    const ident = out.filter(q => q.category === 'identification');
    let   rest  = cmShuffle(out.filter(q => q.category !== 'identification')
                               .concat(own.pool), rng);

    // A class running this daily meets the whole set in a fortnight, and the
    // second time it meets Tuesday's question on Wednesday it has worked out
    // that the lesson is on rails. So anything this classroom has been asked
    // recently goes to the BACK rather than being dropped: with a thin week
    // of data there may not be enough questions to fill a session otherwise,
    // and a repeat is better than a short lesson. Least recently asked first
    // among the repeats.
    const recent = Array.isArray(o.recent) ? o.recent : [];
    if (recent.length) {
        const rank = new Map(recent.map((id, i) => [id, i]));
        const fresh = rest.filter(q => !rank.has(q.template_id));
        const seen  = rest.filter(q =>  rank.has(q.template_id))
                          .sort((a, b) => rank.get(b.template_id) - rank.get(a.template_id));
        rest = fresh.concat(seen);
    }

    const ordered = ident.concat(own.front, rest);

    // How many templates this band HAS, against how many could say anything
    // about this week. The gap is the useful number: a band that offers forty
    // questions and builds six of them is short of data, not short of
    // templates, and those are opposite problems with opposite fixes.
    const offered = CLASSROOM_TEMPLATES.filter(t =>
        classroomTemplateAllowed(t, band, picked)).length;

    return {
        // Reviewing is not teaching. A lesson is deliberately a handful of
        // questions; a review pass is for seeing everything the band can
        // currently produce, which is the only way to judge the set as a set
        // or to give feedback on a question a lesson happened not to pick.
        questions: o.all ? ordered
                         : ordered.slice(0, classroomQuizSize(room, o)),
        built:   ordered.length,
        offered,
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

/**
 * Escape closes the panel, as it does everywhere else on this page.
 *
 * Three guards, each for a real case:
 *
 *  - A lesson on the stage has its OWN Escape, which ends the session. The
 *    stage sits above the panel, so Escape must reach one of them and not
 *    both; the one in front wins.
 *  - Typing in a field is not a request to throw the field away. Somebody
 *    half way through naming a class and reaching for Escape to clear the
 *    input should not lose the form.
 *  - A confirm() is modal to the browser and Escape is its own cancel.
 */
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('classroom-panel-modal');
    if (!modal || !modal.classList.contains('open')) return;

    const stage = document.getElementById('classroom-stage');
    if (stage && getComputedStyle(stage).display !== 'none') return;

    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.target.isContentEditable) return;

    closeClassroomPanel();
});

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
    await loadClassroomSchoolStatus();

    renderClassroomTerm();

    // "Classes 3 of 5" where there is a limit. The reasons a new class can be
    // refused — a lapsed term, a full plan — now live on the New class row
    // itself, rendered by renderClassroomList, so there is one place that
    // decides rather than a button here and a row there.
    const rooms = classroomSchool && classroomSchool.classrooms;
    const title = document.getElementById('classroom-pane-title');
    if (title) {
        title.textContent = (rooms && rooms.limit)
            ? `Classes ${rooms.used} of ${rooms.limit}`
            : 'Classes';
    }

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

// ── The school subscription ──────────────────────────────────────
//
// School mode is a dated term. When it runs out the community stays a school
// — kind is never flipped back, or every teacher would be demoted to viewer
// and the term's results would be stranded behind an empty panel — but new
// lessons and new classes stop. Everything already recorded stays readable.
//
// Shape: { state, can_start, expires_at, days_left, perpetual, is_owner }
// where state is not_school | perpetual | active | grace | lapsed.

let classroomSchool = null;

/**
 * Load the current community's term.
 *
 * FAILS OPEN, deliberately and in one specific case: a database that has not
 * had setup-school-subscription.sql run against it has no
 * community_school_status, and PostgREST answers that with PGRST202. This
 * file ships to GitHub Pages the moment it is pushed, while the SQL is pasted
 * into Supabase by hand some minutes later — so for that window every school
 * in the world would otherwise be told its subscription had lapsed, and the
 * start buttons would go gray on a database that has no subscriptions in it
 * at all. Treat "the feature does not exist here" as "nothing to enforce".
 *
 * Any OTHER error leaves the status null, which renders no banner and gates
 * nothing. A network blip must not cancel a lesson either; the server-side
 * triggers are what actually enforce the term, and they cannot be reached
 * from here.
 */
async function loadClassroomSchoolStatus() {
    classroomSchool = null;
    if (!classroomCommunityId) return;

    const { data, error } = await sbRpc('community_school_status',
        { p_community_id: classroomCommunityId }, true);

    if (error) {
        const missing = error.code === 'PGRST202'
            || /could not find the function|does not exist/i.test(error.message || '');
        if (missing) classroomSchool = { state: 'perpetual', can_start: true };
        return;
    }
    if (data && typeof data === 'object') classroomSchool = data;
}

// Can this community start lessons right now? Unknown counts as yes — see
// loadClassroomSchoolStatus. The database has the final word regardless.
function classroomTermBlocks() {
    return !!(classroomSchool && classroomSchool.can_start === false);
}

/**
 * The banner above both panes, or nothing at all.
 *
 * Only speaks up when there is something to act on: lapsed, or inside the
 * grace window. A school with nine months left does not need to be told about
 * its subscription every time it opens the panel.
 */
function renderClassroomTerm() {
    const box = document.getElementById('classroom-term-banner');
    if (!box) return;

    const s = classroomSchool;
    const show = s && (s.state === 'lapsed' || s.state === 'grace');
    box.style.display = show ? '' : 'none';
    // Reset the tone class too, not just the text. A hidden banner that still
    // says .lapsed is a trap for whatever unhides it next.
    if (!show) { box.className = 'classroom-term'; box.innerHTML = ''; return; }

    // The owner is told where the box is; everybody else is told who to ask,
    // because the renewal control is not on their screen and hunting for a
    // setting that is not there is worse than being redirected.
    const where = s.is_owner
        ? 'Enter a renewal code under Manage community → settings.'
        : 'Ask whoever owns this community to renew it.';

    if (s.state === 'grace') {
        const ends = s.grace_ends_at
            ? new Date(s.grace_ends_at).toLocaleDateString(undefined,
                { month: 'long', day: 'numeric' })
            : null;
        box.className = 'classroom-term grace';
        box.innerHTML = '<strong>This school&rsquo;s subscription has ended.</strong> '
            + 'Lessons keep working'
            + (ends ? ` until ${esc(ends)}` : ' for now')
            + `. ${esc(where)}`;
        return;
    }

    box.className = 'classroom-term lapsed';
    box.innerHTML = '<strong>This school&rsquo;s subscription has ended.</strong> '
        + 'New lessons and new classes are paused. Results and history are '
        + 'still here, and nothing has been deleted. '
        + esc(where);
}

// Which class the right-hand pane is acting on.
//
// ONE selection, held here. There used to be two ways to choose a class — a
// dropdown above the list, and the list itself — plus a show-all toggle to
// reconcile them, which is what made a dropdown naming "3-5" sit above all
// three classrooms and read as a filter that did not work. The list is now
// the only selector, so the state it reflects has to live somewhere other
// than inside a <select> that no longer exists.
let classroomSelectedId = null;

function classroomPicked() {
    // Defaults to the first class, so the right-hand pane is never blank
    // when there is something it could be showing.
    if (classroomSelectedId && classroomList.some(r => r.id === classroomSelectedId)) {
        return classroomSelectedId;
    }
    return classroomList.length ? classroomList[0].id : null;
}

/**
 * Choose a class. Everything on the right follows from this.
 *
 * Closing the review and results panels matters: they are rendered for a
 * specific class, and leaving last class's results on screen beside the new
 * class's name is a quietly wrong answer rather than an obviously missing
 * one.
 */
// ── One column of things you can click ───────────────────────────
//
// The left column used to list only classes, and the school-wide actions sat
// in a footer under everything else — far enough down that they were below
// the fold on a laptop and simply never found.
//
// Now every clickable thing in the panel is in the one column, in the one
// visual language, and the right-hand side is always "whatever is selected
// on the left". Nothing is hidden under a scroll, and the association between
// what you pressed and what you are looking at is a highlight rather than a
// thing to remember.
//
// Classes stay a separate group from school actions. They are different in
// kind — one acts on a class, the other on the school — and the panel's whole
// logic is that distinction. Merging them into a flat list would save a
// heading and lose the point.
//
// kind: 'class' | 'new' | 'challenge' | 'feedback' | 'suggest'
let classroomLeftPick = { kind: 'class' };

function classroomPickIs(kind, id) {
    if (classroomLeftPick.kind !== kind) return false;
    return kind !== 'class' || id === classroomPicked();
}

function selectClassroom(id) {
    classroomLeftPick = { kind: 'class' };
    classroomSelectedId = id;
    hideClassroomReview();
    hideClassroomHistory();
    classroomEditingId = null;
    classroomFormOpen = false;
    renderClassroomList();
    renderClassroomActions();
    renderClassroomForm();
}

/**
 * A school-wide action, picked from the same column as the classes.
 *
 * The class action panel is hidden rather than left underneath: two things
 * on the right at once is exactly the confusion this layout exists to end.
 */
function pickClassroomAction(kind) {
    classroomLeftPick = { kind };
    classroomEditingId = null;
    classroomFormOpen = (kind === 'new');
    hideClassroomReview();
    hideClassroomHistory();
    renderClassroomList();
    renderClassroomActions();
    renderClassroomForm();

    if (kind === 'challenge') showClassroomChallenge();
    if (kind === 'feedback')  showClassroomFeedback();
    if (kind === 'suggest')   openClassroomSuggest();
}

// The form is a MODE, not furniture. It used to sit at the bottom of the
// panel permanently, which is part of what made the panel look like it was
// doing several things at once: a page about running today's lesson with a
// half-filled "New classroom" form underneath it at all times.
let classroomFormOpen = false;

// Kept as a name because other code calls it; the behaviour is now just
// "pick the New class row", so there is one path into the form.
function newClassroom() {
    pickClassroomAction('new');
    document.getElementById('classroom-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderClassroomList() {
    const list = document.getElementById('classroom-list');
    if (!list) return;

    const picked = classroomPicked();

    // The school-wide actions, in the same column and the same language as
    // the classes. "+ New class" lives here too: it is a thing you pick that
    // fills the right-hand side, exactly like picking a class is.
    // Everyone who can open this panel is staff, and the model is the same
    // for all of them — one column, one selection. What differs is which
    // rows are in it, and that follows what the SERVER will actually allow,
    // so nobody is offered a button that answers with a permission error.
    //
    //   New class        teacher, moderator, owner  (classroom_create)
    //   School challenge everyone can read the board; only owner and
    //                    moderator get the controls, inside the panel
    //   Suggest          teacher, moderator, owner  (classroom_suggest_question)
    //   Question feedback everyone, since teachers were given read access
    //
    // Two states can block a new class even where the role allows it: the
    // term has lapsed, or the plan's class limit is used up. Both say so on
    // the row rather than letting somebody fill in a form and lose it.
    const rooms   = classroomSchool && classroomSchool.classrooms;
    const full    = !!(rooms && rooms.room === false);
    const lapsed  = classroomTermBlocks();
    const newWhy  = lapsed ? 'This school’s subscription has ended'
                  : full   ? `This school’s plan covers ${rooms.limit} `
                           + `class${rooms.limit === 1 ? '' : 'es'} — archive one, or upgrade`
                  : '';

    const schoolRows = [
        { kind: 'new',       icon: '✚',  label: 'New class',
          meta: newWhy || 'Name it, pick its feeder and grade',
          disabled: !!newWhy },
        { kind: 'challenge', icon: '🏆', label: 'School challenge',
          meta: classroomCanAssign() ? 'Set a week and compare every class'
                                     : 'How the classes compare this week' },
        { kind: 'suggest',   icon: '💡', label: 'Suggest a question',
          meta: 'An idea for the question bank' },
        { kind: 'feedback',  icon: '💬', label: 'Question feedback',
          meta: classroomCanAssign() ? 'What teachers have flagged'
                                     : 'What has been flagged, and what was done' },
    ].map(a => `
        <button type="button" class="classroom-row classroom-row-act${
                classroomPickIs(a.kind) ? ' on' : ''}"${a.disabled ? ' disabled' : ''}
                ${a.disabled ? `title="${esc(a.meta)}"` : ''}
                onclick="pickClassroomAction('${a.kind}')">
            <span class="classroom-row-name">${a.icon} ${esc(a.label)}</span>
            <span class="classroom-row-meta">${esc(a.meta)}</span>
        </button>`).join('');

    const schoolGroup = `
        <div class="classroom-pane-subtitle">Across the whole school</div>
        ${schoolRows}`;

    if (!classroomList.length) {
        list.innerHTML = '<div class="classroom-muted">No classes yet — start with '
                       + '<strong>New class</strong> below. It takes a name, the feeder '
                       + 'your class watches, and a grade band.</div>'
                       + schoolGroup;
        renderClassroomActions();
        return;
    }

    // Every class, always. The list is short, it is the only selector, and
    // hiding the others behind a toggle was what made choosing one confusing.
    list.innerHTML = classroomList.map(r => {
        const seen = r.home_feeder_seen_at
            ? new Date(r.home_feeder_seen_at).getTime() > Date.now() - 10 * 60 * 1000
            : false;
        // A pooled class is not missing a feeder, so it must not be scolded
        // for having none — "No feeder" in amber is a prompt to go and fix
        // something, and here there is nothing to fix.
        const feeder = r.question_scope === 'community'
            ? 'All community feeders'
            : r.home_feeder_id
            ? `<span class="classroom-dot ${seen ? 'on' : 'off'}"></span>${esc(r.home_feeder_name || 'Feeder')}`
            : '<span class="classroom-warn">No feeder</span>';

        return `
        <button type="button" class="classroom-row${
                classroomPickIs('class', r.id) && r.id === picked ? ' on' : ''}"
                data-room="${esc(r.id)}" onclick="selectClassroom('${escJs(r.id)}')">
            <span class="classroom-row-name">${esc(r.name)}</span>
            <span class="classroom-row-meta">
                ${esc(GRADE_BAND_LABELS[r.grade_band] || r.grade_band)} · ${feeder}
            </span>
        </button>`;
    }).join('') + schoolGroup;

    renderClassroomActions();
}

/**
 * The right-hand pane: everything you can do to the class on the left.
 *
 * Grouped by WHEN rather than by what the code calls them. Starting a lesson
 * is the thing you came to do and is at the top, in the two modes the design
 * notes describe. Review and Results are between-lessons work. Edit, Link and
 * Delete are touched a few times a year and sit last, quietly — they used to
 * hide behind a "⋯" on every card, which is a lot of machinery for three
 * buttons that now have room to simply exist.
 */
function renderClassroomActions() {
    const box = document.getElementById('classroom-actions');
    if (!box) return;

    // Only a class fills this pane. When a school action is picked the right
    // side belongs to that instead — two things on the right at once is the
    // confusion this layout exists to remove.
    if (classroomLeftPick.kind !== 'class') { box.innerHTML = ''; return; }

    const id = classroomPicked();
    const r  = id ? classroomList.find(x => x.id === id) : null;
    if (!r) {
        box.innerHTML = classroomList.length
            ? '<div class="classroom-muted">Pick a class on the left.</div>'
            : '<div class="classroom-muted">Once there is a class, everything you can '
            + 'do with it appears here — start a lesson, look over the questions '
            + 'first, and read how it went afterwards.</div>';
        return;
    }

    const partners = (r.partners || []).map(p => p.display_name).filter(Boolean);
    const seen = r.home_feeder_seen_at
        ? new Date(r.home_feeder_seen_at).getTime() > Date.now() - 10 * 60 * 1000
        : false;
    // Disabled with a reason, rather than absent: "why can I not start?" is a
    // worse question to be left with than "set a home feeder first".
    //
    // Two separate reasons a lesson cannot start, and they need separate
    // messages: no feeder is something this teacher can fix in the next
    // thirty seconds, while a lapsed subscription is somebody else's
    // purchase order. The term is checked first because it is the one the
    // teacher cannot do anything about.
    const noStart = classroomTermBlocks()
        ? ' disabled title="This school’s subscription has ended"'
        : (r.home_feeder_id ? '' : ' disabled title="Set a home feeder first"');

    box.innerHTML = `
        <div class="classroom-actions-head">
            <h4 class="classroom-h">${esc(r.name)}</h4>
            <span class="classroom-pill">${esc(GRADE_BAND_LABELS[r.grade_band] || r.grade_band)}</span>
        </div>
        <div class="classroom-card-meta">
            ${r.home_feeder_id
                ? `<span class="classroom-dot ${seen ? 'on' : 'off'}"></span>${esc(r.home_feeder_name || 'Feeder')}`
                + (seen ? '' : ' <span class="classroom-muted">(quiet)</span>')
                : '<span class="classroom-warn">No home feeder set</span>'}
            ${partners.length ? ` · partners: ${esc(partners.join(', '))}` : ''}
            · ${r.questions_per_session || 8} question${(r.questions_per_session || 8) === 1 ? '' : 's'} a session
            ${r.is_mine ? '' : ` · taught by ${esc(r.teacher_label)}`}
        </div>

        <div class="classroom-group">
            <div class="classroom-group-title">Start a lesson</div>
            <div class="classroom-group-row">
                <button class="classroom-btn-primary"
                        onclick="startClassroomSession('${escJs(r.id)}','teacher_led')"${noStart}>▶ On the board</button>
                <button class="classroom-btn-primary"
                        onclick="startClassroomSession('${escJs(r.id)}','join_code')"${noStart}>📱 With devices</button>
            </div>
        </div>

        <div class="classroom-group">
            <div class="classroom-group-title">Between lessons</div>
            <div class="classroom-group-row">
                <button class="classroom-btn" onclick="reviewClassroomQuestions('${escJs(r.id)}')">🔍 Review questions</button>
                <button class="classroom-btn" onclick="showClassroomHistory('${escJs(r.id)}')">📊 Previous lessons</button>
                <!-- ⚠ THE VERB IS ON THE BUTTON, deliberately. It said "My
                     questions", and a teacher reported: "it was not obvious
                     to me that in order to create a new question I had to
                     press the 'my questions' button." Quite right — that
                     label names a place, and somebody looking for a way to
                     WRITE one has no reason to think it is behind it.
                     Straight to the empty form when there are none yet,
                     because on a class with no questions the list is a page
                     saying "None yet" with the real action one more press
                     away. -->
                <button class="classroom-btn" onclick="writeClassroomQuestion('${escJs(r.id)}')"
                        title="Write your own questions for this class, and see the ones you have">
                    ✍️ Write a question</button>
            </div>
        </div>

        <div class="classroom-group">
            <div class="classroom-group-title">Settings</div>
            <div class="classroom-group-row">
                <button class="classroom-btn" onclick="editClassroom('${escJs(r.id)}')">✏️ Edit</button>
                <button class="classroom-btn" onclick="copyClassroomLink('${escJs(r.id)}')"
                        title="A link that opens straight into this class">🔗 Link</button>
                <button class="classroom-btn-danger" onclick="deleteClassroom('${escJs(r.id)}')">🗑 Delete</button>
            </div>
        </div>

        <div class="classroom-pending" id="classroom-pending-${esc(r.id)}"></div>`;
}

// ── "My questions": writing a class its own questions ────────────
//
// Lives in the right-hand pane like Review and Previous lessons, because
// it is something done to ONE class between lessons. The list is the
// resting state; writing or editing a question replaces it with the form,
// and saving goes back to the list — one thing on the right at a time.
//
// State is kept here rather than re-read on every click: the list is a
// handful of rows, and a teacher switching three questions off should not
// watch the pane reload three times.

let classroomOwn = { roomId: null, items: [], editing: null, photos: null, photo: null };

/**
 * The door a teacher looking to write a question will actually try.
 *
 * Goes to the list when the class already has questions — they will want
 * to see them — and straight to a blank form when it has none, because
 * an empty list is a dead end with the real action behind another press.
 */
async function writeClassroomQuestion(roomId) {
    await showClassroomOwnQuestions(roomId);
    if (classroomOwn.roomId === roomId && !(classroomOwn.items || []).length) {
        openClassroomOwnForm(null);
    }
}

async function showClassroomOwnQuestions(roomId) {
    const room = classroomList.find(r => r.id === roomId);
    const box = document.getElementById('classroom-review');
    if (!room || !box) return;

    hideClassroomReview();
    hideClassroomHistory();
    closeClassroomForm();
    renderClassroomList();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading this class’s questions…</div>';

    // Read directly rather than through loadClassroomOwnQuestions, because
    // here a failure has to be SAID: an empty list on the one screen whose
    // job is showing the list would look like the questions had gone.
    const { data, error } = await sbRpc('classroom_teacher_questions_list',
        { p_classroom_id: roomId }, true);
    if (error) {
        box.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load the questions.')}</div>
            <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>`;
        return;
    }
    const items = Array.isArray(data) ? data : [];
    if (typeof signPrivateMedia === 'function') {
        try { await signPrivateMedia(items); } catch { /* thumbnails may not show */ }
    }
    // The photo choices survive a reload of the list for the same class:
    // fetching a fortnight of detections again because a question was
    // switched off would be the slow part of a fast screen.
    classroomOwn = {
        roomId, items, editing: null, photo: null,
        photos: classroomOwn.roomId === roomId ? classroomOwn.photos : null,
    };
    renderClassroomOwnList();
}

function renderClassroomOwnList() {
    const box = document.getElementById('classroom-review');
    const room = classroomList.find(r => r.id === classroomOwn.roomId);
    if (!box || !room) return;

    const items = classroomOwn.items;
    const on = items.filter(x => x.active).length;
    const rows = items.map(x => {
        const answers = (x.choices || []).map((c, i) => {
            const right = i === x.correct_index;
            return `<li class="${right ? 'right' : ''}">${esc(c)}${right ? ' ✓' : ''}</li>`;
        }).join('');
        // `owned` only exists once the sharing migration is applied. Before
        // then every question in this list is the class's own, which is
        // what `!== false` means here — absent is not borrowed.
        const mine = x.owned !== false;
        return `
        <div class="classroom-review-q cc-own-item${x.active ? '' : ' off'}">
            ${x.image_url ? `<img class="cc-own-thumb" src="${esc(x.image_url)}" alt="">` : ''}
            <div class="cc-own-body">
                <div class="classroom-review-head">
                    ${x.category ? `<span class="classroom-pill">${
                        esc(CLASSROOM_CATEGORY_LABELS[x.category] || x.category)}</span>` : ''}
                    ${mine ? '' : `<span class="classroom-pill">from ${
                        esc(x.from_classroom || 'another class')}</span>`}
                    ${x.shared ? '<span class="classroom-pill">shared</span>' : ''}
                    ${x.video_url ? '<span class="classroom-pill">clip</span>' : ''}
                    ${x.chart_spec ? '<span class="classroom-pill">chart</span>' : ''}
                </div>
                <p class="classroom-review-prompt">${esc(x.prompt)}</p>
                ${(x.standards && x.standards.length) ? `<div class="cc-stds">${
                    x.standards.map(c => `<a class="cc-std" target="_blank" rel="noopener"
                        href="${esc(classroomStandardUrl(c))}"
                        title="${esc(((typeof CLASSROOM_STANDARDS !== 'undefined'
                                   && CLASSROOM_STANDARDS[c]) || {}).text || c)}">${esc(c)}</a>`).join('')}</div>` : ''}
                <ol class="classroom-review-choices">${answers}</ol>
                ${x.explain ? `<p class="classroom-muted">On reveal: ${esc(x.explain)}</p>` : ''}
                <div class="classroom-review-actions">
                    ${mine ? `
                    <button class="classroom-btn" onclick="toggleClassroomOwnQuestion('${escJs(x.id)}')"
                            title="${x.active ? 'Keep it, but stop asking it' : 'Start asking it again'}">
                        ${x.active ? '⏸ Switch off' : '▶ Switch on'}</button>
                    <button class="classroom-btn" onclick="openClassroomOwnForm('${escJs(x.id)}')">✏️ Edit</button>
                    <button class="classroom-btn-danger" onclick="deleteClassroomOwnQuestion('${escJs(x.id)}')">🗑 Delete</button>`
                    : `
                    <!-- Borrowed. Editing it would change it under the teacher
                         who wrote it, and deleting it is not this class's call;
                         all this class may do is stop using it. -->
                    <button class="classroom-btn" onclick="classroomDropShared('${escJs(x.id)}')">
                        ✕ Stop using it</button>
                    <span class="classroom-muted">Written by another class — only they can edit it.</span>`}
                    ${x.active ? '' : '<span class="classroom-muted">Switched off</span>'}
                </div>
            </div>
        </div>`;
    }).join('');

    box.innerHTML = `
        <h4 class="classroom-h">${esc(room.name)}: your own questions</h4>
        <p class="classroom-muted">
            Questions you write here are asked in this class only. A new one comes
            up in the next lesson; after that it takes its turn with the others.
            Switch one off to keep it for another time. They sit out while a
            school challenge is running, so every class plays the same game.
        </p>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="openClassroomOwnForm(null)">＋ Write a question</button>
            <button class="classroom-btn" onclick="showClassroomSharedQuestions()">🤝 From other classes</button>
            <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>
        </div>
        ${items.length
            ? `<p class="classroom-muted">${items.length} question${items.length === 1 ? '' : 's'}, ${on} switched on.</p>
               <div class="classroom-review-list">${rows}</div>`
            : '<p class="classroom-muted">None yet.</p>'}`;
}

/**
 * The form, for a new question (id null) or an existing one.
 *
 * Four answer boxes, always. The first two are required and the last two
 * are optional, which is easier to read than buttons that add and remove
 * rows — and a teacher who wants a yes/no question just leaves two blank.
 */
function openClassroomOwnForm(id) {
    const box = document.getElementById('classroom-review');
    if (!box) return;
    const x = id ? classroomOwn.items.find(q => q.id === id) : null;
    const room0 = classroomList.find(r => r.id === classroomOwn.roomId);
    classroomOwn.editing = x ? x.id : null;
    classroomOwn.photo = x && x.detection_id
        ? { id: x.detection_id, url: x.image_url } : null;

    classroomOwn.clip = x && x.clip_detection_id
        ? { id: x.clip_detection_id, url: x.video_url } : null;
    classroomOwn.chart = (x && x.chart_spec) ? { ...x.chart_spec } : null;
    classroomOwn.standards = (x && Array.isArray(x.standards)) ? x.standards.slice() : [];

    const choices = x ? x.choices.slice() : [];
    const right = x ? x.correct_index : 0;
    const answerRows = [0, 1, 2, 3].map(i => `
        <label class="cc-own-answer">
            <input type="radio" name="cc-own-right" value="${i}"${i === right ? ' checked' : ''}
                   title="This is the right answer">
            <input type="text" id="cc-own-a${i}" maxlength="80"
                   value="${esc(choices[i] || '')}"
                   placeholder="${i < 2 ? `Answer ${i + 1}` : `Answer ${i + 1} (optional)`}">
        </label>`).join('');

    box.innerHTML = `
        <h4 class="classroom-h">${x ? 'Edit question' : 'Write a question'}</h4>
        <textarea id="cc-own-prompt" rows="2" maxlength="300"
                  placeholder="e.g. Which of these birds hunts at night?">${esc(x ? x.prompt : '')}</textarea>
        <p class="classroom-muted">Answers — tick the right one:</p>
        <div class="cc-own-answers">${answerRows}</div>
        <input type="text" id="cc-own-explain" maxlength="400" class="cc-own-explain"
               value="${esc(x && x.explain ? x.explain : '')}"
               placeholder="Optional: a line to show when the answer is revealed">
        <details class="classroom-details" open>
            <summary>Something to look at</summary>
            <p class="classroom-muted">
                A photo or a clip from any feeder in this community — not just this
                class's own. The species label burnt into the bottom stays hidden
                until the answer is shown, so "who is this?" still works.
            </p>
            <div class="cc-own-media-tabs">
                <button type="button" class="classroom-btn" id="cc-own-tab-photo"
                        onclick="classroomOwnMediaTab('photo')">Photos</button>
                <button type="button" class="classroom-btn" id="cc-own-tab-clip"
                        onclick="classroomOwnMediaTab('clip')">Clips</button>
            </div>
            <div class="cc-own-photos" id="cc-own-photos">
                <div class="classroom-muted">Loading this fortnight’s media…</div>
            </div>
        </details>

        <details class="classroom-details" id="cc-own-chart-details">
            <summary>Put a chart beside the question (optional)</summary>
            <p class="classroom-muted">
                Pick a shape and what it should count, and the class sees that chart
                next to your question — so you can ask "which day was busiest?" over
                your own wording. Choose <em>No chart</em> to leave it off.
            </p>
            <p class="classroom-muted">
                Drawn fresh each lesson from whatever the feeders have recorded that
                week — the shape is saved, the numbers never are. A chart saved in
                October would otherwise still be showing October in March, which is
                why the preview below changes as the weeks go by.
            </p>
            <p class="classroom-muted">
                A clip takes the slide if you pick one, so a question with both shows
                the clip and not the chart.
            </p>
            <div class="classroom-form-row">
                <label class="classroom-field">
                    <span>Shape</span>
                    <select id="cc-own-chart-kind" onchange="classroomOwnChartChanged()">
                        <option value="">No chart</option>
                        ${cmOwnChartKindOptions(room0 ? room0.grade_band : 'k-2')}
                    </select>
                </label>
                <label class="classroom-field">
                    <span>Over what</span>
                    <select id="cc-own-chart-source" onchange="classroomOwnChartChanged()">
                    </select>
                </label>
            </div>
            <div id="cc-own-chart-preview" class="cc-own-chart-preview"></div>
        </details>

        <details class="classroom-details">
            <summary>Subject and Florida standards</summary>
            <p class="classroom-muted">
                Optional, and worth doing: a lesson's coverage report counts only
                what is tagged, so an untagged question of yours makes the report
                under-sell the lesson you actually taught.
            </p>
            <label class="classroom-field">
                <span>Subject</span>
                <select id="cc-own-category">
                    <option value="">Not set</option>
                    ${[...new Set(CLASSROOM_TEMPLATES.map(c => c.category))]
                        .sort((a, b) => (CLASSROOM_CATEGORY_LABELS[a] || a)
                                 .localeCompare(CLASSROOM_CATEGORY_LABELS[b] || b))
                        .map(c => `<option value="${esc(c)}"${
                            x && x.category === c ? ' selected' : ''}>${
                            esc(CLASSROOM_CATEGORY_LABELS[c] || c)}</option>`).join('')}
            </select>
            </label>
            <div id="cc-own-standards"></div>
        </details>

        <label class="cc-own-share">
            <input type="checkbox" id="cc-own-shared"${x && x.shared ? ' checked' : ''}>
            <span>Offer this question to the other ${esc(GRADE_BAND_LABELS[room0 && room0.grade_band]
                  || (room0 && room0.grade_band) || '')} classes in this community.
                  They choose whether to use it; nothing lands in their lesson
                  unless their teacher takes it.</span>
        </label>

        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="saveClassroomOwnQuestion()">Save</button>
            <button class="classroom-btn" onclick="renderClassroomOwnList()">Cancel</button>
        </div>
        <div class="classroom-status" id="cc-own-status"></div>`;
    const kindEl = document.getElementById('cc-own-chart-kind');
    const srcEl  = document.getElementById('cc-own-chart-source');
    if (kindEl && classroomOwn.chart) kindEl.value = classroomOwn.chart.kind || '';
    renderClassroomOwnChartSources();
    if (srcEl && classroomOwn.chart && classroomOwn.chart.source) {
        const opt = [...srcEl.options].some(o => o.value === classroomOwn.chart.source);
        if (opt) srcEl.value = classroomOwn.chart.source;
    }

    document.getElementById('cc-own-prompt').focus();
    classroomOwn.mediaTab = 'photo';
    renderClassroomOwnStandards();
    renderClassroomOwnChartPreview();
    loadClassroomOwnPhotos();
}

/**
 * The photos a teacher can pick from: the best shot of each species the
 * class's feeders have seen in the last fortnight. One per species, because
 * thirty near-identical chickadees is not a choice, it is a scroll.
 *
 * Only these, and the server checks it: a question can only ever show a
 * picture the class's own camera took.
 */
async function loadClassroomOwnPhotos() {
    const room = classroomList.find(r => r.id === classroomOwn.roomId);
    if (!room) return;
    if (!classroomOwn.photos) {
        // ⚠ THE WHOLE COMMUNITY, not just this class's feeders. Asked for:
        // "you should be able to choose photos/clips from any feeder
        // accessible to the teacher on the community site." Loading the
        // room with question_scope forced to 'community' reuses the pooling
        // path rather than writing a second way to reach the same rows —
        // and the server checks the detection independently anyway, so this
        // widening is a convenience, not the permission.
        const data = await loadClassroomData({ ...room, question_scope: 'community' });

        const bestShot = new Map(), bestClip = new Map();
        // Snapshots and clips arrive highest-confidence first, so the first
        // seen per species is its clearest.
        (data.all || []).concat(data.each || []).forEach(s => {
            (s.snapshots || []).forEach(r => {
                if (!bestShot.has(r.species)) bestShot.set(r.species, r);
            });
            (s.clips || []).forEach(r => {
                if (!bestClip.has(r.species)) bestClip.set(r.species, r);
            });
        });
        classroomOwn.photos = [...bestShot.values()].slice(0, 24)
            .map(r => ({ id: r.id, url: r.image_url, species: r.species }));
        classroomOwn.clips = [...bestClip.values()].slice(0, 24)
            .map(r => ({ id: r.id, url: r.video_url, poster: r.image_url, species: r.species }));
        // Kept so the chart preview can draw this class's REAL numbers.
        // Explaining a chart in words was the thing a teacher said did not
        // work — "I have no idea how to create a chart question" — so the
        // form shows the chart instead.
        classroomOwn.source = cmPickSource(data);
    }
    renderClassroomOwnPhotos();
    // The preview could not draw before the data arrived.
    renderClassroomOwnChartPreview();
}

function classroomOwnMediaTab(which) {
    classroomOwn.mediaTab = which;
    renderClassroomOwnPhotos();
}

/**
 * The benchmarks a teacher may tag their question with.
 *
 * Only this class's grade band, for the same reason the picker in the
 * classroom form filters: offering a 6-8 code to a K-2 class produces a
 * claim that is wrong on its face, and the coverage report filters by
 * band anyway so it would simply vanish.
 */
function renderClassroomOwnStandards() {
    const box = document.getElementById('cc-own-standards');
    if (!box) return;
    if (typeof CLASSROOM_STANDARDS === 'undefined') { box.innerHTML = ''; return; }

    const room = classroomList.find(r => r.id === classroomOwn.roomId);
    const band = room ? room.grade_band : null;
    const picked = classroomOwn.standards || [];

    const codes = Object.keys(CLASSROOM_STANDARDS)
        .filter(c => !band || CLASSROOM_STANDARDS[c].bands.includes(band));

    const bySubject = new Map();
    codes.forEach(c => {
        const s = CLASSROOM_STANDARDS[c].subject;
        if (!bySubject.has(s)) bySubject.set(s, []);
        bySubject.get(s).push(c);
    });

    box.innerHTML = `
        ${picked.length ? `<div class="cc-stds">${picked.map(c => `
            <button type="button" class="cc-std cc-std-drop"
                    onclick="classroomOwnDropStandard('${escJs(c)}')"
                    title="${esc((CLASSROOM_STANDARDS[c] || {}).text || c)}">${esc(c)} ✕</button>`).join('')}</div>`
          : '<p class="classroom-muted">No standards tagged yet.</p>'}
        <select id="cc-own-std-add" onchange="classroomOwnAddStandard(this.value)">
            <option value="">＋ Add a benchmark…</option>
            ${[...bySubject.entries()].map(([subj, cs]) => `
                <optgroup label="${esc(subj)}">
                    ${cs.filter(c => !picked.includes(c)).map(c => `
                        <option value="${esc(c)}">${esc(c)} — ${
                            esc(CLASSROOM_STANDARDS[c].text.slice(0, 70))}${
                            CLASSROOM_STANDARDS[c].text.length > 70 ? '…' : ''}</option>`).join('')}
                </optgroup>`).join('')}
        </select>`;
}

function classroomOwnAddStandard(code) {
    if (!code) return;
    classroomOwn.standards = classroomOwn.standards || [];
    // Eight is the table's own limit; stopping here gives a reason rather
    // than an error from the server after the save is attempted.
    if (classroomOwn.standards.length >= 8) {
        const s = document.getElementById('cc-own-status');
        if (s) { s.style.color = '#e74c3c'; s.textContent = 'Eight benchmarks is the limit.'; }
        return;
    }
    if (!classroomOwn.standards.includes(code)) classroomOwn.standards.push(code);
    renderClassroomOwnStandards();
}

function classroomOwnDropStandard(code) {
    classroomOwn.standards = (classroomOwn.standards || []).filter(c => c !== code);
    renderClassroomOwnStandards();
}

const CC_CHART_KIND_LABELS = {
    bars:  'Bar chart',
    hbars: 'Bars, lying down',
    line:  'Line',
    dots:  'Tally (one mark per visit)',
    picto: 'Picture graph with a key',
    donut: 'Circle, for shares of a whole',
};

/**
 * Only the shapes this grade band can actually use.
 *
 * A tally draws one mark per visit and stays countable only at K-2
 * numbers, so for 3-5 and 6-8 it has no valid source at all. Offering it
 * there would empty the "Over what" list the moment it was chosen, which
 * is a worse way to learn the rule than not being offered it.
 */
function cmOwnChartKindOptions(band) {
    return Object.keys(CC_CHART_KIND_LABELS)
        .filter(k => cmOwnChartSources(k, band).length)
        .map(k => `<option value="${esc(k)}">${esc(CC_CHART_KIND_LABELS[k])}</option>`)
        .join('');
}

const CC_CHART_SOURCE_LABELS = {
    days:    'Each day this week',
    species: 'Each species',
    hours:   'Each hour of the day',
};

/**
 * Rebuild "Over what" to hold only what the chosen shape can draw.
 *
 * ⚠ THE COMBINATIONS ARE NOT ALL LEGAL, and the form used to offer every
 * one of them. Reported with five named: Line over species, Tally over
 * species, Tally over hours, Circle over days, Circle over hours. Each
 * picked a shape the data cannot carry, cmChart quietly substituted
 * another, and the teacher got a chart they had not asked for.
 *
 * Removing them from the list is better than explaining them after the
 * fact: the only way to find out used to be to pick one and look.
 */
function renderClassroomOwnChartSources() {
    const kindEl = document.getElementById('cc-own-chart-kind');
    const srcEl  = document.getElementById('cc-own-chart-source');
    if (!kindEl || !srcEl) return;

    const room = classroomList.find(r => r.id === classroomOwn.roomId);
    const band = room ? room.grade_band : 'k-2';
    const kind = kindEl.value;

    const allowed = kind ? cmOwnChartSources(kind, band) : Object.keys(CC_CHART_SOURCE_LABELS);
    const wanted  = srcEl.value || (classroomOwn.chart && classroomOwn.chart.source) || 'days';

    srcEl.innerHTML = allowed.map(src =>
        `<option value="${esc(src)}">${esc(CC_CHART_SOURCE_LABELS[src])}</option>`).join('');
    // Keep what they had if it survives; otherwise fall to the first that
    // works rather than leaving the select showing a value it has lost.
    srcEl.value = allowed.includes(wanted) ? wanted : (allowed[0] || '');
    srcEl.disabled = !kind;
}

function classroomOwnChartChanged() {
    renderClassroomOwnChartSources();
    const kind = document.getElementById('cc-own-chart-kind').value;
    const src  = document.getElementById('cc-own-chart-source').value;
    classroomOwn.chart = kind ? { kind, source: src || 'days' } : null;
    renderClassroomOwnChartPreview();
}

/**
 * Show the chart, rather than describing it.
 *
 * A teacher wrote: "I have no idea how to create a chart question using
 * the write new question editor. Is it possible to explain it in the
 * page?" Explaining it in more words was the obvious answer and the
 * wrong one — the question was really "what will this do?", and the only
 * convincing answer to that is the chart itself, drawn from this class's
 * own data, changing the moment either dropdown moves.
 *
 * Says so plainly when the data cannot carry the chosen shape, which is
 * an ordinary outcome on a quiet week and would otherwise look broken.
 */
function renderClassroomOwnChartPreview() {
    const box = document.getElementById('cc-own-chart-preview');
    if (!box) return;

    if (!classroomOwn.chart) {
        box.innerHTML = '<p class="classroom-muted">No chart — the question goes up on '
                      + 'its own, or with a photo.</p>';
        return;
    }
    if (!classroomOwn.source) {
        box.innerHTML = '<p class="classroom-muted">Loading this class’s data…</p>';
        return;
    }

    const room  = classroomList.find(r => r.id === classroomOwn.roomId);
    const band  = room ? room.grade_band : 'k-2';
    const chart = cmOwnChart(classroomOwn.chart, classroomOwn.source, band);

    // A refusal has two very different causes and a teacher needs to know
    // which: the pair cannot be drawn at all, or it can and there is not
    // enough data this week.
    const why = cmOwnChartWhyNot(classroomOwn.chart.kind, classroomOwn.chart.source, band);

    box.innerHTML = chart
        ? `<p class="classroom-muted">This is what the class would see this week:</p>
           ${classroomChartHtml(chart, false)}`
        : why
        ? `<p class="classroom-muted">${esc(why)}</p>`
        : `<p class="classroom-muted">${esc(cmOwnChartDataWhyNot(classroomOwn.chart,
                                                                 classroomOwn.source))}</p>`;
}

function renderClassroomOwnPhotos() {
    const box = document.getElementById('cc-own-photos');
    if (!box) return;

    const clips = classroomOwn.mediaTab === 'clip';
    const pick  = clips ? classroomOwn.clip : classroomOwn.photo;
    const list  = (clips ? classroomOwn.clips : classroomOwn.photos || []).slice();

    // A question saved with older media keeps it on offer, even though it
    // has dropped out of the fortnight the picker shows.
    if (pick && !list.some(p => p.id === pick.id)) {
        list.unshift({ id: pick.id, url: pick.url, species: clips ? 'Current clip' : 'Current photo' });
    }

    ['photo', 'clip'].forEach(k => {
        const b = document.getElementById('cc-own-tab-' + k);
        if (b) b.classList.toggle('on', classroomOwn.mediaTab === k);
    });

    const none = clips ? 'No clip' : 'No photo';
    box.innerHTML = `
        <button type="button" class="cc-own-photo none${pick ? '' : ' on'}"
                onclick="pickClassroomOwnMedia(null)">${none}</button>
        ${list.map(p => `
            <button type="button" class="cc-own-photo${pick && pick.id === p.id ? ' on' : ''}"
                    onclick="pickClassroomOwnMedia('${escJs(p.id)}')" title="${esc(p.species || '')}">
                ${clips
                    ? `<video src="${esc(p.url || '')}" muted preload="metadata"
                             ${p.poster ? `poster="${esc(p.poster)}"` : ''}></video>
                       <span class="cc-own-play" aria-hidden="true">▶</span>`
                    : `<img src="${esc(p.url || '')}" alt="${esc(p.species || '')}">`}
            </button>`).join('')}
        ${list.length ? '' : `<span class="classroom-muted">No ${
            clips ? 'clips' : 'photos'} from this community's feeders in the last two weeks.</span>`}`;
}

/**
 * Pick, or clear, whichever kind of media the open tab is showing.
 *
 * A photo and a clip are kept SEPARATELY rather than one "media" slot,
 * because the slide shows a clip in preference to a photo and a teacher
 * who sets both should get the clip without losing the photo they chose
 * for the days the clip is swept by media retention.
 */
function pickClassroomOwnMedia(id) {
    const clips = classroomOwn.mediaTab === 'clip';
    const key   = clips ? 'clip' : 'photo';
    if (!id) { classroomOwn[key] = null; renderClassroomOwnPhotos(); return; }

    const pool = (clips ? classroomOwn.clips : classroomOwn.photos) || [];
    const all  = pool.concat(classroomOwn[key] ? [classroomOwn[key]] : []);
    const p = all.find(x => x.id === id);
    classroomOwn[key] = p ? { id: p.id, url: p.url } : null;
    renderClassroomOwnPhotos();
}

// Kept under its old name: the review list still calls it.
function pickClassroomOwnPhoto(id) { pickClassroomOwnMedia(id); }

async function saveClassroomOwnQuestion() {
    const status = document.getElementById('cc-own-status');
    const say = (msg, bad) => {
        status.style.color = bad ? '#e74c3c' : 'var(--color-gray-500)';
        status.textContent = msg;
    };
    const prompt = document.getElementById('cc-own-prompt').value.trim();
    const rightBox = document.querySelector('input[name="cc-own-right"]:checked');
    const rightAt = rightBox ? Number(rightBox.value) : 0;

    // Blank boxes are dropped HERE, with the right answer's position moved to
    // match, because the server refuses a blank answer rather than guessing
    // what was meant. A tick on an empty box is the one thing that cannot be
    // fixed up, so it is said plainly.
    const raw = [0, 1, 2, 3].map(i => document.getElementById('cc-own-a' + i).value.trim());
    if (!prompt)       { say('Write the question first.', true); return; }
    if (!raw[rightAt]) { say('The answer ticked as right is empty.', true); return; }
    const choices = [];
    let correct = -1;
    raw.forEach((v, i) => {
        if (!v) return;
        if (i === rightAt) correct = choices.length;
        choices.push(v);
    });
    if (choices.length < 2) { say('A question needs at least two answers.', true); return; }

    say('Saving…');

    const base = {
        p_classroom_id:  classroomOwn.roomId,
        p_id:            classroomOwn.editing,
        p_prompt:        prompt,
        p_choices:       choices,
        p_correct_index: correct,
        p_explain:       document.getElementById('cc-own-explain').value.trim() || null,
        p_detection_id:  classroomOwn.photo ? classroomOwn.photo.id : null,
    };
    const catEl    = document.getElementById('cc-own-category');
    const sharedEl = document.getElementById('cc-own-shared');
    const extra = {
        p_clip_detection_id: classroomOwn.clip ? classroomOwn.clip.id : null,
        p_chart_spec:        classroomOwn.chart || null,
        p_category:          (catEl && catEl.value) || null,
        p_standards:         classroomOwn.standards || [],
        p_shared:            !!(sharedEl && sharedEl.checked),
    };

    let { error } = await sbRpc('classroom_teacher_question_save',
                                { ...base, ...extra }, true);

    // ⚠ THE MIGRATION MAY NOT BE APPLIED YET. The site deploys the moment
    // it is pushed; the SQL is pasted into the Supabase editor by hand,
    // and the gap between the two is however long that takes. A teacher
    // who loses a question they just wrote because of that gap is the
    // worst outcome of shipping the feature at all, and it has happened
    // before in this project — see the same fallback in sendClassroomFlag.
    //
    // PGRST202 is PostgREST failing to resolve the call because the new
    // arguments are not on the function. Retry with the shape that has
    // existed all along: the question saves, and only the new extras are
    // lost. Said out loud rather than silently, so the teacher knows the
    // chart they picked did not stick.
    const missingArgs = error && (error.code === 'PGRST202'
        || /p_clip_detection_id|p_chart_spec|p_shared|schema cache|does not exist/i
             .test(error.message || ''));
    if (missingArgs) {
        const retry = await sbRpc('classroom_teacher_question_save', base, true);
        if (!retry.error) {
            showToast('Saved — but charts, clips, subjects and sharing need the '
                    + 'database update first.');
            showClassroomOwnQuestions(classroomOwn.roomId);
            return;
        }
        error = retry.error;
    }

    if (error) { say(error.message || 'Could not save that.', true); return; }
    showToast(classroomOwn.editing ? 'Question saved' : 'Saved — it comes up in the next lesson');
    showClassroomOwnQuestions(classroomOwn.roomId);
}

/**
 * Questions other classes in this community have offered.
 *
 * Nothing here is in this class's lesson yet — taking one is a decision
 * its teacher makes, which is the whole point of sharing being opt-in at
 * both ends. See the header of setup-classroom-teacher-questions-2.sql.
 */
async function showClassroomSharedQuestions() {
    const box = document.getElementById('classroom-review');
    const room = classroomList.find(r => r.id === classroomOwn.roomId);
    if (!box || !room) return;

    box.innerHTML = '<div class="classroom-muted">Looking for questions other classes have shared…</div>';

    const { data, error } = await sbRpc('classroom_shared_questions_list',
        { p_classroom_id: room.id }, true);

    if (error) {
        // Before the migration this function does not exist at all, which
        // is a missing feature rather than a fault — say so plainly instead
        // of showing a teacher a database error.
        const notYet = error.code === 'PGRST202'
            || /does not exist|schema cache/i.test(error.message || '');
        box.innerHTML = notYet
            ? `<h4 class="classroom-h">From other classes</h4>
               <p class="classroom-muted">Sharing needs the database update first.</p>
               <button class="classroom-btn" onclick="renderClassroomOwnList()">Back</button>`
            : `<div class="classroom-error">${esc(error.message || 'Could not load.')}</div>
               <button class="classroom-btn" onclick="renderClassroomOwnList()">Back</button>`;
        return;
    }

    const items = Array.isArray(data) ? data : [];
    if (typeof signPrivateMedia === 'function') {
        try { await signPrivateMedia(items); } catch { /* thumbnails may not show */ }
    }

    box.innerHTML = `
        <h4 class="classroom-h">Questions other classes have shared</h4>
        <p class="classroom-muted">
            Written by teachers of other ${esc(GRADE_BAND_LABELS[room.grade_band] || room.grade_band)}
            classes in this community. Take one and it joins your lesson pool;
            you can stop using it at any time, and only the teacher who wrote
            it can change it.
        </p>
        ${items.length ? items.map(x => `
            <div class="classroom-review-q cc-own-item">
                ${x.image_url ? `<img class="cc-own-thumb" src="${esc(x.image_url)}" alt="">` : ''}
                <div class="cc-own-body">
                    <div class="classroom-review-head">
                        <span class="classroom-pill">${esc(x.from_classroom || 'another class')}</span>
                        ${x.category ? `<span class="classroom-pill">${
                            esc(CLASSROOM_CATEGORY_LABELS[x.category] || x.category)}</span>` : ''}
                    </div>
                    <p class="classroom-review-prompt">${esc(x.prompt)}</p>
                    ${(x.standards && x.standards.length) ? `<div class="cc-stds">${
                        x.standards.map(c => `<span class="cc-std">${esc(c)}</span>`).join('')}</div>` : ''}
                    <ol class="classroom-review-choices">${
                        (x.choices || []).map((c, i) => `<li class="${
                            i === x.correct_index ? 'right' : ''}">${esc(c)}${
                            i === x.correct_index ? ' ✓' : ''}</li>`).join('')}</ol>
                    <div class="classroom-review-actions">
                        <button class="classroom-btn-primary"
                                onclick="classroomAdoptShared('${escJs(x.id)}')">＋ Use this one</button>
                    </div>
                </div>
            </div>`).join('')
          : '<p class="classroom-muted">Nothing shared yet by other classes in this band.</p>'}
        <button class="classroom-btn" onclick="renderClassroomOwnList()">Back</button>`;
}

async function classroomAdoptShared(id) {
    const { error } = await sbRpc('classroom_adopt_question',
        { p_classroom_id: classroomOwn.roomId, p_question_id: id, p_adopt: true }, true);
    if (error) { showToast(error.message || 'Could not take that one.'); return; }
    showToast('Added — it joins the pool for your next lesson');
    showClassroomSharedQuestions();
}

async function classroomDropShared(id) {
    const { error } = await sbRpc('classroom_adopt_question',
        { p_classroom_id: classroomOwn.roomId, p_question_id: id, p_adopt: false }, true);
    if (error) { showToast(error.message || 'Could not remove that one.'); return; }
    showToast('Removed from your class');
    showClassroomOwnQuestions(classroomOwn.roomId);
}

async function toggleClassroomOwnQuestion(id) {
    const x = classroomOwn.items.find(q => q.id === id);
    if (!x) return;
    const { error } = await sbRpc('classroom_teacher_question_set_active',
        { p_id: id, p_active: !x.active }, true);
    if (error) { showToast(error.message || 'Could not change that.'); return; }
    x.active = !x.active;
    renderClassroomOwnList();
}

async function deleteClassroomOwnQuestion(id) {
    const x = classroomOwn.items.find(q => q.id === id);
    if (!x) return;
    // "Switch off" is offered as the alternative because it is nearly always
    // what is meant: a question finished with for now, not one never wanted.
    if (!confirm(`Delete "${x.prompt}"?\n\nThis cannot be undone. To keep it for `
               + 'another time, use "Switch off" instead.')) return;
    const { error } = await sbRpc('classroom_teacher_question_delete', { p_id: id }, true);
    if (error) { showToast(error.message || 'Could not delete that.'); return; }
    classroomOwn.items = classroomOwn.items.filter(q => q.id !== id);
    renderClassroomOwnList();
}

// ── Reviewing the questions (and saying what is wrong with them) ──
//
// The questions are generated from templates against live data, so nobody —
// including whoever wrote the template — sees the exact wording a class will
// get until a class gets it. That makes "this one reads badly" the most
// useful signal there is for improving them, and it needs somewhere to go
// that is not a teacher's memory until the next time they see somebody.
//
// Review builds a real lesson and lists the whole thing: every question as it
// would appear, its answer, its chart, and a button to say what is wrong.
// Deliberately NOT a session — reviewing should not leave sessions in the
// history, and a teacher checking next week's questions on a Sunday is not
// teaching a class.

let classroomReviewRoom = null;
let classroomReviewQuestions = [];

/**
 * Template ids this classroom has seen lately.
 *
 * Never fatal: a classroom with no history, or a database that has not had
 * setup-classroom-cadence.sql run against it yet, simply gets no repeat
 * avoidance rather than no lesson.
 */
async function loadClassroomRecentTemplates(roomId) {
    const { data, error } = await sbRpc('classroom_recent_templates',
        { p_classroom_id: roomId, p_days: 14 }, true);
    return (!error && Array.isArray(data)) ? data : [];
}

async function reviewClassroomQuestions(roomId) {
    const room = classroomList.find(r => r.id === roomId);
    const box = document.getElementById('classroom-review');
    if (!room || !box) return;

    hideClassroomHistory();
    closeClassroomForm();
    renderClassroomList();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Building a lesson from the feeder…</div>';

    // Reviewing shows what the class WILL be asked, so it has to honour a
    // live challenge exactly as the lesson will — and include the teacher's
    // own questions exactly as the lesson will. A review that disagreed
    // with the board would be worse than no review.
    const [data, challenge, own] = await Promise.all([
        loadClassroomData(room),
        classroomActiveChallenge(roomId),
        loadClassroomOwnQuestions(roomId),
    ]);
    const { questions, source, built, offered } =
        buildClassroomQuestions(room, data, { all: true, challenge, own });
    classroomReviewRoom = room;
    classroomReviewQuestions = questions;

    if (!questions.length) {
        box.innerHTML = `<div class="classroom-muted">
            ${esc(room.home_feeder_name || 'This feeder')} hasn't logged enough
            visits to build a lesson from, so there is nothing to review yet.</div>
            <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>`;
        return;
    }

    const band = GRADE_BAND_LABELS[room.grade_band] || room.grade_band;
    // Say it before the list, not after: a teacher seeing three questions
    // where they expect eight should learn why in the same glance.
    const narrowed = challenge && challenge.question_mode !== 'any';
    const challengeNote = !narrowed ? '' : `
        <p class="classroom-note">🏆 “${esc(challenge.name)}” is running, so this
           class is asking ${esc(cmChallengeQuestionLabel(challenge))} this week rather
           than its own list.${questions.length < CLASSROOM_QUESTIONS_PER_SESSION
             ? ` That leaves ${questions.length} question${questions.length === 1 ? '' : 's'}
                 today, short of the ${CLASSROOM_QUESTIONS_PER_SESSION} a lesson asks.`
             : ''}</p>`;

    box.innerHTML = `
        <h4 class="classroom-h">Questions for ${esc(room.name)} — ${esc(band)}</h4>
        ${challengeNote}
        <p class="classroom-muted">
            All ${built} question${built === 1 ? '' : 's'} this band can build from
            ${esc(source.name)}${source.isPool
                ? ` (${source.feeders.length} feeder${source.feeders.length === 1 ? '' : 's'} pooled)`
                : source.isHome ? '' : ' (a partner feeder)'} today,
            exactly as a class would see them. A lesson shows
            ${CLASSROOM_QUESTIONS_PER_SESSION} of these; this is the whole set, so
            nothing goes unreviewed just because a lesson did not pick it.
            ${offered > built
                ? `<br><span class="classroom-warn">${offered - built} more
                   template${offered - built === 1 ? '' : 's'} exist for this band but
                   had nothing to say about this week's data.</span>`
                : ''}
        </p>
        ${cmStandardsSummaryHtml(questions, 'this set')}
        <div class="classroom-review-list">
            ${questions.map((q, i) => classroomReviewItem(q, i)).join('')}
        </div>
        <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>`;
}

// ── Standards on screen ─────────────────────────────────────────────
//
// The alignment map is worth nothing to a teacher until they can see it
// without leaving the panel, and worth less than nothing if they have to
// take our word for what a code means. So every chip carries the
// benchmark's own text in its tooltip and links to CPALMS, where the same
// words are, under Florida's name rather than ours.
//
// Rendered from classroom-alignment.js, which may not have loaded — the
// classroom module has to keep working if a later script 404s, so every
// one of these returns empty rather than throwing.

/**
 * Chips for an explicit list of codes, band-filtered.
 *
 * Split out of cmStandardChipsHtml so a teacher's hand-tagged question
 * renders through exactly the same path as a template's — one chip
 * style, one tooltip, one link, whoever wrote the question.
 */
function cmStandardChipsList(codes, band) {
    if (typeof CLASSROOM_STANDARDS === 'undefined') return '';
    const keep = (codes || []).filter(c => {
        const s = CLASSROOM_STANDARDS[c];
        return !band || !s || s.bands.includes(band);
    });
    if (!keep.length) return '';

    return `<div class="cc-stds">${keep.map(c => {
        const s = CLASSROOM_STANDARDS[c] || null;
        return `<a class="cc-std" target="_blank" rel="noopener"
                   href="${esc(classroomStandardUrl(c))}"
                   title="${esc(s ? s.text : c)}">${esc(c)}</a>`;
    }).join('')}</div>`;
}

function cmStandardChipsHtml(recordedId, band) {
    if (typeof CLASSROOM_TEMPLATE_STANDARDS === 'undefined') return '';
    // Seven templates file their questions under a per-instance id. See
    // the header above CLASSROOM_ID_PREFIXES in classroom-alignment.js.
    const templateId = typeof classroomTemplateIdOf === 'function'
        ? classroomTemplateIdOf(recordedId) : recordedId;
    // Band-filtered for the same reason classroomStandardsFor is: a
    // template serving K-2 and 3-5 claims benchmarks from both, but the
    // question on screen was built for one of them.
    const codes = (CLASSROOM_TEMPLATE_STANDARDS[templateId] || []).filter(c => {
        const s = (typeof CLASSROOM_STANDARDS !== 'undefined' && CLASSROOM_STANDARDS[c]) || null;
        return !band || !s || s.bands.includes(band);
    });
    if (!codes.length) return '';

    return `<div class="cc-stds">${codes.map(c => {
        const s = (typeof CLASSROOM_STANDARDS !== 'undefined' && CLASSROOM_STANDARDS[c]) || null;
        return `<a class="cc-std" target="_blank" rel="noopener"
                   href="${esc(classroomStandardUrl(c))}"
                   title="${esc(s ? s.text : c)}">${esc(c)}</a>`;
    }).join('')}</div>`;
}

/**
 * What a set of questions covered, grouped by subject.
 *
 * Deliberately lists the benchmarks rather than counting them. "Covers 9
 * standards" is a number a teacher cannot check and would be right not to
 * trust; a list of codes is one they can take to a curriculum meeting.
 *
 * Questions that claim nothing are counted and said out loud. A lesson is
 * allowed to contain a word puzzle for its own sake, and hiding that from
 * the summary would make the coverage look denser than it is.
 */
function cmStandardsSummaryHtml(questions, label) {
    if (typeof CLASSROOM_TEMPLATE_STANDARDS === 'undefined'
     || typeof CLASSROOM_STANDARDS === 'undefined') return '';

    const qs = questions || [];
    const codes = classroomStandardsFor(qs);
    // Through the resolver, like everything else — a question filed as
    // "sound-carolina-chickadee" is a bird-by-sound question and is
    // aligned. Counting it as untagged here would have contradicted the
    // list of benchmarks printed immediately above it.
    const untagged = qs.filter(q => {
        if (q && Array.isArray(q.standards) && q.standards.length) return false;
        const raw = q && (q.template_id || q.templateId);
        const id  = typeof classroomTemplateIdOf === 'function'
            ? classroomTemplateIdOf(raw) : raw;
        return !(CLASSROOM_TEMPLATE_STANDARDS[id] || []).length;
    }).length;

    if (!codes.length && !untagged) return '';

    const bySubject = new Map();
    codes.forEach(c => {
        const s = CLASSROOM_STANDARDS[c];
        if (!s) return;
        if (!bySubject.has(s.subject)) bySubject.set(s.subject, []);
        bySubject.get(s.subject).push(c);
    });

    return `
        <details class="classroom-details cc-std-summary">
            <summary>Florida standards covered${codes.length ? ` (${codes.length})` : ''}</summary>
            ${[...bySubject.entries()].map(([subject, cs]) => `
                <div class="cc-std-group">
                    <h5>${esc(subject)}</h5>
                    <ul>${cs.map(c => `
                        <li>
                            <a class="cc-std" target="_blank" rel="noopener"
                               href="${esc(classroomStandardUrl(c))}">${esc(c)}</a>
                            <span>${esc(CLASSROOM_STANDARDS[c].text)}</span>
                        </li>`).join('')}</ul>
                </div>`).join('')}
            ${untagged ? `<p class="classroom-muted">
                ${untagged} question${untagged === 1 ? '' : 's'} in ${esc(label || 'this set')}
                ${untagged === 1 ? 'is' : 'are'} not aligned to a benchmark — the word
                puzzles mostly. They are there because a class enjoys them, not because
                a standard asks for them.</p>` : ''}
            <p class="classroom-muted">
                Benchmark codes and wording come from CPALMS, Florida's official
                standards site, and each code links to it. Which questions match
                which benchmark is BirdWatchAI's own judgement, not Florida's —
                please check a code against CPALMS before relying on it in a
                report or a lesson plan.</p>
        </details>`;
}

function classroomReviewItem(q, i) {
    const choices = (q.choices || []).map((c, k) => {
        const right = k === q.correct_index;
        return `<li class="${right ? 'right' : ''}">${esc(c.label)}${right ? ' ✓' : ''}</li>`;
    }).join('');

    // The actual slide, rendered the way the class first meets it — before
    // the reveal, with values hidden unless the chart asks for them.
    // Describing it in words ("bar chart — visits each day") was useless for
    // the one judgement review exists to make: whether a room of children can
    // actually read the thing.
    const slide = classroomEvidenceHtml(q, false);

    return `
        <div class="classroom-review-q" data-q="${i}">
            <div class="classroom-review-head">
                <span class="classroom-pill">${esc(
                    q.own && q.owned === false ? 'shared question'
                  : q.own ? 'your question' : q.category)}</span>
                <code class="classroom-review-tid">${esc(q.template_id)}</code>
                ${q.from_partner ? '<span class="classroom-pill partner">partner data</span>' : ''}
                ${q.scope === 'community' ? '<span class="classroom-pill">pooled data</span>' : ''}
            </div>
            ${(q.standards && q.standards.length)
                ? cmStandardChipsList(q.standards, q.grade_band)
                : cmStandardChipsHtml(q.template_id, q.grade_band)}
            ${slide ? `<div class="classroom-review-slide">${slide}</div>` : ''}
            ${classroomIntroHtml(q)}
            <p class="classroom-review-prompt">${esc(q.prompt)}</p>
            <ol class="classroom-review-choices">${choices}</ol>
            ${q.poll
                ? '<p class="classroom-muted">A poll — no right answer; the class says what it saw.</p>'
                : q.correct_index == null
                ? '<p class="classroom-muted">Prediction — scored later, no answer yet.</p>' : ''}
            ${q.explain ? `<p class="classroom-muted">On reveal: ${esc(q.explain)}</p>` : ''}
            <div class="classroom-review-actions">
                <button class="classroom-btn" onclick="openClassroomFlag(${i}, 'flag')">⚑ Something is wrong</button>
                <button class="classroom-btn" onclick="openClassroomFlag(${i}, 'suggestion')">💡 Suggest an improvement</button>
            </div>
            <div class="classroom-flag-form" id="classroom-flag-${i}"></div>
        </div>`;
}

// What each kind of feedback asks for.
//
// Two kinds, because most of what a careful reviewer notices is not a fault.
// "The bars are too far apart and maybe should be different colors" is worth
// more than most flags, and filing it as a defect either dilutes the real
// defects in the queue or gets it closed unread. A teacher who has to call
// their idea a fault will often just not file it, which loses exactly the
// observation that was worth having.
const CLASSROOM_FEEDBACK_KINDS = {
    flag: {
        reasons: [
            ['unclear',    'The question is unclear'],
            ['wrong',      'The answer looks wrong'],
            ['too_hard',   'Too hard for this band'],
            ['too_easy',   'Too easy for this band'],
            ['bad_visual', 'The photo or chart is the problem'],
            ['other',      'Something else'],
        ],
        placeholder: 'What was wrong with it? The more specific the better '
                   + '\u2014 which word, which number.',
        send: 'Send feedback',
    },
    suggestion: {
        reasons: [
            ['improvement', 'It would just be better this way'],
            ['bad_visual',  'The photo or chart could be clearer'],
            ['unclear',     'The wording could be clearer'],
            ['too_hard',    'A bit much for this band'],
            ['too_easy',    'A bit easy for this band'],
            ['other',       'Something else'],
        ],
        placeholder: 'What would make it better? Nothing has to be wrong with '
                   + 'it \u2014 spacing, colors, wording all count.',
        send: 'Send suggestion',
    },
};

/**
 * The feedback form, opened under one question.
 *
 * A reason AND a comment, because the reason alone is not actionable — "too
 * hard" could mean the arithmetic, the vocabulary or the chart — and a
 * comment alone cannot be counted. The reasons are the ones that map to
 * different fixes rather than to different feelings.
 *
 * `kind` is 'flag' (a defect to fix before a class meets it) or 'suggestion'
 * (a better idea). It rides along to the RPC, so the two arrive in the
 * feedback queue as different things rather than as one undifferentiated
 * pile.
 */
function openClassroomFlag(i, kind) {
    const box = document.getElementById(`classroom-flag-${i}`);
    if (!box) return;
    const spec = CLASSROOM_FEEDBACK_KINDS[kind] || CLASSROOM_FEEDBACK_KINDS.flag;

    // Pressing the same button again is not a request to close — it used to
    // toggle, which silently threw away everything typed in. Closing is
    // Cancel's job, which is labelled. Pressing the OTHER button swaps the
    // form over, carrying the text across: realising halfway through that
    // this is a suggestion rather than a complaint should not cost you the
    // sentence you already wrote.
    const existing = box.querySelector('textarea');
    const carried  = existing ? existing.value : '';
    if (existing && box.dataset.kind === kind) { existing.focus(); return; }

    box.dataset.kind = kind;
    box.innerHTML = `
        <select id="classroom-flag-reason-${i}">
            ${spec.reasons.map(([v, label]) =>
                `<option value="${v}">${esc(label)}</option>`).join('')}
        </select>
        <textarea id="classroom-flag-note-${i}" rows="3" maxlength="2000"
                  placeholder="${esc(spec.placeholder)}"></textarea>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="sendClassroomFlag(${i})">${esc(spec.send)}</button>
            <button class="classroom-btn" onclick="closeClassroomFlag(${i})">Cancel</button>
        </div>
        <div class="classroom-status" id="classroom-flag-status-${i}"></div>`;

    const note = document.getElementById(`classroom-flag-note-${i}`);
    note.value = carried;
    note.focus();
}

// ── Saying something that is not about a question ───────────────────
//
// Review's Suggest button is attached to a question, which is right for
// "this chart is hard to read" and useless for "the panel should open
// full screen". Flagged as exactly that: "there should be a general
// suggestion area, not just for a question suggestion."
//
// It writes through classroom_suggest_question, which has existed since
// the first feedback migration and has never had a front end — it takes a
// free-text idea with an optional band and category and files it as
// kind='suggestion', reason='idea'. No migration; the door was already
// there, nothing opened it.

/**
 * The same form, in its own modal, from the navbar.
 *
 * Shares cmIdeaFormHtml and sendClassroomIdea with the in-panel version so
 * there is one form and one send path — two copies of a feedback form is
 * how one of them quietly stops working.
 */
function openClassroomIdeaStandalone() {
    const modal = document.getElementById('classroom-idea-modal');
    const body  = document.getElementById('classroom-idea-body');
    if (!modal || !body) return;

    const mine = classroomCommunities();
    if (!mine.length) {
        showToast('You are not in a community yet.');
        return;
    }
    // Default to whichever community the classroom panel was last pointed
    // at, so a teacher who has been working in one does not have to say so
    // again.
    if (!classroomCommunityId || !mine.some(c => c.id === classroomCommunityId)) {
        classroomCommunityId = mine[0].id;
    }

    body.innerHTML = `
        ${mine.length > 1 ? `
            <label class="classroom-field" style="display:block;margin-bottom:0.75rem;">
                <span>Which community</span>
                <select id="cc-idea-community" style="width:100%;"
                        onchange="classroomCommunityId = this.value">
                    ${mine.map(c => `<option value="${esc(c.id)}"${
                        c.id === classroomCommunityId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
                </select>
            </label>` : ''}
        ${cmIdeaFormHtml(null, 'closeClassroomIdeaStandalone()')}`;

    modal.classList.add('open');
    const t = document.getElementById('cc-idea-text');
    if (t) t.focus();
}

function closeClassroomIdeaStandalone() {
    const modal = document.getElementById('classroom-idea-modal');
    const t = document.getElementById('cc-idea-text');
    if (t && t.value.trim()
        && !confirm('Discard what you have written?')) return;
    if (modal) modal.classList.remove('open');
}

/**
 * The form itself. `room` seeds the grade band when there is one;
 * `cancel` is whatever closing means wherever it has been put.
 */
function cmIdeaFormHtml(room, cancel) {
    const cats = [...new Set(CLASSROOM_TEMPLATES.map(t => t.category))]
        .sort((a, b) => (CLASSROOM_CATEGORY_LABELS[a] || a)
                 .localeCompare(CLASSROOM_CATEGORY_LABELS[b] || b));

    return `
        <p class="classroom-muted">
            Anything at all — a question you wish existed, something about how the
            classroom or the community site works, a bird the lessons never mention.
            It goes to the same place as the notes left on individual questions,
            and it is read.
        </p>
        <textarea id="cc-idea-text" rows="5" maxlength="2000"
                  placeholder="e.g. It would help if a lesson could be paused and picked up after break."></textarea>
        <div class="classroom-form-row">
            <label class="classroom-field">
                <span>Which grade band, if it matters</span>
                <select id="cc-idea-band">
                    <option value="">Any — or not about a grade</option>
                    <option value="k-2"${room && room.grade_band === 'k-2' ? ' selected' : ''}>K–2</option>
                    <option value="3-5"${room && room.grade_band === '3-5' ? ' selected' : ''}>Grades 3–5</option>
                    <option value="6-8"${room && room.grade_band === '6-8' ? ' selected' : ''}>Grades 6–8</option>
                </select>
            </label>
            <label class="classroom-field">
                <span>Which subject, if it is about one</span>
                <select id="cc-idea-category">
                    <option value="">Not about a subject</option>
                    ${cats.map(c => `<option value="${esc(c)}">${
                        esc(CLASSROOM_CATEGORY_LABELS[c] || c)}</option>`).join('')}
                </select>
            </label>
        </div>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="sendClassroomIdea()">Send it</button>
            <button class="classroom-btn" onclick="${cancel}">Cancel</button>
        </div>
        <div class="classroom-status" id="cc-idea-status"></div>`;
}

function openClassroomIdea() {
    const box = document.getElementById('classroom-review');
    if (!box) return;

    hideClassroomHistory();
    closeClassroomForm();
    classroomLeftPick = { kind: 'idea' };
    renderClassroomList();
    renderClassroomActions();
    box.style.display = '';

    const room = classroomList.find(r => r.id === classroomPicked());
    box.innerHTML = `<h4 class="classroom-h">Suggest something</h4>`
                  + cmIdeaFormHtml(room, 'closeClassroomRight()');

    const t = document.getElementById('cc-idea-text');
    if (t) t.focus();
}

async function sendClassroomIdea() {
    const text   = document.getElementById('cc-idea-text');
    const status = document.getElementById('cc-idea-status');
    const say = (msg, bad) => {
        if (!status) return;
        status.style.color = bad ? '#e74c3c' : 'var(--color-gray-500)';
        status.textContent = msg;
    };
    const idea = (text && text.value || '').trim();
    if (!idea) { say('Write the idea first.', true); if (text) text.focus(); return; }

    say('Sending…');
    const bandEl = document.getElementById('cc-idea-band');
    const catEl  = document.getElementById('cc-idea-category');
    const band = (bandEl && bandEl.value) || null;
    const cat  = (catEl && catEl.value) || null;
    // Only when the panel is open on a class. From the navbar there is no
    // classroom in view, and attaching the idea to whichever one happened
    // to be selected last would file it against a class it is not about.
    const inPanel = !!document.getElementById('classroom-panel-modal').classList.contains('open');
    const room = inPanel ? classroomList.find(r => r.id === classroomPicked()) : null;

    const { error } = await sbRpc('classroom_suggest_question', {
        p_community_id: classroomCommunityId,
        p_idea:         idea,
        p_grade_band:   band,
        p_category:     cat,
        p_classroom_id: room ? room.id : null,
    }, true);

    if (error) { say(error.message || 'Could not send it.', true); return; }

    // The text is cleared only once it is safely filed. Losing what a
    // teacher wrote because the save failed is the one outcome this whole
    // screen exists to avoid.
    if (text) text.value = '';
    say('Sent — thank you. It arrives by email within a couple of seconds.');
}

function closeClassroomFlag(i) {
    const box = document.getElementById(`classroom-flag-${i}`);
    if (!box) return;
    const note = box.querySelector('textarea');
    // Only confirm when there is something to lose.
    if (note && note.value.trim() &&
        !confirm('Discard what you have written about this question?')) return;
    box.innerHTML = '';
}

async function sendClassroomFlag(i) {
    const q = classroomReviewQuestions[i];
    const room = classroomReviewRoom;
    if (!q || !room) return;

    const box    = document.getElementById(`classroom-flag-${i}`);
    const kind   = box.dataset.kind === 'suggestion' ? 'suggestion' : 'flag';
    const reason = document.getElementById(`classroom-flag-reason-${i}`).value;
    const note   = document.getElementById(`classroom-flag-note-${i}`).value.trim();
    const status = document.getElementById(`classroom-flag-status-${i}`);

    // A defect report with no words is still actionable — the question is
    // the evidence. A suggestion with no words is not: there is nothing in it
    // to act on but the fact that somebody was unhappy. Caught here as well
    // as in the RPC so it reads as a prompt rather than as an error.
    if (kind === 'suggestion' && !note) {
        status.style.color = '#e74c3c';
        status.textContent = 'Say what would make it better.';
        document.getElementById(`classroom-flag-note-${i}`).focus();
        return;
    }

    status.style.color = 'var(--color-gray-500)';
    status.textContent = 'Sending…';

    // The question AS SHOWN. The template will not reproduce it from
    // tomorrow's data, so this is the only copy that will ever exist.
    const snapshot = {
        template_id:      q.template_id,
        category:         q.category,
        grade_band:       q.grade_band,
        prompt:           q.prompt,
        choices:          q.choices,
        correct_index:    q.correct_index,
        explain:          q.explain || null,
        // A reveal-only photo is not what the class was asked about.
        chart_kind:       q.video ? 'clip'
                        : (q.image && !q.image_on_reveal) ? 'photo'
                        : (q.chart ? q.chart.kind : null),
        source_feeder_id: q.source_feeder_id,
    };

    let { error } = await sbRpc('classroom_flag_question', {
        p_community_id: classroomCommunityId,
        p_classroom_id: room.id,
        p_kind:         kind,
        p_reason:       reason,
        p_comment:      note || null,
        p_question:     snapshot,
    }, true);

    // Losing what a teacher just wrote because a migration is outstanding is
    // the worst possible outcome of adding a feature, and it happened twice
    // in real use before these fallbacks existed. There are two ways a
    // half-migrated database refuses this call, and they fail at different
    // depths:
    //
    //   PGRST202 — no p_kind on the function, so PostgREST cannot resolve the
    //              call at all. Retry against the old five-argument shape.
    //   23514    — the function accepted 'improvement' but the table's own
    //              check constraint has not been widened to allow it. Retry
    //              with the same shape and a reason the old constraint knows,
    //              which keeps the flag/suggestion distinction intact and
    //              gives up only the finer reason.
    //
    // Either way the teacher's words are what matter, and they survive.
    const missingArg = error && (error.code === 'PGRST202'
        || /p_kind|does not exist|schema cache/i.test(error.message || ''));
    const badReason  = error && (error.code === '23514'
        || /reason_check/i.test(error.message || ''));

    if (badReason && !missingArg) {
        ({ error } = await sbRpc('classroom_flag_question', {
            p_community_id: classroomCommunityId,
            p_classroom_id: room.id,
            p_kind:         kind,
            p_reason:       'other',
            p_comment:      note,
            p_question:     snapshot,
        }, true));
    } else if (missingArg) {
        ({ error } = await sbRpc('classroom_flag_question', {
            p_community_id: classroomCommunityId,
            p_classroom_id: room.id,
            p_reason:       reason === 'improvement' ? 'other' : reason,
            p_comment:      (kind === 'suggestion' ? 'Suggestion: ' : '') + note,
            p_question:     snapshot,
        }, true));
    }

    if (error) {
        status.style.color = '#e74c3c';
        status.textContent = error.message || 'Could not send that.';
        return;
    }
    const card = document.querySelector(`.classroom-review-q[data-q="${i}"]`);
    if (card) card.classList.add(kind === 'suggestion' ? 'suggested' : 'flagged');
    box.innerHTML = '<p class="classroom-muted">✓ Thanks — '
        + (kind === 'suggestion' ? 'suggestion' : 'flag')
        + ' recorded against this template.</p>';
}

function hideClassroomReview() {
    const box = document.getElementById('classroom-review');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    classroomReviewRoom = null;
    classroomReviewQuestions = [];
}

/**
 * What every Close button on the right-hand side does.
 *
 * hideClassroomReview only empties the box. That was enough when the things
 * on the right were opened from a footer, but now each of them is a LIT ROW
 * on the left, and a lit row with an empty pane beside it is a lie about
 * what you are looking at. Closing therefore falls back to the selected
 * class — the panel's resting state, and the thing a teacher came here for.
 */
function closeClassroomRight() {
    hideClassroomReview();
    hideClassroomHistory();
    classroomLeftPick = { kind: 'class' };
    classroomFormOpen = false;
    classroomEditingId = null;
    renderClassroomList();
    renderClassroomActions();
    renderClassroomForm();
}

/**
 * A teacher proposing a question that does not exist yet.
 *
 * Separate from flagging, because they are different acts: a flag says "this
 * one reads badly", a suggestion says "ask them this instead". The people
 * running lessons see what the question set is missing long before anyone
 * writing templates does, and the cost of a bad suggestion is one line in a
 * list somebody skims.
 *
 * Open to teachers, not just moderators. Gating the idea box to the people
 * who already decide what gets built would defeat the point of having one.
 */
function openClassroomSuggest() {
    const box = document.getElementById('classroom-review');
    if (!box) return;
    hideClassroomHistory();
    box.style.display = '';

    const rooms = classroomList.map(r =>
        `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');

    box.innerHTML = `
        <h4 class="classroom-h">Suggest a question</h4>
        <p class="classroom-muted">
            What would you like to be able to ask? Plain words are fine — it does
            not have to be worded as a finished question, and it does not have to
            be something the feeder data can obviously answer. Someone will read
            every one of these.
        </p>
        <textarea id="classroom-suggest-idea" rows="4" maxlength="2000"
                  placeholder="e.g. Something about which birds come when it rains. Or: the class wants to compare this month with last month."></textarea>
        <div class="classroom-form-row">
            <label>Which band is it for?
                <select id="classroom-suggest-band">
                    <option value="">Not sure / any</option>
                    <option value="k-2">K–2</option>
                    <option value="3-5">Grades 3–5</option>
                    <option value="6-8">Grades 6–8</option>
                </select>
            </label>
            <label>Which class prompted it?
                <select id="classroom-suggest-room">
                    <option value="">Not about one class</option>
                    ${rooms}
                </select>
            </label>
        </div>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="sendClassroomSuggestion()">Send suggestion</button>
            <button class="classroom-btn" onclick="closeClassroomRight()">Cancel</button>
        </div>
        <div class="classroom-status" id="classroom-suggest-status"></div>`;
    document.getElementById('classroom-suggest-idea').focus();
}

async function sendClassroomSuggestion() {
    const idea   = document.getElementById('classroom-suggest-idea').value.trim();
    const band   = document.getElementById('classroom-suggest-band').value;
    const room   = document.getElementById('classroom-suggest-room').value;
    const status = document.getElementById('classroom-suggest-status');

    if (!idea) {
        status.style.color = '#e74c3c';
        status.textContent = 'Describe the question you would like.';
        return;
    }
    status.style.color = 'var(--color-gray-500)';
    status.textContent = 'Sending…';

    const { error } = await sbRpc('classroom_suggest_question', {
        p_community_id: classroomCommunityId,
        p_idea:         idea,
        p_grade_band:   band || null,
        p_classroom_id: room || null,
    }, true);

    if (error) {
        status.style.color = '#e74c3c';
        status.textContent = error.message || 'Could not send that.';
        return;
    }
    document.getElementById('classroom-review').innerHTML = `
        <h4 class="classroom-h">Thanks</h4>
        <p class="classroom-muted">Your suggestion is on the list. If it turns into a
           question you will meet it in a lesson.</p>
        <div class="classroom-form-actions">
            <button class="classroom-btn" onclick="openClassroomSuggest()">Suggest another</button>
            <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>
        </div>`;
}

// ── Reading the feedback back ────────────────────────────────────
//
// Everyone who can open the classroom panel can read this, teachers
// included. What a teacher cannot do is resolve anything, and the server
// says so in can_resolve rather than the client re-deriving the rule and
// drifting from it.
//
// The counts by template come first because the actionable question is which
// TEMPLATE keeps drawing complaints, not which question drew one.

// Handled items are off by default — the open pile is the work. The toggle
// exists because for a TEACHER the handled ones are the whole point: they are
// the only evidence that flagging a question led anywhere.
let classroomFeedbackShowHandled = false;

function toggleClassroomFeedbackHandled() {
    classroomFeedbackShowHandled = !classroomFeedbackShowHandled;
    showClassroomFeedback();
}

async function showClassroomFeedback() {
    const box = document.getElementById('classroom-review');
    if (!box) return;
    hideClassroomHistory();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading feedback…</div>';

    const { data, error } = await sbRpc('classroom_feedback_list',
        { p_community_id: classroomCommunityId,
          p_include_resolved: classroomFeedbackShowHandled }, true);
    if (error) {
        box.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load.')}</div>`
                      + '<button class="classroom-btn" onclick="closeClassroomRight()">Close</button>';
        return;
    }

    const items = (data && data.items) || [];
    const byTemplate = (data && data.by_template) || [];

    // undefined means a database that has not had
    // setup-classroom-feedback-teachers.sql run against it yet, where the old
    // rule still holds. Falling back to it keeps this correct in the window
    // between the page shipping and the SQL being applied.
    const canResolve = (data && typeof data.can_resolve === 'boolean')
        ? data.can_resolve
        : classroomCanAssign();

    const handledToggle = `<button class="classroom-btn" onclick="toggleClassroomFeedbackHandled()">${
        classroomFeedbackShowHandled ? '← Open only' : '🗂 Show handled'}</button>`;

    if (!items.length) {
        box.innerHTML = '<div class="classroom-muted">'
                      + (classroomFeedbackShowHandled
                          ? 'Nothing here yet, handled items included.'
                          : 'No open feedback. Use "Review questions" on a class to go '
                          + 'through a lesson and flag anything that reads badly.')
                      + '</div>'
                      + `<div class="classroom-form-actions">${handledToggle}`
                      + '<button class="classroom-btn" onclick="closeClassroomRight()">Close</button></div>';
        return;
    }

    const REASONS = { unclear: 'unclear', wrong: 'answer looks wrong',
                      too_hard: 'too hard', too_easy: 'too easy',
                      bad_visual: 'photo or chart', improvement: 'would be better',
                      idea: 'new question idea', other: 'other' };

    // Kept so the bulk action acts on exactly what is on screen — and only on
    // what is still open, since "show handled" puts already-resolved items on
    // screen too and re-resolving one would overwrite the note explaining
    // what was done about it the first time.
    classroomFeedbackShown = items.filter(f => !f.resolved_at).map(f => f.id);

    box.innerHTML = `
        <h4 class="classroom-h">Question feedback (${items.length}${
            classroomFeedbackShowHandled ? '' : ' open'})</h4>
        <p class="classroom-muted">Most flagged templates:
            ${byTemplate.slice(0, 5).map(t => `<code>${esc(t.template_id)}</code> ×${t.n}`).join(' · ')}</p>
        ${canResolve ? '' : '<p class="classroom-muted">You can read these and add '
            + 'your own. Marking them handled is for whoever runs the community.</p>'}
        <div class="classroom-form-actions">
            ${canResolve && classroomFeedbackShown.length
                ? `<button class="classroom-btn" onclick="resolveAllClassroomFeedback()">
                ✓ Mark all ${classroomFeedbackShown.length} as addressed</button>` : ''}
            ${handledToggle}
        </div>
        <div class="classroom-review-list">
        ${items.map(f => `
            <div class="classroom-review-q">
                <div class="classroom-review-head">
                    <span class="classroom-pill${f.kind === 'suggestion' ? ' partner' : ''}">${
                        f.kind === 'suggestion' ? 'suggestion' : esc(REASONS[f.reason] || f.reason)}</span>
                    ${f.kind === 'suggestion' ? ''
                        : `<code class="classroom-review-tid">${esc(f.template_id)}</code>`}
                    <span class="classroom-muted">${esc(f.grade_band || '')}
                        ${f.classroom_name ? '· ' + esc(f.classroom_name) : ''}
                        · ${esc(f.by_label)}</span>
                </div>
                <p class="classroom-review-prompt">${esc(f.prompt)}</p>
                ${f.comment ? `<p class="classroom-flag-note">“${esc(f.comment)}”</p>` : ''}
                ${f.resolved_at
                    ? `<p class="classroom-muted">✓ Handled ${esc(
                        new Date(f.resolved_at).toLocaleDateString(undefined,
                            { month: 'short', day: 'numeric' }))}${
                        f.resolved_note ? ` — ${esc(f.resolved_note)}` : ''}</p>`
                    : ''}
                ${canResolve && !f.resolved_at
                    ? `<button class="classroom-btn" onclick="resolveClassroomFeedback('${esc(f.id)}')">Mark handled</button>`
                    : ''}
            </div>`).join('')}
        </div>
        <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>`;
}

// The ids currently on screen, so "mark all" cannot quietly resolve
// something that arrived after this list was drawn.
let classroomFeedbackShown = [];

/**
 * Clear the whole visible list in one call, with a note saying what was done.
 *
 * The note is the point. "Addressed" with no record of HOW is barely better
 * than deleting the row: the next person to read that template has no idea a
 * teacher once complained about it, or what changed in response. It is also
 * what makes "show me what is new since last time" a question the database
 * can answer, which is the whole reason a daily classroom needs this.
 */
async function resolveAllClassroomFeedback() {
    const ids = classroomFeedbackShown.slice();
    if (!ids.length) return;

    const note = window.prompt(
        `Mark all ${ids.length} as addressed.\n\n`
        + 'What was done about them? (recorded against every one)', '');
    // Cancel means cancel. An empty string means they pressed OK with nothing
    // typed, which is a deliberate "no note" rather than a mistake.
    if (note === null) return;

    const { data, error } = await sbRpc('classroom_feedback_resolve_bulk',
        { p_ids: ids, p_note: note.trim() || null }, true);

    if (error) {
        showToast('Could not mark them: ' + (error.message || 'unknown error'));
        return;
    }
    showToast(`${data == null ? ids.length : data} marked as addressed.`);
    await showClassroomFeedback();
}

async function resolveClassroomFeedback(id) {
    const { error } = await sbRpc('classroom_feedback_resolve', { p_id: id }, true);
    if (error) { showToast('Error: ' + (error.message || 'could not update')); return; }
    showClassroomFeedback();
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
    if (!classroomFormOpen) { box.innerHTML = ''; return; }
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
                <select id="classroom-grade-band" onchange="renderClassroomPickChecks(); renderClassroomStandardPicker()">
                    <option value="k-2"${editing?.grade_band === 'k-2' ? ' selected' : ''}>K–2 — pictures and counting</option>
                    <option value="3-5"${editing?.grade_band === '3-5' ? ' selected' : ''}>Grades 3–5 — charts and averages</option>
                    <option value="6-8"${editing?.grade_band === '6-8' ? ' selected' : ''}>Grades 6–8 — percents and trends</option>
                </select>
            </label>

            <label class="classroom-field">
                <span>Where the data comes from</span>
                <select id="classroom-question-scope">
                    <option value="home"${(editing?.question_scope || 'home') === 'home' ? ' selected' : ''}>
                        Our feeder — fall back to a partner when it is quiet</option>
                    <option value="community"${editing?.question_scope === 'community' ? ' selected' : ''}>
                        Every feeder in this community — pooled</option>
                </select>
            </label>

            <label class="classroom-field">
                <span>How many questions a session</span>
                <select id="classroom-quiz-size" onchange="updateClassroomPickCount()">
                    ${[1, 2, 3, 5, 6, 8, 10, 12].map(n => `
                        <option value="${n}"${(editing?.questions_per_session || 8) === n ? ' selected' : ''}>
                            ${n} question${n === 1 ? '' : 's'}${
                                n <= 2 ? ' — a daily warm-up'
                              : n >= 10 ? ' — a long quiz'
                              : n >= 6 ? ' — a weekly quiz' : ''}
                        </option>`).join('')}
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
        <details class="classroom-details" ontoggle="if (this.open) classroomPickLoadPreview()">
            <summary>Which questions this class can ask
                <span class="classroom-pill" id="classroom-picks-count"></span></summary>
            <p class="classroom-muted">
                Leave this alone and the class can be asked anything that suits its grade
                band — that is the normal way to run it. Tick a subject down to what you
                are teaching, and only those come up.
            </p>
            <div class="classroom-pick-actions">
                <button type="button" class="classroom-btn" onclick="classroomPickAll(true)">Select all</button>
                <button type="button" class="classroom-btn" onclick="classroomPickAll(false)">Select none</button>
            </div>
            <div id="classroom-std-pick-host"></div>
            <div id="classroom-picks" class="classroom-picks"></div>
            <p id="classroom-picks-warn" class="classroom-muted"></p>
        </details>
        <div class="classroom-form-actions">
            <button class="classroom-btn-primary" onclick="saveClassroom()">
                ${editing ? 'Save changes' : 'Create classroom'}
            </button>
            ${editing ? '<button class="classroom-btn" onclick="cancelClassroomEdit()">Cancel</button>' : ''}
        </div>
        <div id="classroom-form-status" class="classroom-status"></div>`;

    // The classroom being edited decides the starting picks; a brand-new one
    // starts unrestricted, which is the default a teacher should not have to
    // opt into.
    classroomPicks = (editing && Array.isArray(editing.template_picks)
                      && editing.template_picks.length)
        ? new Set(editing.template_picks)
        : null;

    renderClassroomPartnerChecks();
    renderClassroomPickChecks();
    renderClassroomStandardPicker();
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

// ── Choosing which questions a classroom may ask ─────────
//
// The default — ask anything the week can carry — is right for a teacher who
// wants to open the panel and press Start, and it stays the default. It is
// just not the only thing a teacher wants. Covering telling-the-time this
// fortnight means wanting the clock question every day. Not having taught
// percentages yet means wanting them off the board. An art room wants the
// art and identification questions and none of the arithmetic.

const CLASSROOM_CATEGORY_LABELS = {
    counting:       'Counting',
    math:           'Math',
    comparison:     'Comparing',
    analysis:       'Reading data',
    prediction:     'Predicting',
    time:           'Time',
    science:        'Science',
    geography:      'Geography',
    history:        'History',
    language:       'Language',
    art:            'Art',
    music:          'Music',
    identification: 'Identifying birds',
    puzzle:         'Puzzles',
    wonder:         'Fun facts',
    // Not a template category and deliberately not in CLASSROOM_CATEGORY_ORDER:
    // it labels a teacher's own questions wherever a category is shown, and
    // must never appear as something to pick in a template or challenge list.
    teacher:        'Your questions',
};

// Teaching order rather than alphabetical: a teacher scanning this list is
// looking for a subject, and subjects have a conventional order on a
// timetable that "Art, Comparing, Counting…" does not match.
const CLASSROOM_CATEGORY_ORDER = [
    'counting', 'math', 'comparison', 'analysis', 'prediction', 'time',
    'science', 'geography', 'history', 'language', 'art', 'music',
    'identification', 'puzzle', 'wonder',
];

function cmCatLabel(cat) {
    return CLASSROOM_CATEGORY_LABELS[cat] || cat;
}

function classroomTemplatesForBand(band) {
    return CLASSROOM_TEMPLATES.filter(t => t.bands.includes(band));
}

// The band currently chosen in the FORM, which is not necessarily the band
// the classroom is saved with — a teacher moving a class up a year expects
// the picker to follow the dropdown, not the database.
function classroomFormBand() {
    return document.getElementById('classroom-grade-band')?.value || 'k-2';
}

/**
 * Turn "all of them" into an explicit set.
 *
 * Across EVERY band, not just the one on screen. A teacher untick in K-2
 * must not silently drop the 3-5 questions they never looked at — picks are
 * one list on the classroom, and the picker is a window onto it.
 */
function classroomPickMaterialise() {
    if (!classroomPicks) classroomPicks = new Set(CLASSROOM_TEMPLATES.map(t => t.id));
    return classroomPicks;
}

function classroomPickOn(id) {
    return !classroomPicks || classroomPicks.has(id);
}

function classroomPickOne(id, on) {
    const s = classroomPickMaterialise();
    if (on) s.add(id); else s.delete(id);
    syncClassroomPickBoxes();
}

function classroomPickCategory(cat, on) {
    const s = classroomPickMaterialise();
    classroomTemplatesForBand(classroomFormBand())
        .filter(t => t.category === cat)
        .forEach(t => (on ? s.add(t.id) : s.delete(t.id)));
    syncClassroomPickBoxes();
}

/**
 * Every question in this band on, or every one off.
 *
 * Turning everything on collapses back to the "no restriction" state when it
 * leaves nothing excluded anywhere, so a teacher who experiments and then
 * changes their mind ends up with a classroom that is genuinely unrestricted
 * rather than one carrying a frozen list of today's templates — which would
 * quietly never show them a question added next month.
 */
// ── Picking questions by benchmark ──────────────────────────────────
//
// A teacher planning a week does not think "I want the comparison
// category". They think "we are on MA.3.DP.1.2 this week". This turns the
// second sentence into the first.
//
// NO SCHEMA CHANGE, deliberately. A classroom's picks are already stored
// as a set of template ids, so choosing a benchmark just ticks the boxes
// that cover it and the existing save path carries it. Adding a standards
// column to classroom_challenges would have meant another argument on
// classroom_challenge_create — the overload that took the challenge RPCs
// down with PGRST203 — for a feature that needs no new storage at all.
//
// It is a FILTER, not a mode: the ticks it sets are ordinary ticks a
// teacher can then adjust. Nothing anywhere records that a selection came
// from a benchmark, which is right, because what the class can be asked is
// the set of questions and not the reason somebody chose them.

/**
 * Fill the picker host, once the form is actually on the page.
 *
 * ⚠ IT CANNOT BE RENDERED INLINE WITH THE FORM. The list of benchmarks
 * depends on the grade band, and classroomFormBand() reads the band
 * <select> out of the DOM — which does not exist yet while the form's own
 * HTML string is still being built. Inline, it silently fell back to the
 * 'k-2' default and offered a 3-5 class a list of K-2 benchmarks, with
 * nothing on screen to say so.
 *
 * Called after the form is written, and again whenever the band changes,
 * exactly as renderClassroomPickChecks is.
 */
function renderClassroomStandardPicker() {
    const host = document.getElementById('classroom-std-pick-host');
    if (host) host.innerHTML = cmStandardPickerHtml();
}

function cmStandardPickerHtml() {
    if (typeof CLASSROOM_STANDARDS === 'undefined'
     || typeof CLASSROOM_TEMPLATE_STANDARDS === 'undefined') return '';

    const band = classroomFormBand();
    // Only benchmarks this band can actually be asked about. Offering a
    // 6-8 code to a K-2 class produces a selection of nothing, which reads
    // as a broken control rather than as an empty result.
    const codes = Object.keys(CLASSROOM_STANDARDS).filter(c => {
        const s = CLASSROOM_STANDARDS[c];
        if (!s.bands.includes(band)) return false;
        return classroomTemplatesForStandards([c])
            .some(id => {
                const t = CLASSROOM_TEMPLATES.find(x => x.id === id);
                return t && t.bands.includes(band);
            });
    });
    if (!codes.length) return '';

    const bySubject = new Map();
    codes.forEach(c => {
        const subj = CLASSROOM_STANDARDS[c].subject;
        if (!bySubject.has(subj)) bySubject.set(subj, []);
        bySubject.get(subj).push(c);
    });

    return `
        <div class="cc-std-pick">
            <label>
                <span>Or pick by Florida standard</span>
                <select id="classroom-std-pick" onchange="classroomPickByStandard(this.value)">
                    <option value="">— choose a benchmark —</option>
                    ${[...bySubject.entries()].map(([subj, cs]) => `
                        <optgroup label="${esc(subj)}">
                            ${cs.map(c => `<option value="${esc(c)}">${esc(c)} — ${
                                esc(CLASSROOM_STANDARDS[c].text.slice(0, 72))}${
                                CLASSROOM_STANDARDS[c].text.length > 72 ? '…' : ''}</option>`).join('')}
                        </optgroup>`).join('')}
                </select>
            </label>
            <p class="classroom-muted" id="classroom-std-pick-note">
                Ticks every question that exercises that benchmark, and unticks the rest.
                Adjust the boxes afterwards as you like.
            </p>
        </div>`;
}

function classroomPickByStandard(code) {
    const note = document.getElementById('classroom-std-pick-note');
    if (!code) return;

    const band = classroomFormBand();
    const ids = classroomTemplatesForStandards([code]).filter(id => {
        const t = CLASSROOM_TEMPLATES.find(x => x.id === id);
        return t && t.bands.includes(band);
    });

    // Should not happen — the dropdown only offers benchmarks with a
    // question in this band — but a selection that silently empties the
    // picker would be the worst possible outcome of clicking it.
    if (!ids.length) {
        if (note) note.textContent = 'Nothing in this grade band covers that benchmark.';
        return;
    }

    classroomPicks = new Set(ids);
    syncClassroomPickBoxes();

    if (note) {
        const s = CLASSROOM_STANDARDS[code];
        note.textContent = `${ids.length} question${ids.length === 1 ? '' : 's'} `
                         + `selected for ${code}${s ? ' — ' + s.text : ''}`;
    }
}

function classroomPickAll(on) {
    const band = classroomFormBand();
    const s = classroomPickMaterialise();
    classroomTemplatesForBand(band).forEach(t => (on ? s.add(t.id) : s.delete(t.id)));
    if (on && s.size >= CLASSROOM_TEMPLATES.length) classroomPicks = null;
    syncClassroomPickBoxes();
}

/**
 * Push the state onto the checkboxes already on screen.
 *
 * Rather than re-rendering: with fifty-odd boxes open, rebuilding the markup
 * on every tick throws away the scroll position, and a teacher working down
 * a long list gets bounced to the top on each one.
 */
function classroomSyncPickGroups() {
    const band = classroomFormBand();
    document.querySelectorAll('#classroom-picks .classroom-pick-group').forEach(g => {
        const cat = g.dataset.cat;
        const ts  = classroomTemplatesForBand(band).filter(t => t.category === cat);
        const on  = ts.filter(t => classroomPickOn(t.id)).length;
        const head = g.querySelector('input.classroom-pick-cat');
        if (head) {
            head.checked = on === ts.length;
            head.indeterminate = on > 0 && on < ts.length;
        }
        const tally = g.querySelector('.classroom-pick-tally');
        if (tally) tally.textContent = `${on}/${ts.length}`;
    });
}

function syncClassroomPickBoxes() {
    document.querySelectorAll('#classroom-picks input.classroom-pick-one')
        .forEach(el => { el.checked = classroomPickOn(el.value); });
    classroomSyncPickGroups();
    updateClassroomPickCount();
}

/**
 * This classroom's real feeder data, kept so the picker can say how many
 * questions a selection ACTUALLY produces rather than how many were ticked.
 *
 * Loaded lazily, when the picker is first opened, because it costs a query
 * and most edits never touch the picker at all.
 */
let classroomPickPreview = { roomId: null, data: null, loading: false };

async function classroomPickLoadPreview() {
    const editing = classroomEditingId
        ? classroomList.find(r => r.id === classroomEditingId)
        : null;
    // A classroom being created has no id and no feeder history to build
    // from, so there is nothing truthful to say yet.
    if (!editing || !editing.home_feeder_id) return;
    if (classroomPickPreview.loading || classroomPickPreview.roomId === editing.id) return;

    const want = editing.id;
    classroomPickPreview = { roomId: null, data: null, loading: true };
    try {
        const data = await loadClassroomData(editing);
        // The teacher may have closed this editor and opened another one
        // while the query was in flight; landing that data on the new room
        // would have the picker count against the wrong feeder.
        if (classroomEditingId !== want) {
            classroomPickPreview = { roomId: null, data: null, loading: false };
            return;
        }
        classroomPickPreview = { roomId: want, data, loading: false };
    } catch (e) {
        // Never fatal: without it the picker falls back to counting types,
        // which is what it did before and is still better than nothing.
        console.warn('[classroom] could not load data for the question picker:', e);
        classroomPickPreview = { roomId: null, data: null, loading: false };
        return;
    }
    updateClassroomPickCount();
}

/**
 * How many questions the current selection really builds this week.
 *
 * Null when that cannot be known — a new classroom, or the data not loaded.
 *
 * Worth the trouble because counting ticks is misleading in exactly the case
 * the warning exists for. The Art Room ticked nine art and identification
 * types for an eight-question session, which passed the tick count without a
 * murmur, and then built four: five of the nine had nothing in that week's
 * data to stand on. A teacher finding that out in front of a class is the
 * thing this is supposed to prevent.
 */
function classroomPickBuildCount() {
    if (!classroomEditingId || classroomPickPreview.roomId !== classroomEditingId) return null;
    const editing = classroomList.find(r => r.id === classroomEditingId);
    if (!editing || !classroomPickPreview.data) return null;

    const shadow = {
        ...editing,
        grade_band:     classroomFormBand(),
        template_picks: classroomPicks ? [...classroomPicks] : null,
    };
    try {
        return buildClassroomQuestions(shadow, classroomPickPreview.data, { all: true }).built;
    } catch (e) {
        return null;
    }
}

/**
 * The line on the summary, and the warning under the list.
 *
 * The warning is the part that earns its place: picking four question types
 * for an eight-question session is not an error, but it does mean the lesson
 * repeats or runs short, and a teacher should find that out here rather than
 * in front of a class.
 */
function updateClassroomPickCount() {
    const band = classroomFormBand();
    const list = classroomTemplatesForBand(band);
    const on   = list.filter(t => classroomPickOn(t.id)).length;
    const size = parseInt(document.getElementById('classroom-quiz-size')?.value, 10) || 8;
    const an   = n => (n === 8 || n === 11 || n === 18) ? 'an' : 'a';

    const badge = document.getElementById('classroom-picks-count');
    if (badge) {
        badge.textContent = on === list.length
            ? `all ${list.length}`
            : `${on} of ${list.length}`;
    }

    const warn = document.getElementById('classroom-picks-warn');
    if (!warn) return;

    const real = classroomPickBuildCount();

    if (on === 0) {
        warn.textContent = 'Nothing is ticked, so this class will ask anything it can — '
                         + 'unticking everything is the same as choosing everything.';
        warn.className = 'classroom-muted';
    } else if (real != null && real < size) {
        // The honest number, and why it differs from the tick count.
        warn.textContent = `These build ${real} question${real === 1 ? '' : 's'} from this `
                         + `week's data, for ${an(size)} ${size}-question session. `
                         + (real < on
                             ? `${on - real} of the ${on} ticked have nothing to stand on `
                             + 'this week. Tick more, or expect a shorter lesson.'
                             : 'Tick more, or expect a shorter lesson.');
        warn.className = 'classroom-warn';
    } else if (real != null) {
        warn.textContent = `These build ${real} question${real === 1 ? '' : 's'} from this `
                         + `week's data — enough for ${an(size)} ${size}-question session. `
                         + 'The number moves with what the birds actually do.';
        warn.className = 'classroom-muted';
    } else if (on < size) {
        warn.textContent = `Only ${on} question type${on === 1 ? '' : 's'} ticked for `
                         + `${an(size)} ${size}-question session. Questions will repeat, or `
                         + 'the lesson will be shorter than that.';
        warn.className = 'classroom-warn';
    } else {
        warn.textContent = 'How many of these actually come up depends on what the birds '
                         + 'did that week — a question with no data to stand on sits out.';
        warn.className = 'classroom-muted';
    }
}

function renderClassroomPickChecks() {
    const box = document.getElementById('classroom-picks');
    if (!box) return;

    const band = classroomFormBand();
    const list = classroomTemplatesForBand(band);

    const groups = new Map();
    for (const t of list) {
        if (!groups.has(t.category)) groups.set(t.category, []);
        groups.get(t.category).push(t);
    }

    const ordered = [...groups.keys()].sort((a, b) => {
        const ia = CLASSROOM_CATEGORY_ORDER.indexOf(a);
        const ib = CLASSROOM_CATEGORY_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    box.innerHTML = ordered.map(cat => {
        const ts = groups.get(cat);
        return `
        <div class="classroom-pick-group" data-cat="${esc(cat)}">
            <div class="classroom-pick-head">
                <label class="classroom-check">
                    <input type="checkbox" class="classroom-pick-cat"
                           onchange="classroomPickCategory('${escJs(cat)}', this.checked)">
                    <strong>${esc(cmCatLabel(cat))}</strong>
                </label>
                <span class="classroom-pick-tally classroom-muted"></span>
            </div>
            <div class="classroom-pick-items">
                ${ts.map(t => `
                    <label class="classroom-check">
                        <input type="checkbox" class="classroom-pick-one" value="${esc(t.id)}"
                               onchange="classroomPickOne('${escJs(t.id)}', this.checked)">
                        ${esc(t.title)}
                    </label>`).join('')}
            </div>
        </div>`;
    }).join('') || '<span class="classroom-muted">No questions for this grade band.</span>';

    syncClassroomPickBoxes();
}

/**
 * Store the question choice, if it has moved.
 *
 * A full set is stored as "no restriction" rather than as a list of every id,
 * so a classroom that has never been curated — or has been reset — keeps
 * receiving templates added after today. Freezing today's list onto every
 * classroom would make every future question invisible to all of them.
 */
async function saveClassroomTemplatePicks(roomId, say) {
    if (!roomId) return;

    const all = !classroomPicks || classroomPicks.size >= CLASSROOM_TEMPLATES.length;
    const ids = all ? [] : [...classroomPicks];

    const room   = classroomList.find(r => r.id === roomId);
    const before = (room && Array.isArray(room.template_picks)) ? room.template_picks : [];
    if (before.length === ids.length && before.every(id => ids.includes(id))) return;

    const { error } = await sbRpc('classroom_set_templates',
        { p_classroom_id: roomId, p_template_ids: ids }, true);
    if (!error) return;

    // PGRST202 is "no function by that name". It means the page has shipped
    // ahead of its migration — worth saying out loud, because the generic
    // message sends whoever sees it hunting for a bug in the classroom
    // rather than for an unrun .sql file.
    say(error.code === 'PGRST202'
        ? 'Saved, but the question choice needs setup-classroom-picks.sql '
        + 'to be run on the database first.'
        : 'Saved, but the question choice did not stick: '
        + (error.message || 'unknown error'), false);
}

function editClassroom(id) {
    classroomEditingId = id;
    classroomFormOpen = true;
    // Editing a class also makes it the selected one, or the form would be
    // editing something other than what the pane above it describes.
    classroomSelectedId = id;
    hideClassroomReview();
    hideClassroomHistory();
    renderClassroomList();
    renderClassroomActions();
    renderClassroomForm();
    document.getElementById('classroom-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelClassroomEdit() {
    classroomEditingId = null;
    classroomFormOpen = false;
    // Cancelling "New class" has to put the highlight back on a class as
    // well as close the form, or the left column goes on claiming it is
    // showing a form that is no longer there.
    if (classroomLeftPick.kind === 'new') classroomLeftPick = { kind: 'class' };
    renderClassroomList();
    renderClassroomActions();
    renderClassroomForm();
}

/**
 * Store the session size, if it has moved.
 *
 * Its own RPC rather than a field on classroom_update: adding a defaulted
 * argument there would leave two overloads of the same name and make
 * PostgREST's named-argument calls ambiguous. Failure is reported but does
 * not fail the save - a classroom whose name was updated and whose quiz size
 * was not is a far better outcome than one that refused the whole edit.
 */
async function saveClassroomQuizSize(roomId, size, say) {
    if (!roomId || !Number.isFinite(size)) return;
    const room = classroomList.find(r => r.id === roomId);
    if (room && (room.questions_per_session || 8) === size) return;

    const { error } = await sbRpc('classroom_set_quiz_size',
        { p_classroom_id: roomId, p_n: size }, true);
    if (error) say('Saved, but the question count did not stick: '
                   + (error.message || 'unknown error'), false);
}

async function saveClassroom() {
    const name   = document.getElementById('classroom-name').value.trim();
    const home   = document.getElementById('classroom-home-feeder').value;
    const band   = document.getElementById('classroom-grade-band').value;
    const scope  = document.getElementById('classroom-question-scope')?.value || 'home';
    const size   = parseInt(document.getElementById('classroom-quiz-size')?.value, 10);
    const status = document.getElementById('classroom-form-status');
    const say = (msg, ok) => {
        status.textContent = msg;
        status.style.color = ok ? '#2eaa4f' : '#e74c3c';
    };

    if (!name) { say('Give the class a name.', false); return; }

    // A home feeder is only compulsory when the lessons come FROM it. A
    // class pooling the whole community may have no feeder of its own —
    // that is the case this option exists for, a school signing up in
    // January with nothing on the wall yet.
    if (!home && scope !== 'community') {
        say('Choose the feeder this class watches, or pool the community instead.', false);
        return;
    }

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
            p_home_feeder_id:  home || null,
            p_grade_band:      band,
            p_question_scope:  scope,
            p_teacher_user_id: teacher || null,
        }, true);
        if (error) { say(error.message || 'Could not save.', false); return; }
    } else {
        const { data, error } = await sbRpc('classroom_create', {
            p_community_id:   classroomCommunityId,
            p_name:           name,
            p_home_feeder_id: home || null,
            p_grade_band:     band,
            p_question_scope: scope,
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
        await saveClassroomQuizSize(roomId, size, say);
        await saveClassroomTemplatePicks(roomId, say);
    }

    // A class just created should become the selected one — otherwise you
    // make it and the right-hand pane goes on describing a different class.
    if (roomId) classroomSelectedId = roomId;
    classroomEditingId = null;
    classroomFormOpen = false;
    // ...and the left column should land on it too, rather than leaving
    // "New class" lit over the panel for the class you just made.
    classroomLeftPick = { kind: 'class' };
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
    // NOT an early return on a missing box. This function also SCORES
    // predictions, and only the selected class has a box now that the panel
    // is two panes — bailing here would mean a week-long prediction made in
    // one class never settles unless somebody happens to have that class
    // selected when the panel opens. Showing is optional; resolving is not.
    const box = document.getElementById(`classroom-pending-${room.id}`);
    const show = html => { if (box) box.innerHTML = html; };

    const { data, error } = await sbRpc('classroom_pending_predictions',
        { p_classroom_id: room.id }, true);
    if (error || !Array.isArray(data) || !data.length) { show(''); return; }

    const now = Date.now();
    const lines = [];

    // The same prediction asked in two sessions produces two identical
    // waiting rows, which reads as a bug rather than as two classes having
    // each made a guess. Counted instead.
    const waitingCounts = new Map();

    for (const p of data) {
        const ready = p.resolve_after && new Date(p.resolve_after).getTime() <= now;
        if (!ready) {
            waitingCounts.set(p.prompt, (waitingCounts.get(p.prompt) || 0) + 1);
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

    // Waiting rows last, and one per distinct question: a resolved result is
    // news, a pending one is just a reminder.
    for (const [prompt, n] of waitingCounts) {
        lines.push(`<div class="classroom-pending-row">⏳ Waiting to check: `
                 + `${esc(prompt)}`
                 + (n > 1 ? ` <span class="classroom-muted">(asked ${n} times)</span>` : '')
                 + '</div>');
    }

    show(lines.join(''));
}

// ── Session history ──────────────────────────────────────

// ── Previous lessons ─────────────────────────────────────────────
//
// Was "Results", and was a flat wall: ten lessons expanded at once, every
// question listed with a tick or a cross and nothing else. Two problems with
// that. Thirty lessons in it is unreadable, and — worse — it showed that a
// question was MISSED without showing what the class actually said, which is
// the only part a teacher can teach from. "Wrong" is not a finding; "they
// said Tuesday and it was Thursday" is.
//
// Now a tree, built from native <details> rather than click handlers and
// state: lesson → right/wrong → question → the question itself. The browser
// handles the toggling, the keyboard and the screen reader for free.
//
// MISSED OPENS BY DEFAULT and Correct does not. Three expands to reach the
// thing you came for is too many, and nobody opens Results to re-read what
// the class already knows.

// What Previous lessons is currently showing, so the exports match the screen
// rather than re-fetching and possibly disagreeing with it.
let classroomHistoryShown = null;

// ── The school challenge ─────────────────────────────────────────
//
// A moderator names a week; every class teaches its normal lessons; the
// board compares them. Nothing a teacher has to opt into on the day —
// a challenge is a window of dates, not a kind of lesson, so a class is
// in it by having taught.
//
// The board groups by GRADE BAND and does not rank across bands. A K-2
// class counts dots; a 6-8 class reads a distribution and predicts.
// Ranking those together would put the six-year-olds top every week and
// the oldest class would stop entering, which is the one outcome that
// kills a scoreboard.

/** Monday and Friday of the current week, as yyyy-mm-dd. */
function cmThisSchoolWeek() {
    const now = new Date();
    const dow = now.getDay();                 // 0 Sun … 6 Sat
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((dow + 6) % 7));
    // On a Saturday or Sunday "this school week" is the one that has just
    // finished, so the form opened on a weekend offered a window already in
    // the past and the challenge appeared marked "finished" the moment it
    // was created. Nobody sets up a contest for last Tuesday: at the weekend
    // the week being planned is the one ahead.
    if (dow === 0 || dow === 6) mon.setDate(mon.getDate() + 7);
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                   + `-${String(d.getDate()).padStart(2, '0')}`;
    return { from: iso(mon), to: iso(fri) };
}

function cmDateLabel(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric' });
}

async function showClassroomChallenge() {
    const box = document.getElementById('classroom-review');
    if (!box) return;
    hideClassroomHistory();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading the challenge…</div>';

    const { data, error } = await sbRpc('classroom_challenge_list',
        { p_community_id: classroomCommunityId }, true);
    if (error) {
        const missing = error.code === 'PGRST202'
            || /could not find the function|does not exist/i.test(error.message || '');
        box.innerHTML = missing
            ? '<div class="classroom-muted">Challenges are not set up on this site yet.</div>'
            : `<div class="classroom-error">${esc(error.message || 'Could not load.')}</div>`;
        box.innerHTML += '<button class="classroom-btn" onclick="closeClassroomRight()">Close</button>';
        return;
    }

    const items  = (data && data.items) || [];
    const manage = !!(data && data.can_manage);
    const live   = items.find(c => c.is_current) || items[0] || null;

    let board = '';
    if (live) {
        const { data: sd, error: se } = await sbRpc('classroom_challenge_standings',
            { p_id: live.id }, true);
        board = se
            ? `<div class="classroom-error">${esc(se.message || 'Could not load the scoreboard.')}</div>`
            : cmChallengeBoardHtml((sd && sd.standings) || []);
    }

    // Who is in it. A limited challenge has to say so on the board itself:
    // a class that is simply not taking part looks exactly like a class that
    // has taught nothing all week, and the teacher of that class is the one
    // person guaranteed to notice.
    const inIt = (live && Array.isArray(live.classroom_ids) && live.classroom_ids.length)
        ? live.classroom_ids
              .map(id => (classroomList.find(r => r.id === id) || {}).name)
              .filter(Boolean)
        : null;

    box.innerHTML = `
        <div class="classroom-actions-head">
            <h4 class="classroom-h">🏆 ${live ? esc(live.name) : 'School challenge'}</h4>
            ${(live && manage) ? `<button class="classroom-btn-danger"
                    onclick="deleteClassroomChallenge('${escJs(live.id)}','${escJs(live.name)}')">
                    🗑 Clear this challenge</button>` : ''}
        </div>
        ${live
            ? `<p class="classroom-muted">${esc(cmDateLabel(live.starts_on))} – ${esc(cmDateLabel(live.ends_on))}${
                  live.is_current ? ' · running now' : (live.is_over ? ' · finished' : ' · not started yet')}
                 · ${inIt ? esc(inIt.join(', ')) : 'every class'}
                 · ${esc(cmChallengeQuestionLabel(live))}</p>`
            : '<p class="classroom-muted">No challenge set. Every class still has its own results under '
              + 'Previous lessons — a challenge just puts them side by side for a week.</p>'}
        ${board}
        ${manage ? cmChallengeAdminHtml(items, live) : ''}
        <button class="classroom-btn" onclick="closeClassroomRight()">Close</button>`;
}

/**
 * The board itself, grouped by band.
 *
 * Medals inside each band, not across the school. Three bands means three
 * winners, which is also the honest answer: they did not sit the same paper.
 */
function cmChallengeBoardHtml(rows) {
    if (!rows.length) {
        return '<p class="classroom-muted">No lessons taught in this window yet. '
             + 'The board fills in as classes teach.</p>';
    }
    const bands = [];
    for (const r of rows) {
        let g = bands.find(b => b.band === r.grade_band);
        if (!g) { g = { band: r.grade_band, rows: [] }; bands.push(g); }
        g.rows.push(r);
    }
    const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;

    return bands.map(g => {
        // A medal needs somebody to have been beaten. A school with one class
        // per band would otherwise award three golds and no contest, which on
        // a screen in front of the whole school reads as a participation
        // prize and makes the board hard to take seriously. Seen on real
        // data the first time this was pointed at three classes.
        const contested = g.rows.length > 1;
        return `
        <div class="cc-board">
            <div class="cc-board-band">${esc(GRADE_BAND_LABELS[g.band] || g.band)}${
                contested ? '' : ' <span class="classroom-muted">— only class in this band</span>'}</div>
            ${g.rows.map((r, i) => `
                <div class="cc-board-row${contested && i === 0 ? ' lead' : ''}">
                    <span class="cc-board-rank">${contested ? medal(i) : '•'}</span>
                    <span class="cc-board-name">${esc(r.name)}
                        <span class="classroom-muted">${esc(r.teacher_label || '')}</span></span>
                    <span class="cc-board-pct">${r.pct != null ? r.pct + '%' : '—'}</span>
                    <span class="cc-board-sub classroom-muted">${r.correct}/${r.answered}
                        · ${r.lessons} lesson${Number(r.lessons) === 1 ? '' : 's'}${
                        Number(r.waiting) ? ` · ${r.waiting} waiting` : ''}</span>
                </div>`).join('')}
        </div>`;
    }).join('');
}

/** Moderator controls: start one, or clear the one that is running. */
/**
 * The moderator's half: start one, and choose who is in it.
 *
 * The summary used to read "Set a challenge" whether or not one was running,
 * and the only way to clear the running one was to open it and find a button
 * under a heading about starting. Reported as exactly that: "it wasn't
 * obvious to me that I need to click Set a challenge to clear one that was
 * already existing." Clearing now has its own button beside the title, where
 * the thing it acts on is, and this disclosure says which of its two jobs it
 * is doing.
 */
/**
 * Which questions a challenge is about.
 *
 * Three modes rather than one list, because there are three intentions and
 * flattening them loses the useful one. "Randomize" is the default and means
 * no restriction at all — every class keeps its own curated list, which is
 * what a challenge meant before it could say otherwise.
 *
 * "By subject" is deliberately NOT stored as the templates in those
 * categories: named by subject, a question written next month joins the
 * challenge without anybody editing it.
 */
function cmChallengeQuestionsHtml() {
    const cats = [...new Set(CLASSROOM_TEMPLATES.map(t => t.category))]
        .map(c => ({ id: c, label: CLASSROOM_CATEGORY_LABELS[c] || c,
                     n: CLASSROOM_TEMPLATES.filter(t => t.category === c).length }))
        .sort((a, b) => a.label.localeCompare(b.label));

    const catBoxes = cats.map(c => `
        <label class="cc-chip">
            <input type="checkbox" class="cc-chal-cat" value="${esc(c.id)}">
            <span>${esc(c.label)}</span><span class="classroom-row-meta">${c.n}</span>
        </label>`).join('');

    // Grouped by subject, because fifty-odd question titles in one column is
    // a list nobody reads to the end of. Not filtered by band: a challenge
    // spans the school, and the band filter happens at lesson time anyway.
    const tmplGroups = cats.map(c => `
        <details class="cc-tgroup">
            <summary>${esc(c.label)} <span class="classroom-row-meta">${c.n}</span></summary>
            ${CLASSROOM_TEMPLATES.filter(t => t.category === c.id).map(t => `
                <label class="cc-roster-row">
                    <input type="checkbox" class="cc-chal-tmpl" value="${esc(t.id)}">
                    <span class="cc-roster-name">${esc(t.title || t.id)}</span>
                    <span class="classroom-row-meta">${esc(t.bands.join(', '))}</span>
                </label>`).join('')}
        </details>`).join('');

    return `
    <div class="cc-qmode">
        <div class="classroom-group-title">Which questions</div>
        <label class="cc-radio">
            <input type="radio" name="cc-chal-mode" value="any" checked
                   onchange="ccChalMode('any')">
            <span><strong>Anything</strong> — each class keeps its own list</span>
        </label>
        <label class="cc-radio">
            <input type="radio" name="cc-chal-mode" value="categories"
                   onchange="ccChalMode('categories')">
            <span><strong>By subject</strong> — the whole school works on the same topics</span>
        </label>
        <label class="cc-radio">
            <input type="radio" name="cc-chal-mode" value="templates"
                   onchange="ccChalMode('templates')">
            <span><strong>Exact questions</strong> — choose them one by one</span>
        </label>

        <div id="cc-chal-cats" class="cc-chips" style="display:none;"
             onchange="ccChalReach()">${catBoxes}</div>
        <div id="cc-chal-tmpls" class="cc-tlist" style="display:none;"
             onchange="ccChalReach()">${tmplGroups}</div>
        <p class="classroom-muted" id="cc-chal-qnote"></p>
        <div id="cc-chal-reach"></div>
    </div>`;
}

/**
 * What this policy would leave each class to ask.
 *
 * Counted in TEMPLATES, not in questions, and said so on screen. A template
 * only becomes a question if this week's data can carry it — the 6-8 word
 * puzzles need several species with short enough names, for instance — so
 * the real number on the day is this one or lower, never higher. An upper
 * bound is the honest thing to show before a challenge exists, and it is
 * enough to catch the mistake worth catching: narrowing to a subject that
 * barely exists for a band.
 *
 * Found by setting a real challenge to Art and Puzzles and watching a 6-8
 * class drop from 31 questions to 2, with nothing anywhere saying why.
 */
function ccChalReach() {
    const q = ccChalQuestionArgs();
    const box = document.getElementById('cc-chal-reach');
    if (!box) return;

    if (!q || q.mode === 'any') { box.innerHTML = ''; return; }

    const allowed = q.mode === 'categories'
        ? new Set(CLASSROOM_TEMPLATES.filter(t => q.categories.includes(t.category)).map(t => t.id))
        : new Set(q.templates);

    // Only the classes the challenge actually covers. Warning about a class
    // that is not in it would be noise, and worse, misleading.
    const roomBoxes = [...document.querySelectorAll('.cc-chal-room')];
    const picked = roomBoxes.length
        ? new Set(roomBoxes.filter(b => b.checked).map(b => b.value))
        : null;
    const rooms = classroomList.filter(r => !r.archived_at && (!picked || picked.has(r.id)));
    if (!rooms.length) { box.innerHTML = ''; return; }

    const want = CLASSROOM_QUESTIONS_PER_SESSION;
    const rows = rooms.map(r => {
        const band = r.grade_band || 'k-2';
        const n = CLASSROOM_TEMPLATES.filter(t =>
            allowed.has(t.id) && t.bands.includes(band)).length;
        // Thin rather than empty is still worth saying: a lesson that wanted
        // eight questions and can only reach four is a short lesson.
        const level = n === 0 ? 'bad' : n < want ? 'warn' : 'ok';
        return { name: r.name, band, n, level };
    });

    const worst = rows.some(r => r.level === 'bad') ? 'bad'
                : rows.some(r => r.level === 'warn') ? 'warn' : 'ok';

    box.innerHTML = `
        <div class="cc-reach ${worst}">
            ${rows.map(r => `
                <div class="cc-reach-row ${r.level}" data-room="${esc(r.name)}">
                    <span>${esc(r.name)}</span>
                    <span class="classroom-row-meta">${esc(GRADE_BAND_LABELS[r.band] || r.band)}</span>
                    <strong>${r.n === 0 ? 'nothing to ask' : `up to ${r.n}`}</strong>
                </div>`).join('')}
            <p class="classroom-muted">
                ${worst === 'bad'
                    ? 'A class with nothing to ask cannot run a lesson in this challenge. Add a subject.'
                  : worst === 'warn'
                    ? `A lesson asks ${want}. Where the number is lower the class gets a short lesson.`
                    : `Enough for a full lesson everywhere. The number on the day can still be lower \u2014 a question only runs if the week\u2019s data can carry it.`}
            </p>
        </div>`;
}

function ccChalMode(mode) {
    const cats  = document.getElementById('cc-chal-cats');
    const tmpls = document.getElementById('cc-chal-tmpls');
    const note  = document.getElementById('cc-chal-qnote');
    if (cats)  cats.style.display  = mode === 'categories' ? '' : 'none';
    if (tmpls) tmpls.style.display = mode === 'templates'  ? '' : 'none';
    ccChalReach();
    if (note) {
        note.textContent =
            mode === 'categories'
                ? 'Every class in the challenge asks from these subjects for the week, '
                + 'whatever its own list says. Questions it has no version of for its '
                + 'grade band are simply skipped.'
          : mode === 'templates'
                ? 'Exactly these, for every class in the challenge. A class only gets '
                + 'the ones written for its grade band.'
          : '';
    }
}

/** What the form is asking for, as the three arguments the RPC wants. */
function ccChalQuestionArgs() {
    const picked = document.querySelector('input[name="cc-chal-mode"]:checked');
    const mode   = picked ? picked.value : 'any';
    const vals   = sel => [...document.querySelectorAll(sel)].filter(b => b.checked)
                                                             .map(b => b.value);
    if (mode === 'categories') {
        const cats = vals('.cc-chal-cat');
        return cats.length ? { mode, categories: cats, templates: null } : null;
    }
    if (mode === 'templates') {
        const ts = vals('.cc-chal-tmpl');
        return ts.length ? { mode, categories: null, templates: ts } : null;
    }
    return { mode: 'any', categories: null, templates: null };
}

/** One line saying what a challenge is about, for the board. */
function cmChallengeQuestionLabel(ch) {
    if (!ch) return '';
    if (ch.question_mode === 'categories' && Array.isArray(ch.categories) && ch.categories.length) {
        return ch.categories.map(c => CLASSROOM_CATEGORY_LABELS[c] || c).join(', ');
    }
    if (ch.question_mode === 'templates' && Array.isArray(ch.template_picks) && ch.template_picks.length) {
        const n = ch.template_picks.length;
        return `${n} chosen question${n === 1 ? '' : 's'}`;
    }
    return 'any question';
}

function cmChallengeAdminHtml(items, live) {
    const wk = cmThisSchoolWeek();

    // Every class ticked by default, which is what a challenge meant before
    // it could be narrowed. Unticking is the deliberate act. Below two
    // classes there is nothing to choose between, so the list stays away.
    const rooms = classroomList.filter(r => !r.archived_at);
    const roster = rooms.length < 2 ? '' : `
        <div class="cc-roster" onchange="ccChalReach()">
            <div class="classroom-group-title">Who is in it</div>
            ${rooms.map(r => `
                <label class="cc-roster-row">
                    <input type="checkbox" class="cc-chal-room" value="${esc(r.id)}" checked>
                    <span class="cc-roster-name">${esc(r.name)}</span>
                    <span class="classroom-row-meta">${esc(GRADE_BAND_LABELS[r.grade_band] || r.grade_band)}</span>
                </label>`).join('')}
            <p class="classroom-muted">Leave them all ticked and the challenge covers the whole
                school, including any class you add while it is running.</p>
        </div>`;

    return `
    <details class="classroom-details">
        <summary>${live ? 'Replace this challenge with another' : 'Set a challenge'}</summary>
        <div class="classroom-form-row">
            <input type="text" id="cc-chal-name" placeholder="Name it — e.g. Bird Week"
                   maxlength="80" style="flex:2;min-width:150px;">
            <input type="date" id="cc-chal-from" value="${esc(wk.from)}" style="flex:1;">
            <input type="date" id="cc-chal-to"   value="${esc(wk.to)}"   style="flex:1;">
        </div>
        ${roster}
        ${cmChallengeQuestionsHtml()}
        <div class="classroom-form-actions">
            <button class="classroom-btn" onclick="createClassroomChallenge()">Start it</button>
        </div>
        <div id="cc-chal-status" class="classroom-status"></div>
    </details>`;
}

async function createClassroomChallenge() {
    const name = (document.getElementById('cc-chal-name') || {}).value || '';
    const from = (document.getElementById('cc-chal-from') || {}).value || '';
    const to   = (document.getElementById('cc-chal-to')   || {}).value || '';
    const out  = document.getElementById('cc-chal-status');
    const say  = (msg, bad) => { if (out) { out.style.color = bad ? '#c0392b' : 'var(--color-gray-500)';
                                            out.textContent = msg; } };

    if (!name.trim()) { say('Give it a name first.', true); return; }
    if (!from || !to) { say('Pick both dates.', true); return; }

    const boxes  = [...document.querySelectorAll('.cc-chal-room')];
    const picked = boxes.filter(b => b.checked).map(b => b.value);
    if (boxes.length && !picked.length) { say('Tick at least one class.', true); return; }

    const q = ccChalQuestionArgs();
    if (!q) { say('Pick at least one, or choose Anything.', true); return; }

    // A class with no template at all cannot teach a lesson for the whole
    // window, which is a worse outcome than being told to widen the subject
    // now. Thin is allowed — that is a judgement call, and the count beside
    // the form has already shown it.
    const starved = [...document.querySelectorAll('#cc-chal-reach .cc-reach-row.bad')]
        .map(e => e.dataset.room);
    if (starved.length) {
        say(`${starved.join(', ')} would have no questions at all. Add a subject.`, true);
        return;
    }

    say('Starting…');
    const args = { p_community_id: classroomCommunityId, p_name: name.trim(),
                   p_starts_on: from, p_ends_on: to };
    const full = { ...args };
    if (boxes.length) full.p_classroom_ids = picked;
    if (q.mode !== 'any') {
        full.p_question_mode = q.mode;
        if (q.categories) full.p_categories   = q.categories;
        if (q.templates)  full.p_template_ids = q.templates;
    }
    let { error } = await sbRpc('classroom_challenge_create', full, true);

    // A site that has not had setup-classroom-challenge-rooms.sql applied
    // still has the four-argument function, and PostgREST answers a call
    // carrying an extra named argument with "no such function". Falling back
    // to the whole school beats refusing to start a challenge at all — but
    // say so when it was not what was asked for.
    const tooOld = error && (error.code === 'PGRST202'
        || /could not find the function|does not exist/i.test(error.message || ''));
    if (tooOld) {
        ({ error } = await sbRpc('classroom_challenge_create', args, true));
        if (!error) {
            const lost = [];
            if (boxes.length && picked.length !== boxes.length) lost.push('which classes are in it');
            if (q.mode !== 'any') lost.push('which questions it covers');
            if (lost.length) {
                showToast(`Challenge started, but ${lost.join(' and ')} `
                        + 'needs a database update on this site.');
            }
        }
    }
    if (error) { say(error.message || 'Could not start it.', true); return; }
    await showClassroomChallenge();
}

async function deleteClassroomChallenge(id, name) {
    if (!window.confirm(`Clear "${name}"?\n\nThe scoreboard goes. Every lesson, and every `
                      + `result, stays exactly where it is — a challenge is only a window `
                      + `of dates laid over them.`)) return;
    const { error } = await sbRpc('classroom_challenge_delete', { p_id: id }, true);
    if (error) { showToast(error.message || 'Could not clear it.'); return; }
    await showClassroomChallenge();
}

/** Percentage, or null where nothing has been settled yet. */
function cmPct(correct, answered) {
    return answered > 0 ? Math.round((correct / answered) * 100) : null;
}

/**
 * One question, opened: the prompt, every choice it offered, and which one
 * the class picked against which one was right.
 *
 * The original explanation sentence is NOT shown, because it is not stored —
 * classroom_session_answers keeps the prompt, the choices and the indexes,
 * but the worked line ("9 − 3 = 6") is generated at lesson time and thrown
 * away. Showing the choices with both marks says the same thing for a
 * multiple-choice question, so this is a gap worth knowing about rather than
 * one worth faking.
 */
/**
 * How the class did, benchmark by benchmark, across every lesson shown.
 *
 * Asked for: "when viewing previous lessons, the overall statistics could
 * show something regarding the standards results... which standards were
 * tested and what the results were from the class. This could help the
 * teacher focus on certain standards that the class needs to improve on."
 *
 * ⚠ SORTED WORST FIRST, which is the whole point. A list in catalogue
 * order is a record; a list with the weakest benchmark at the top is the
 * thing a teacher plans next week from. The ordering IS the feature.
 *
 * ⚠ ONE QUESTION COUNTS ONCE PER BENCHMARK IT CLAIMS. A question tagged
 * with three benchmarks is evidence about all three, so it scores in all
 * three — the totals here deliberately do not add up to the number of
 * questions asked, and the caption says so rather than leaving a teacher
 * to wonder why 8 questions produced 19 results.
 *
 * Predictions are excluded: a question the birds have not settled yet has
 * no result to report, and counting it as wrong would blame the class for
 * the weather.
 */
function cmStandardsResultsHtml(sessions) {
    if (typeof CLASSROOM_STANDARDS === 'undefined'
     || typeof classroomStandardsFor !== 'function') return '';

    const tally = new Map();   // code -> {right, total}
    let counted = 0;

    (sessions || []).forEach(s => (s.questions || []).forEach(q => {
        if (q.pending || q.is_correct == null) return;
        const codes = classroomStandardsFor([q]);
        if (!codes.length) return;
        counted++;
        codes.forEach(c => {
            const e = tally.get(c) || { right: 0, total: 0 };
            e.total++;
            if (q.is_correct) e.right++;
            tally.set(c, e);
        });
    }));

    if (tally.size < 2) return '';

    const rows = [...tally.entries()]
        .map(([code, e]) => ({ code, ...e, pct: Math.round((e.right / e.total) * 100) }))
        // ⚠ EVIDENCE BEFORE SCORE. Sorting on percentage alone put eight
        // benchmarks at "0% — 0 of 1" above one at "25% — 1 of 4", and the
        // 1-of-4 is the one worth a lesson: a single wrong answer is a bad
        // morning, four of them is a pattern. So anything with only one
        // question behind it drops below everything that has more, and
        // inside each group it is still worst first.
        .sort((a, b) => (a.total < 2) - (b.total < 2)
                     || a.pct - b.pct
                     || b.total - a.total);

    const weak = rows.filter(r => r.pct < 60 && r.total >= 2);

    return `
        <details class="classroom-details cc-std-results">
            <summary>How the class did, standard by standard (${rows.length})</summary>
            <p class="classroom-muted">
                Weakest first, but anything with only one question behind it sits
                below the rest — one wrong answer is a bad morning, three out of
                four is a pattern. A question tagged with more than one benchmark
                counts towards each of them, so these add up to more than the
                ${counted} question${counted === 1 ? '' : 's'} behind them.
                Predictions still waiting on the birds are left out.
            </p>
            ${weak.length ? `<p class="classroom-muted">
                <strong>Worth another lesson:</strong> ${weak.slice(0, 3)
                    .map(r => esc(r.code)).join(', ')}.
            </p>` : ''}
            <table class="cc-std-table">
                <tbody>
                ${rows.map(r => {
                    const s = CLASSROOM_STANDARDS[r.code];
                    const band = r.pct < 60 ? 'bad' : r.pct < 80 ? 'warn' : 'ok';
                    return `
                    <tr>
                        <td><a class="cc-std" target="_blank" rel="noopener"
                               href="${esc(classroomStandardUrl(r.code))}"
                               title="${esc(s ? s.text : r.code)}">${esc(r.code)}</a></td>
                        <td class="cc-std-bar">
                            <span class="cc-std-fill ${band}" style="width:${r.pct}%"></span>
                        </td>
                        <td class="cc-std-num ${band}">${r.pct}%</td>
                        <td class="cc-std-of">${r.right} of ${r.total}</td>
                        <td class="cc-std-text">${esc(s ? s.text : '')}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
        </details>`;
}

function cmHistoryQuestionHtml(q) {
    const choices = Array.isArray(q.choices) ? q.choices : [];
    const rows = choices.map((c, i) => {
        const label = esc(c && c.label != null ? c.label : String(c));
        const picked  = i === q.class_index;
        const correct = q.correct_index != null && i === q.correct_index;
        let mark = '', cls = '';
        if (correct) { mark = '✅'; cls = ' right'; }
        if (picked && !correct) { mark = '❌'; cls = ' picked-wrong'; }
        if (picked && correct)  { mark = '✅'; cls = ' right picked'; }
        return `<li class="cc-hq-choice${cls}">
                    <span class="cc-hq-mark">${mark || '·'}</span>${label}
                    ${picked ? '<span class="cc-hq-tag">the class said this</span>' : ''}
                </li>`;
    }).join('');

    // A prediction that has since settled carries what the birds actually
    // did. That number is the whole point of having asked, so it is not
    // buried with the rest of the metadata.
    const actual = (q.resolved_actual != null)
        ? `<p class="cc-hq-actual">What actually happened: <strong>${esc(String(q.resolved_actual))}</strong></p>`
        : (q.pending ? '<p class="cc-hq-actual">Still waiting on the birds to settle this one.</p>' : '');

    return `<ul class="cc-hq-choices">${rows || '<li class="classroom-muted">No choices recorded.</li>'}</ul>
            ${actual}
            ${q.category ? `<p class="classroom-muted cc-hq-meta">${esc(q.category)}</p>` : ''}`;
}

/** A group of questions inside one lesson — Missed, Correct, or Waiting. */
/**
 * When a lesson ran: the clock times, and how long it took.
 *
 * ENDED_AT IS NOT ALWAYS WHEN TEACHING STOPPED. A session that nobody
 * finished is closed by classroom_sweep, which stamps ended_at with the
 * moment the SWEEP ran — so a twenty-minute lesson whose laptop lid went
 * down at the bell comes back as four hours long. Printing that next to a
 * real lesson would make the whole column untrustworthy.
 *
 * So the end is believed only while it is close to the last question asked.
 * Past that the lesson is reported as running to its last question, and
 * labelled "left open", which is both true and the thing a teacher would
 * want to know.
 */
function cmLessonClock(s) {
    const start = s.started_at ? new Date(s.started_at) : null;
    if (!start || isNaN(start)) return { text: '', title: '' };

    const t = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const qs   = (s.questions || []).map(q => q.asked_at && new Date(q.asked_at))
                                    .filter(d => d && !isNaN(d));
    const last = qs.length ? new Date(Math.max(...qs)) : null;
    const end  = s.ended_at ? new Date(s.ended_at) : null;

    if (!end || isNaN(end) || end <= start) {
        return { text: `${t(start)} · not finished`,
                 title: 'This lesson was never closed. It stays open until the '
                      + 'next sweep tidies it up.' };
    }

    // Nothing was ever asked, so there is no lesson to measure and nothing
    // to anchor the end to — the board went up and the bell went, and the
    // row was closed whenever somebody or the sweep got to it. These are the
    // rows that read "11:31 AM – 6:12 PM · 6 h 41 min", which is not a
    // seven-hour lesson, it is an empty one left open over lunch.
    if (!last) {
        return { text: `${t(start)} · nothing asked`,
                 title: `The board was opened at ${t(start)} and no question was `
                      + `put up. The session was closed at ${t(end)}.` };
    }

    // Half an hour past the last question is not a lesson still running, it
    // is a lesson nobody closed.
    const SWEPT = 30 * 60 * 1000;
    const swept = last && (end - last) > SWEPT;
    const real  = swept ? last : end;

    // "9:05 AM – 9:38 AM" says AM twice. Where both ends carry the same
    // trailing marker — AM/PM, or whatever the locale uses — it belongs once,
    // at the end. Compared rather than assumed, so a 24-hour locale (which
    // has no marker) and a lesson that crosses noon are both left alone.
    const span = (a, b) => {
        const A = t(a), B = t(b);
        const mark = B.replace(/^[\d:.\s ]+/, '');
        return (mark && A.endsWith(mark))
            ? `${A.slice(0, -mark.length).trim()} – ${B}`
            : `${A} – ${B}`;
    };

    const mins = Math.round((real - start) / 60000);
    const dur  = mins < 1   ? ''
               : mins < 60  ? ` · ${mins} min`
               : ` · ${Math.floor(mins / 60)} h ${mins % 60} min`;

    return {
        text: `${span(start, real)}${dur}${swept ? ' · left open' : ''}`,
        title: swept
            ? `Last question at ${t(real)}. The lesson was not closed, so the `
            + `session stayed open until ${t(end)} and was tidied up then.`
            : `Started ${t(start)}, finished ${t(end)}.`,
    };
}

function cmHistoryGroupHtml(label, icon, items, open) {
    if (!items.length) return '';
    return `
    <details class="classroom-hgroup"${open ? ' open' : ''}>
        <summary>${icon} ${label} <span class="classroom-pill">${items.length}</span></summary>
        ${items.map(q => `
            <details class="classroom-hq">
                <summary>${esc(q.prompt)}</summary>
                ${cmHistoryQuestionHtml(q)}
            </details>`).join('')}
    </details>`;
}

async function showClassroomHistory(id) {
    const box = document.getElementById('classroom-history');
    if (!box) return;
    // This is now the one thing on the right.
    hideClassroomReview();
    closeClassroomForm();
    renderClassroomList();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading previous lessons…</div>';

    // 50 rather than 10. The list is collapsed now, so a long history costs a
    // row each instead of a screenful each, and a class past a fortnight of
    // daily lessons used to lose its early weeks with nothing saying so.
    const { data, error } = await sbRpc('classroom_session_history',
        { p_classroom_id: id, p_limit: 50 }, true);
    if (error) {
        box.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load previous lessons.')}</div>`
                      + '<button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>';
        return;
    }
    // Two shapes on purpose. A server without
    // setup-classroom-history-lessons.sql returns a bare array of sessions,
    // empties included; one with it returns { lessons, empty_count } already
    // filtered, so that 50-row limit counts LESSONS rather than being spent
    // on abandoned boards. Accepting both means neither deploy order breaks
    // the other.
    const payload = data;
    const all = Array.isArray(payload) ? payload
              : ((payload && payload.lessons) || []);
    const serverEmpty = (payload && !Array.isArray(payload) && payload.empty_count) || 0;

    // A SESSION IS NOT A LESSON UNTIL SOMETHING IS ASKED.
    //
    // The row has to be created the moment the board goes up — the join code
    // and every answer hang off it — so a teacher who opens one and is
    // interrupted leaves a row behind with nothing in it. Four of eight rows
    // on a real class were those, and the panel called it "8 lessons".
    //
    // The scoreboard has excluded them since the day it was written, for
    // exactly this reason. This list disagreeing with that one was the bug:
    // the same week could be four lessons on the board and eight here.
    //
    // They are counted and said, not silently dropped. "You opened the board
    // and taught nothing four times" is worth knowing once; it is not worth
    // four rows that look like lessons with no results.
    // Kept as a filter even once the server does it: it costs nothing, and
    // it is what makes the old shape work. The two counts are summed rather
    // than chosen between, because exactly one of them is ever non-zero.
    const sessions = all.filter(x => (x.questions || []).length > 0);
    const emptied  = serverEmpty + (all.length - sessions.length);

    if (!sessions.length) {
        box.innerHTML = '<div class="classroom-muted">No lessons yet. Once you have run one, '
                      + 'it appears here with every question the class answered.'
                      + (emptied
                          ? ` The board has been opened ${emptied} time${emptied === 1 ? '' : 's'} `
                          + 'without a question going up.'
                          : '')
                      + '</div>'
                      + '<button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>';
        return;
    }

    // ── Totals across everything on screen ──
    //
    // Counted from the questions rather than the sessions' own tallies: a
    // prediction is neither right nor wrong until it settles, and including
    // unsettled ones in the denominator would quietly depress the average of
    // any class that asks them.
    let answered = 0, correct = 0, pending = 0;
    const byCat = new Map();
    for (const s of sessions) {
        for (const q of (s.questions || [])) {
            if (q.pending) { pending++; continue; }
            if (q.is_correct == null) continue;
            answered++;
            if (q.is_correct) correct++;
            const c = byCat.get(q.category) || { n: 0, ok: 0 };
            c.n++; if (q.is_correct) c.ok++;
            byCat.set(q.category, c);
        }
    }
    const overall = cmPct(correct, answered);

    // Only categories with enough questions to mean anything. Three right out
    // of three says nothing about a class; it says they met that topic once.
    const cats = [...byCat.entries()]
        .filter(([, v]) => v.n >= 4)
        .map(([k, v]) => ({ cat: k, n: v.n, pct: cmPct(v.ok, v.n) }))
        .sort((a, b) => a.pct - b.pct);

    const summary = `
    <div class="classroom-hsummary">
        <div class="classroom-hstat"><strong>${sessions.length}</strong><span>lesson${sessions.length === 1 ? '' : 's'}</span></div>
        <div class="classroom-hstat"><strong>${answered}</strong><span>questions answered</span></div>
        ${overall != null ? `<div class="classroom-hstat"><strong>${overall}%</strong><span>correct overall</span></div>` : ''}
        ${pending ? `<div class="classroom-hstat"><strong>${pending}</strong><span>still waiting</span></div>` : ''}
    </div>
    ${emptied ? `<p class="classroom-muted classroom-hcats">
        The board went up ${emptied} other time${emptied === 1 ? '' : 's'} with no question
        asked — not counted above, and not listed below.
    </p>` : ''}
    ${cats.length >= 2 ? `<p class="classroom-muted classroom-hcats">
        Hardest so far: ${cats.slice(0, 2).map(c => `${esc(c.cat)} (${c.pct}%)`).join(', ')}
        · Easiest: ${cats.slice(-1).map(c => `${esc(c.cat)} (${c.pct}%)`).join('')}
    </p>` : ''}
    ${cmStandardsResultsHtml(sessions)}`;

    // The newest lesson, opened. This used to have to hunt for the newest one
    // WITH QUESTIONS, because an empty session would otherwise auto-open and
    // show nothing while every real lesson stayed shut. The empties are gone
    // from the list now, so it is just the first row again.
    const firstWithQs = 0;

    const lessons = sessions.map((s, idx) => {
        const when = new Date(s.started_at)
            .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const qs = s.questions || [];
        const missed  = qs.filter(q => !q.pending && q.is_correct === false);
        const right   = qs.filter(q => !q.pending && q.is_correct === true);
        const waiting = qs.filter(q => q.pending);
        const pct = cmPct(right.length, right.length + missed.length);

        const clock = cmLessonClock(s);

        return `
        <details class="classroom-hlesson"${idx === firstWithQs ? ' open' : ''}>
            <summary>
                <strong>${esc(when)}</strong>
                ${clock.text ? `<span class="classroom-hclock" title="${esc(clock.title)}">${
                    esc(clock.text)}</span>` : ''}
                <span class="classroom-muted">${right.length} of ${right.length + missed.length} correct${
                    pct != null ? ` · ${pct}%` : ''}${waiting.length ? ` · ${waiting.length} waiting` : ''}</span>
            </summary>
            ${cmHistoryGroupHtml('Missed', '❌', missed, true)}
            ${cmHistoryGroupHtml('Correct', '✅', right, false)}
            ${cmHistoryGroupHtml('Waiting on the birds', '⏳', waiting, false)}
            ${cmStandardsSummaryHtml(qs, 'this lesson')}
            ${qs.length ? '' : '<p class="classroom-muted">No questions were recorded for this lesson.</p>'}
        </details>`;
    }).join('');

    // Kept for the exports, so a print or a CSV is exactly what is on screen
    // rather than a second fetch that might disagree with it.
    const room = classroomList.find(r => r.id === id);
    classroomHistoryShown = { id, name: room ? room.name : 'Class', sessions };

    box.innerHTML = '<h4 class="classroom-h">Previous lessons</h4>'
                  + `<div class="cc-print-head"><strong>${esc(classroomHistoryShown.name)}</strong>`
                  + ` — previous lessons, printed ${esc(new Date().toLocaleDateString())}</div>`
                  + `<div class="classroom-hexport">
                        <button class="classroom-btn" onclick="printClassroomHistory()">🖨 Print / Save as PDF</button>
                        <button class="classroom-btn" onclick="exportClassroomHistoryCsv()">⬇ CSV</button>
                     </div>`
                  + summary + lessons
                  + '<button class="classroom-btn" onclick="hideClassroomHistory()">Close</button>';
}

/**
 * Print, which is also how you get a PDF.
 *
 * Every browser's print dialog can write a PDF, so this needs a stylesheet
 * and not a PDF library — a vendored one would be a few hundred KB to
 * reproduce, worse, something the platform already does.
 *
 * Every <details> is forced open first and put back afterwards: an unopened
 * one prints as a bare summary line, so a teacher would get a sheet of dates
 * and no questions, which is the opposite of the point.
 */
function printClassroomHistory() {
    const box = document.getElementById('classroom-history');
    if (!box) return;

    const opened = [...box.querySelectorAll('details:not([open])')];
    opened.forEach(d => { d.open = true; });
    document.body.classList.add('cc-printing');

    const restore = () => {
        document.body.classList.remove('cc-printing');
        opened.forEach(d => { d.open = false; });
        window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    // Safari fires afterprint unreliably; this costs nothing when it did.
    setTimeout(restore, 3000);
}

/**
 * One row per QUESTION, not per lesson.
 *
 * A lesson-level row would say "6 of 8" and lose the thing worth exporting.
 * The point of having this in a spreadsheet is to sort by category, or to
 * find every question a class has ever missed.
 */
function exportClassroomHistoryCsv() {
    const h = classroomHistoryShown;
    if (!h || !h.sessions.length) { showToast('Nothing to export yet.'); return; }

    const labelAt = (q, i) => {
        const c = Array.isArray(q.choices) ? q.choices[i] : null;
        if (i == null || !c) return '';
        return c.label != null ? c.label : String(c);
    };

    const cols = ['lesson_date', 'asked_at', 'category', 'question',
                  'class_answer', 'correct_answer', 'result', 'actual_outcome'];
    const rows = [];
    for (const s of h.sessions) {
        const day = new Date(s.started_at).toISOString().slice(0, 10);
        for (const q of (s.questions || [])) {
            rows.push([
                day,
                q.asked_at || '',
                q.category || '',
                q.prompt || '',
                labelAt(q, q.class_index),
                labelAt(q, q.correct_index),
                q.pending ? 'waiting' : (q.is_correct === true ? 'correct'
                                      : q.is_correct === false ? 'missed' : ''),
                q.resolved_actual != null ? q.resolved_actual : '',
            ]);
        }
    }
    if (!rows.length) { showToast('No questions recorded yet.'); return; }

    const csv = [cols.join(',')].concat(
        rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    ).join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `classroom-${(h.name || 'class').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
               + `-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Close the new/edit form, without disturbing anything else.
 *
 * The right-hand pane holds four things that are all "the one thing you are
 * looking at": the class's action panel, a review, previous lessons, and
 * this form. Three of them already stood each other down. The form did not,
 * because it lives in its own div BELOW the others rather than replacing
 * them — so opening Previous lessons with the form up left a New classroom
 * form hanging under the lesson list, which is exactly the confusion the
 * left-hand column was built to end.
 */
function closeClassroomForm() {
    classroomFormOpen = false;
    classroomEditingId = null;
    if (classroomLeftPick.kind === 'new') classroomLeftPick = { kind: 'class' };
    renderClassroomForm();
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
/**
 * This class's feeder badge standing, and what is new since last lesson.
 *
 * ⚠ NEVER BLOCKS THE LESSON. Badges are decoration on the way in; a
 * failure here must cost the opening slide and nothing else, so every
 * path returns null rather than throwing. A class standing in front of a
 * projector does not care why the rank is missing.
 *
 * "Since last lesson" is remembered per classroom in localStorage rather
 * than stored: it is a nicety, it is per-teacher-per-device by nature,
 * and it is not worth a column or a migration.
 */
async function cmClassroomBadges(room) {
    try {
        if (!room || !room.home_feeder_id) return null;
        if (typeof ensureBadgeStats !== 'function'
         || typeof badgesForFeederId !== 'function') return null;

        await ensureBadgeStats();
        const res = badgesForFeederId(room.home_feeder_id);
        if (!res || !res.rank) return null;

        const key = 'cc-badges-' + room.id;
        let seen = [];
        try { seen = JSON.parse(localStorage.getItem(key) || '[]'); } catch { seen = []; }

        const ids = (res.earned || []).map(b => b.id);
        const fresh = (res.earned || []).filter(b => !seen.includes(b.id));

        try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* private window */ }

        // First lesson on this device: everything looks new, which would
        // be a wall of badges claiming to be this week's. Show the rank
        // and nothing else until there is a real "since".
        return { rank: res.rank, next: res.next, count: res.count, total: res.total,
                 fresh: seen.length ? fresh.slice(0, 4) : [] };
    } catch {
        return null;
    }
}

async function startClassroomSession(id, mode) {
    const room = classroomList.find(r => r.id === id);
    if (!room) return;
    mode = mode === 'join_code' ? 'join_code' : 'teacher_led';

    const stage = document.getElementById('classroom-stage');
    if (!stage) return;
    stage.style.display = 'flex';
    stage.innerHTML = '<div class="classroom-stage-loading">Reading the feeder…</div>';

    // Both in parallel: the recent-template list is a nicety and should not
    // add a round trip to the wait a class is watching.
    const [data, recent, challenge, own] = await Promise.all([
        loadClassroomData(room),
        loadClassroomRecentTemplates(room.id),
        classroomActiveChallenge(room.id),
        loadClassroomOwnQuestions(room.id),
    ]);
    const { questions, source, no_data } =
        buildClassroomQuestions(room, data, { recent, challenge, own });

    if (!questions.length) {
        // A challenge narrows the question pool, so when the pool is empty the
        // challenge is the likeliest reason and blaming the feeder would send
        // a teacher to fix the wrong thing. The teacher who hits this is
        // usually not the moderator who set the challenge.
        const narrowed = challenge && challenge.question_mode !== 'any';
        stage.innerHTML = narrowed
            ? `<div class="classroom-stage-loading">
                <h2>Nothing to ask in this challenge</h2>
                <p>“${esc(challenge.name)}” limits this week to
                   ${esc(cmChallengeQuestionLabel(challenge))}, and this class has no
                   question of that kind it can build from
                   ${esc(room.home_feeder_name || 'its feeder')} today.</p>
                <p class="classroom-muted">Whoever set the challenge can widen it, or
                   clear it and the class goes back to its own questions.</p>
                <button class="classroom-btn-primary" onclick="closeClassroomStage()">Close</button>
              </div>`
            : `<div class="classroom-stage-loading">
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

    // The feeder's badge standing, for the opening slide. Suggested as
    // "start the lessons with the school's bird feeder badge level and
    // possibly badges earned since last lesson" — and the second half is
    // the better half: a level that never moves is wallpaper, while
    // "you earned two since Tuesday" is a reason to look.
    const badges = await cmClassroomBadges(room);

    classroomSession = {
        id: sess.id, room, source, questions, mode, badges,
        // Say so on the board rather than letting a teacher wonder why none
        // of today's questions mention their feeder.
        noData: !!no_data,
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
            // Only where there IS a right answer. With none — a prediction
            // still waiting, or a poll — "not the right answer" was true of
            // every pick, so the class's own vote was painted red as wrong.
            if (q.correct_index != null && i === q.class_index
                && i !== q.correct_index)                          cls += ' chosen-wrong';
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
                    ${c.swatch ? `<span class="classroom-swatch" style="background:${esc(c.swatch)}"></span>` : ''}
                    <span class="classroom-choice-label">${esc(c.label)}</span>
                    ${tally}
                </button>`;
    }).join('');

    // Reuses the species panel behind the "Web" button on every detection
    // card rather than inventing a second way to look a bird up: it already
    // carries All About Birds, Audubon and a Wikipedia summary, and a teacher
    // who has used one has used the other. Its z-index puts it above the
    // stage, so it works from a running lesson.
    const learn = (S.revealed && q.about_bird && typeof openAIResearch === 'function')
        ? `<button class="classroom-btn classroom-learn"
                   onclick="openAIResearch('${escJs(q.about_bird)}')">
             🌐 Read more about the ${esc(q.about_bird)}</button>`
        : '';

    const reveal = !S.revealed ? '' : `
        <div class="classroom-reveal">
            ${q.poll
                ? '<div class="classroom-reveal-head pending">🗳 No single right answer — what did you notice?</div>'
                : q.correct_index == null
                ? '<div class="classroom-reveal-head pending">📌 Answer recorded — we check this next class</div>'
                : (q.class_index === q.correct_index
                    ? '<div class="classroom-reveal-head ok">✅ The class got it</div>'
                    : '<div class="classroom-reveal-head miss">❌ Not quite</div>')}
            <div class="classroom-reveal-body">${esc(q.explain || '')}</div>
            ${q.fact ? `<div class="classroom-fact">💡 ${esc(q.fact)}</div>` : ''}
            ${learn}
        </div>`;

    const last = S.index === S.questions.length - 1;

    stage.innerHTML = `
        <div class="classroom-stage-bar">
            <div>
                <strong>${esc(S.room.name)}</strong>
                <span class="classroom-pill">${esc(band)}</span>
                ${S.noData ? '<span class="classroom-pill warn">Feeder quiet — '
                           + 'general bird questions today</span>' : ''}
                ${q.own
                    // A teacher's own question has no feeder behind it, and
                    // the class should know whose question it is.
                    ? '<span class="classroom-pill">Your teacher’s question</span>'
                    : q.from_partner
                    ? `<span class="classroom-pill partner">Partner feeder: ${esc(q.source_feeder_name)}</span>`
                    // Data-free questions have no feeder either; an empty pill
                    // read as a rendering fault.
                    : q.source_feeder_name
                    ? `<span class="classroom-pill">${esc(q.source_feeder_name)}</span>`
                    : ''}
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
          <div class="classroom-fit">
            ${cmBadgeOpenerHtml(S)}
            ${classroomSlideTopHtml(S, q)}
            ${classroomChoicesBlock(S, q, choices)}
            ${reveal}
          </div>
        </div>

        <div class="classroom-stage-foot">
            ${classroomFootControls(S, last, joinMode)}
            <button class="classroom-btn" onclick="skipClassroomQuestion()">Skip</button>
        </div>`;

    // After layout, not during: scrollHeight is meaningless until the browser
    // has laid the new markup out.
    classroomFitSoon();
}

/**
 * The one control the teacher is meant to press next.
 *
 * Teacher-led and join-code diverge only here and in where the answer comes
 * from — everything above this point is the same screen in both modes, which
 * is what the design notes ask for.
 */
/**
 * The feeder's badge standing, across the top of the FIRST question only.
 *
 * ⚠ FIRST QUESTION ONLY, and that is the whole design. A rank strip on
 * every slide is furniture the class stops seeing by question three, and
 * it competes for the height the chart and the choices need. On the way
 * in it is a reason to care about the feeder; after that it is clutter.
 *
 * Nothing is clickable: a lesson is running, and a teacher who taps
 * through to a badge page has lost the room.
 */
function cmBadgeOpenerHtml(S) {
    const b = S.badges;
    if (!b || S.index !== 0 || S.revealed) return '';

    return `
      <div class="cc-badge-open">
        <span class="cc-badge-rank">${esc(b.rank.icon || '')} ${esc(b.rank.name)}</span>
        <span class="classroom-muted">${b.count} of ${b.total} badges${
            b.next ? ` · next: ${esc(b.next.name)}` : ''}</span>
        ${b.fresh.length ? `<span class="cc-badge-new">New since last lesson: ${
            b.fresh.map(x => `${esc(x.icon || '')} ${esc(x.name)}`).join(', ')}</span>` : ''}
      </div>`;
}

function classroomFootControls(S, last, joinMode) {
    if (S.revealed) {
        return last
            ? '<button class="classroom-btn-primary big" onclick="endClassroomSession()">See the results</button>'
            : '<button class="classroom-btn-primary big" onclick="nextClassroomQuestion()">Next question →</button>';
    }
    if (!joinMode) {
        // The build questions carry their own control in the slide, and
        // "tap the class's answer" is wrong advice there — there is
        // nothing to tap but the bars.
        const q = S.questions[S.index];
        if (q && q.build) {
            return '<span class="classroom-muted">Ask the class how tall each bar should be, '
                 + 'then press Check.</span>';
        }
        if (q && q.grid) {
            return '<span class="classroom-muted">Ask the class where the point goes, '
                 + 'then tap it on the grid.</span>';
        }
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
/**
 * Two photographs of the same species, male beside female.
 *
 * Asked for on sci-camouflage: "would be nice to see a male and female of the
 * same species side by side here as an example." The question was asking a
 * class to reason about a difference in plumage while showing them nothing —
 * every child who had not already seen a cardinal pair was being asked to
 * take the premise on trust.
 *
 * Labelled under each picture rather than over, so the eye meets the birds
 * first and the words second; and labelled at all because "which is which"
 * is not the question being asked and should not become one.
 *
 * Both credits are rendered. CC BY and CC BY-SA require the author and the
 * licence wherever the image appears, and these are two separate photographs
 * by two different people.
 */
function classroomPairHtml(pair) {
    if (!pair || !pair.male || !pair.female) return '';

    const one = (half, label) => {
        const c = half.credit || {};
        return `
        <figure class="classroom-pair-half">
            <img src="${esc(half.url)}" alt=""
                 onload="requestAnimationFrame(classroomFitStage)">
            <figcaption>${esc(label)}</figcaption>
            <p class="classroom-shot-credit">${esc(c.artist || 'Unknown')} /
               ${esc(c.licence || '')} · Wikimedia Commons</p>
        </figure>`;
    };

    return `<div class="classroom-pair">
                ${one(pair.male, 'male')}
                ${one(pair.female, 'female')}
            </div>`
         + (pair.species ? `<p class="classroom-pair-cap">${esc(pair.species)}</p>` : '');
}

function classroomShotHtml(q, revealed) {
    if (!q.image || !q.image.url) return '';
    // crop_caption: a teacher's own question over a feeder photo, which may
    // well be "who is this?" — see cmOwnLessonQuestions.
    const hideCaption = (q.category === 'identification' || q.crop_caption) && !revealed;

    // CC BY and CC BY-SA require the author and the licence wherever the
    // image appears. Small, because it is a legal notice rather than part of
    // the lesson - but present, because without it our use of the photograph
    // is an infringement rather than a licence.
    const c = q.image.credit;
    const credit = c
        ? `<p class="classroom-shot-credit">${esc(c.artist || 'Unknown')} /
             ${esc(c.licence || '')} · Wikimedia Commons</p>`
        : '';

    // EVERY image re-fits the slide once it has loaded, not just the cropped
    // identification ones. A photo arriving is the single biggest change to a
    // slide's height, and the only pass that ran was the one before the image
    // existed - so the slide was scaled against a height that was about to
    // grow, and then scrolled. The ResizeObserver cannot be relied on alone
    // here: it is deliberately deaf while the fitter is writing, and an image
    // can easily land inside that window.
    const onload = hideCaption ? 'classroomFitShot(this)'
                               : 'requestAnimationFrame(classroomFitStage)';

    return `<div class="classroom-shot${q.image.credit ? ' wonder' : ''}"`
         + `${hideCaption ? ' data-crop="caption"' : ''}>`
         + `<img src="${esc(q.image.url)}" alt="" onload="${onload}">`
         + '</div>' + credit;
}

/**
 * Shrink the slide until it fits, so a projector never needs scrolling.
 *
 * Sizing everything in vmin gets close but cannot guarantee it: the content
 * varies — four long species names wrap to two lines each, a reveal block
 * appears after the answer, a chart and a photo have different heights — and
 * on a short or 4:3 projector any of those can push the choices off the
 * bottom. Off the bottom of a projector is INVISIBLE, not merely
 * inconvenient: nobody in the room can scroll it, and the teacher driving
 * from the back cannot either.
 *
 * So the whole slide is measured after it renders and scaled down as one
 * block if it overflows. Uniform scale keeps the layout and the relative
 * sizes exactly as designed; only the absolute size moves.
 *
 * Called after every render, after an image loads (which changes the height),
 * and on resize.
 */
// Suppresses the observer below while we are the ones changing the size.
let classroomFitWriting = false;
let classroomFitObserved = null;

/**
 * Re-fit when the slide's height changes under us.
 *
 * One pass on the frame after render is not enough. Measured there, a slide
 * came out 68px taller than it settled at a moment later - the text was still
 * in the fallback font - so the scale was computed against a height that no
 * longer existed, and nothing ever recomputed it. Web fonts, a chart's SVG
 * and a photo all land after that first frame.
 *
 * Watching the element covers all three without having to know which. Our own
 * writes would otherwise retrigger it, so they are fenced off rather than
 * guarded by comparing sizes, which is what turns these into infinite loops.
 */
const classroomFitObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (!classroomFitWriting) classroomFitStage(); })
    : null;

function classroomFitStage() {
    const body = document.querySelector('.classroom-stage-body');
    const fit  = body && body.querySelector('.classroom-fit');
    if (!fit) return;

    // Each render builds a new element, so follow it.
    if (classroomFitObserver && classroomFitObserved !== fit) {
        if (classroomFitObserved) classroomFitObserver.unobserve(classroomFitObserved);
        classroomFitObserver.observe(fit);
        classroomFitObserved = fit;
    }

    classroomFitWriting = true;
    try {
        classroomFitMeasure(body, fit);
    } finally {
        // Release only once the layout from our writes has been observed,
        // or the callback they provoke arrives after the flag is down and
        // we measure our own scaled output.
        requestAnimationFrame(() => { classroomFitWriting = false; });
    }
}

/**
 * Make room by shrinking the PHOTO, before shrinking everything.
 *
 * The fitter scales the whole slide uniformly, which is right when the slide
 * is simply dense - but on a fact slide the photograph is most of the height,
 * so uniform scaling shrank the sentences to pay for the picture. The flag
 * was exact: "the photo is cut off on the top, and the text is way too small
 * for the screen."
 *
 * A photograph loses almost nothing by being smaller; a sentence read aloud
 * from the back of a room loses everything. So the image hands back height
 * first, down to a floor where it is still worth showing, and only what is
 * left over goes to the uniform scale.
 *
 * Returns the slide's natural height after the image has given what it can.
 */
function classroomFitShrinkPhoto(fit, available, natural) {
    const img = fit.querySelector('.classroom-shot img');
    if (!img || natural <= available) return natural;

    const imgH = img.getBoundingClientRect().height;
    if (!imgH) return natural;

    // Once the answer is up, the photograph has done its job and the words
    // have not. A reveal adds an explanation, sometimes a fact and a "read
    // more" button to a slide that already fitted, and with the same floor
    // as before there was nothing left to give: the uniform scale ran out at
    // its own limit and the stage scrolled. Flagged exactly so — "when I
    // answered the question, the screen got taller and required scrolling.
    // It should always fit on the screen."
    //
    // So the floor drops on reveal. The picture is still there to point at;
    // it is just no longer the thing being read.
    const revealed = !!fit.querySelector('.classroom-reveal');

    // Never below roughly a quarter of the slide while the photo IS the
    // question: past that it stops being a photograph and the uniform scale
    // may as well take over.
    const share = revealed ? 0.14 : 0.26;
    const floor = Math.min(imgH, Math.max(revealed ? 70 : 120, available * share));
    const give  = Math.min(natural - available, imgH - floor);
    if (give <= 1) return natural;

    img.style.maxHeight = (imgH - give) + 'px';
    return fit.scrollHeight;
}

function classroomFitMeasure(body, fit) {

    // Measure unscaled, or each pass would compound the previous one.
    // The height has to go too: it is set below to the scaled height, and
    // leaving it would make the next pass measure the last pass's answer.
    fit.style.transform = '';
    fit.style.height    = '';

    // clientHeight INCLUDES the stage body's own padding, so using it raw
    // promised the slide about 36px that do not exist and left exactly that
    // much overflow. What the slide may occupy is the padding box minus the
    // padding.
    const pad = getComputedStyle(body);
    const available = body.clientHeight
                    - parseFloat(pad.paddingTop)
                    - parseFloat(pad.paddingBottom);
    // Measured unscaled, with any earlier cap lifted so this pass sees the
    // photo's own size rather than the last pass's answer.
    const img = fit.querySelector('.classroom-shot img');
    if (img) img.style.maxHeight = '';

    let natural = fit.scrollHeight;
    if (available <= 0 || !natural) return;

    natural = classroomFitShrinkPhoto(fit, available, natural);

    // A little margin so a rounding error does not leave one pixel of
    // overflow and a scrollbar with it.
    const scale = Math.min(1, (available - 4) / natural);

    // Below about half size the text stops being readable from the back of a
    // room, and scaling further would trade one unusable slide for another.
    // Allow the scroll in that case rather than pretending.
    if (scale < 0.5) {
        fit.style.transform = '';
        fit.style.height = '';
        return;
    }

    fit.style.transformOrigin = 'center top';
    fit.style.transform = `scale(${scale})`;
    // transform scales what is PAINTED, not the layout box — the container
    // goes on reserving the full height and goes on scrolling, which is the
    // whole thing being fixed. Shrinking the box to match the painted size is
    // what actually removes the scrollbar.
    fit.style.height = (natural * scale) + 'px';
}

/**
 * Fit now, and again shortly afterwards.
 *
 * A single pass after render keeps being wrong, in three different ways now:
 * the stage body has no height yet because it was shown in the same tick, a
 * web font lands and reflows the text, or a photograph arrives. Each time the
 * fitter measured something that was about to change, and nothing ran again.
 *
 * Rather than chase each cause, measure a few times over the first quarter
 * second. The passes are idempotent - each one resets and re-measures from
 * scratch - so the only cost of an unnecessary one is a few microseconds, and
 * the cost of a missing one is a slide that scrolls in front of a class.
 */
function classroomFitSoon() {
    requestAnimationFrame(classroomFitStage);
    setTimeout(classroomFitStage, 90);
    setTimeout(classroomFitStage, 280);
}

let classroomFitTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(classroomFitTimer);
    classroomFitTimer = setTimeout(classroomFitStage, 120);
});

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

/**
 * Skip, with a chance to say why.
 *
 * A teacher skipping a question mid-lesson is the strongest signal the set
 * produces — they have just read it to a class and decided not to ask it —
 * and until now it vanished. The prompt is optional and one line: a lesson is
 * running, thirty children are waiting, and a form here would simply mean
 * nobody ever skips with a reason.
 */
function skipClassroomQuestion() {
    const S = classroomSession;
    if (!S) return;

    const q = S.questions[S.index];
    const why = window.prompt(
        'Skipping this one. Why? (optional — press Cancel to skip without saying)\n\n'
        + (q ? q.prompt : ''), '');

    // null means Cancel: skip, record nothing. An empty string means they
    // pressed OK with nothing typed, which is also nothing to record.
    if (why && why.trim() && q) {
        sbRpc('classroom_flag_question', {
            p_community_id: classroomCommunityId,
            p_classroom_id: S.room.id,
            p_reason:       'other',
            p_comment:      'Skipped during a lesson: ' + why.trim(),
            p_question: {
                template_id:      q.template_id,
                category:         q.category,
                grade_band:       q.grade_band,
                prompt:           q.prompt,
                choices:          q.choices,
                correct_index:    q.correct_index,
                explain:          q.explain || null,
                // A reveal-only photo is not what the class was asked about.
                chart_kind:       q.video ? 'clip'
                                : (q.image && !q.image_on_reveal) ? 'photo'
                                : (q.chart ? q.chart.kind : null),
                source_feeder_id: q.source_feeder_id,
            },
        }, true).then(({ error }) => {
            // Never interrupt a lesson over this. The toast is enough.
            showToast(error ? 'Skipped (note not saved)' : 'Skipped — thanks, noted.');
        });
    }

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

/**
 * The join URL with the class code already in it.
 *
 * What the QR encodes. Scanning it should leave a child with one thing to do
 * — type a nickname — rather than two. The code is no more exposed than it
 * already is: it is in 11rem digits on the projector behind the QR.
 */
function classroomJoinUrlWithCode(code) {
    const base = classroomJoinUrl();
    return code ? `${base}?c=${encodeURIComponent(code)}` : base;
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
          <div class="classroom-fit">
            <div class="classroom-lobby">
                <div class="classroom-lobby-cols">
                    <div class="classroom-lobby-text">
                        <p class="classroom-lobby-step">On your device, go to</p>
                        <p class="classroom-lobby-url">${esc(url)}</p>
                        <p class="classroom-lobby-step">and enter the class code</p>
                        <p class="classroom-code">${esc(S.joinCode || '—')}</p>
                    </div>
                    ${classroomJoinQrHtml(S.joinCode)}
                </div>
                <p class="classroom-muted">Pick any nickname. No password, no sign-in,
                   and nothing is kept after the lesson.</p>
            </div>
            <div class="classroom-nicknames">
                ${joined.length
                    ? joined.map(n => `<span class="classroom-nick">${esc(n)}</span>`).join('')
                    : '<span class="classroom-muted">Waiting for the first person to join…</span>'}
            </div>
          </div>
        </div>

        <div class="classroom-stage-foot">
            <button class="classroom-btn-primary big" onclick="beginClassroomQuestions()"
                    ${joined.length ? '' : 'disabled title="Nobody has joined yet"'}>
                Start the questions →
            </button>
            <span class="classroom-muted">${S.questions.length} questions ready.</span>
        </div>`;

    classroomFitSoon();
}

/**
 * The QR for the join link, or nothing if it cannot be made.
 *
 * Returns an empty string rather than a broken image when the encoder is
 * missing or the URL will not fit — the code and the address beside it are
 * the real instructions, and the QR is the shortcut. A classroom should never
 * be blocked by the shortcut failing.
 *
 * Live again as of the qrcode-generator swap. The hand-rolled encoder this
 * used to call produced symbols that did not scan at any version, which is
 * why this returned nothing for so long; see the header of community-qr.js.
 * The empty-string fallback stays, because "no QR" is a lobby that still
 * works and "a QR that will not scan" is thirty children trying it while the
 * lesson stops.
 */
function classroomJoinQrHtml(code) {
    if (!code || typeof bwQr === 'undefined' || !bwQr) return '';
    const svg = bwQr.svg(classroomJoinUrlWithCode(code), { label: 'Scan to join the class' });
    if (!svg) return '';
    return `<div class="classroom-qr">
                ${svg}
                <p class="classroom-qr-cap">Point your camera here</p>
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
