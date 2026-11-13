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

// ── What each bird looks like (design notes §2, the K–2 line) ──────
//
// "Colour/shape matching to identify birds" is the first thing the notes ask
// for at K–2, and it is the one thing the detection data cannot supply: the
// model reports a species and a time, never a colour. So this is a small
// hand-written table about the birds themselves.
//
// `color` is the ONE colour a five-year-old would say if asked, not an
// ornithologically complete description — a Blue Jay is blue even though it
// is also white, black and grey. Questions below only ever ask about a colour
// exactly one of the offered birds has, so "which is blue?" never has two
// defensible answers.
//
// `female` is set where the sexes differ enough that a class will notice and
// ask, which is most of the feeder regulars and a good discussion either way.
//
// Only species the feeders actually see, matching SPECIES_FACTS. A bird with
// no entry here simply never appears in a colour question.
const SPECIES_LOOKS = {
    'Northern Cardinal':      { color: 'red',             female: 'soft brown with a little red', feature: 'a pointy crest on its head' },
    'Carolina Chickadee':     { color: 'black and white', feature: 'a black cap and a black bib' },
    'Black-capped Chickadee': { color: 'black and white', feature: 'a black cap and a black bib' },
    'Tufted Titmouse':        { color: 'grey',            feature: 'a little grey crest' },
    'Carolina Wren':          { color: 'brown',           feature: 'a white stripe over its eye and a tail that points up' },
    'House Finch':            { color: 'red',             female: 'streaky brown', feature: 'a red head and chest' },
    'American Goldfinch':     { color: 'yellow',          feature: 'black wings with white bars' },
    'Blue Jay':               { color: 'blue',            feature: 'a blue crest and a black necklace' },
    'Mourning Dove':          { color: 'grey',            feature: 'a long pointed tail' },
    'Downy Woodpecker':       { color: 'black and white', female: 'the same, but with no red patch', feature: 'a chisel beak for tapping wood' },
    'Red-bellied Woodpecker': { color: 'black and white', feature: 'a red cap and zebra stripes on its back' },
    'White-breasted Nuthatch':{ color: 'grey',            feature: 'walking DOWN the tree head first' },
    'House Sparrow':          { color: 'brown',           feature: 'a grey cap and a black bib' },
    'European Starling':      { color: 'black',           feature: 'shiny feathers with little white spots' },
    'American Robin':         { color: 'orange',          feature: 'an orange tummy' },
    'Dark-eyed Junco':        { color: 'grey',            feature: 'grey on top and white underneath' },
    'Northern Mockingbird':   { color: 'grey',            feature: 'white flashes in its wings when it flies' },
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
        intro: ['Flamingo chicks hatch out grey. The pink arrives later.',
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
        intro: ['"Robin’s egg blue" is a colour name used by paint companies and '
              + 'crayon makers, because a robin’s egg really is that blue.',
                'The colour is not painted on. It is made inside the mother.'],
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
// colours, and what mixes to make orange are the actual beginning of a
// primary art curriculum, and the birds supply the examples - a cardinal, a
// goldfinch and a jay really are red, yellow and blue, which is a free and
// surprisingly rare demonstration that the three primaries exist in nature
// and turned up at the school feeder in the same week.

// The plain colour words from SPECIES_LOOKS, as paint.
//
// Separate from SPECIES_COLORS: that table pulls the greys apart so chart
// bars stay distinguishable, which is right for a chart and wrong for a
// swatch. A swatch has to be the colour the WORD means, or matching the word
// to the patch stops being possible.
const COLOR_WORD_HEX = {
    'red':             '#e23b3b',
    'orange':          '#f08a2c',
    'yellow':          '#f5d324',
    'brown':           '#9c6b43',
    'blue':            '#3b7fe2',
    'grey':            '#9aa3ad',
    'black':           '#2f3338',
    'black and white': '#d9dee4',
};

// Artists' warm/cool split. Only the colours it is honestly defined for -
// black, white and the black-and-white birds sit outside it, and a question
// that forced them to one side would be teaching something untrue.
const WARM_COLORS = ['red', 'orange', 'yellow', 'brown'];
const COOL_COLORS = ['blue', 'grey'];

// Red, yellow and blue. The feeder regularly supplies all three.
const PRIMARY_COLORS = ['red', 'yellow', 'blue'];

/**
 * Paint a colour swatch onto each answer.
 *
 * The answers to a colour question have to BE the colours - a K-2 class that
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

// The species seen this week that have a colour we can talk about.
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
 * length, then nearest, so it degrades to the old behaviour rather than
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

function cmSummarize(feederId, name, rows, isHome, windowDays) {
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

    const days = (windowDays
        ? cmDayKeysEnding(new Date(), windowDays)
        : [...byDay.keys()].sort((a, b) => a.localeCompare(b))
      ).map(day => ({ day, n: byDay.get(day) || 0 }));

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
    return cmSummarize(src.feederId, src.name, rows, src.isHome, days);
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
// ── Colour ────────────────────────────────────────────────────────
//
// Every bar used to be the same green, separated only by opacity. On a
// projector that reads as a spreadsheet, and the feedback from an actual
// classroom was blunt: kids love colour, and there wasn't any.
//
// Colour here is not decoration, which is why it is a hand-written table
// rather than a generated ramp. Each species gets the colour a child would
// say that bird is, so the cardinal's bar is red and the jay's is blue, and
// the chart quietly teaches identification every time it is shown. By the
// third lesson "the red one" and "the cardinal" are the same thought.
//
// Where plumage would collide - five of these birds are honestly just grey -
// the greys are pulled apart along the shades they really do differ by: a
// nuthatch IS blue-grey above, a dove IS pinkish, a junco IS charcoal. So the
// bars stay distinguishable without the colours becoming a lie.
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
    'White-breasted Nuthatch': '#7dd3fc',  // genuinely blue-grey above
    'Tufted Titmouse':         '#a5b4cf',  // soft slate, and it is a slate bird
    'Mourning Dove':           '#d8b4a0',  // doves really are pinkish-grey
    'Dark-eyed Junco':         '#8b93a7',  // charcoal, lifted enough to read
    'Northern Mockingbird':    '#cbd5e1',  // pale grey
    'Carolina Chickadee':      '#e8eef5',  // black and white, so near-white
    'Black-capped Chickadee':  '#dbe4ee',
    'Downy Woodpecker':        '#f1f5f9',  // the other black-and-white
    'European Starling':       '#a78bfa',  // black with a purple-green sheen
};

// For series that are not species - days of the week, hours of the day. A
// run of related hues keeps the order readable left to right while still
// being a row of colours rather than a row of grey.
const CHART_SPECTRUM = [
    '#60a5fa', '#38bdf8', '#2dd4bf', '#4ade80', '#a3e635',
    '#fde047', '#fbbf24', '#fb923c', '#f87171', '#f472b6',
];

/**
 * Cold blue to warm red, for a temperature.
 *
 * `t` is 0 (the coldest day in view) to 1 (the warmest). Deliberately not a
 * full rainbow: blue-to-red is the one colour ramp almost everybody already
 * reads as cold-to-hot without a legend, which is the whole point of using
 * colour rather than another axis.
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
 * The colour for one row of a chart.
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

    // Species series colour by species; everything else runs the spectrum.
    // `plain` is the opt-out, and it is not cosmetic: a question that ASKS
    // about colour ("which of these birds is blue?") must not be shown a
    // chart that has already answered it in the bars.
    const mode = o.plain ? 'plain'
               : trimmed.every(r => SPECIES_COLORS[r.key]) ? 'species'
               : 'spectrum';
    // A row may bring its own colour, which is how a chart encodes a SECOND
    // variable in the bars themselves - height for one, colour for the other
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
             total: trimmed.reduce((a, r) => a + r.value, 0) };
}

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
function classroomChoicesBlock(S, q, choices) {
    const shown = S.choicesShownFor === S.index;
    if (!q.guess_first || S.revealed || shown) {
        return `<div class="classroom-choices ${q.choices.length > 3 ? 'four' : ''}">${choices}</div>`;
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
    const shot = q.image ? classroomShotHtml(q, revealed) : '';
    const map  = q.map   ? classroomMapHtml(q.map, revealed) : '';

    // Both: the bird beside the places. Side by side on a projector, stacked
    // when there is no room for two.
    if (shot && map) return `<div class="classroom-evidence-pair">${shot}${map}</div>`;
    if (map)  return map;
    if (shot) return shot;
    return classroomChartHtml(q.chart, revealed);
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
        case 'clock': return classroomClockHtml(chart, withValues);
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
 * value would mean so many lines that the chart turns into a grey wash.
 */
function cmMinorStep(top, step) {
    if (step <= 1) return 0;                  // already a line at every value
    // Finest first: a line at EVERY value is what was actually asked for, and
    // anything coarser still leaves some bar sitting in a gap. Only when that
    // would mean more than forty lines — at which point the plot is a grey
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
    // is capped and the whole group is centred instead of spread.
    const barW   = Math.min(slot * 0.62, 96);
    const group  = Math.min(slot, 200);
    const originX = padL + (plotW - group * n) / 2;
    const cxOf = i => originX + group * i + group / 2;

    const thumbW = hasPhotos ? Math.max(96, Math.min(group * 0.92, 190)) : 0;
    const thumbH = Math.round(thumbW / 1.3);

    // Under the axis: the photo, a gap, then up to two lines of label.
    const labelDrop = hasPhotos ? thumbH + 12 : 0;
    const hasSub = chart.series.some(r => r.sub);
    const padB = 56 + labelDrop + 52 + (hasSub ? 30 : 0);
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
        // Long species names on a 1000-unit canvas need two lines; days and
        // hours never do.
        const label = String(s.label);
        const parts = label.length > 12 ? label.split(' ') : [label];
        const lines = parts.length > 1
            ? [parts.slice(0, -1).join(' '), parts[parts.length - 1]]
            : [label];

        // An explicit second line, for a series that carries two facts per
        // bar. Flagged on the weather chart: "the x-axis labels need to be on
        // 2 lines, first the Day and Date, and beneath that the temperature."
        // Relying on the length-based wrap above would have put the split
        // wherever the string happened to be long enough, which is not the
        // same thing as putting it where the meaning changes.
        const subLine = s.sub
            ? `<text x="${cx}" y="${H - padB + 28 + labelDrop + lines.length * 26}"
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
                     `<text x="${cx}" y="${H - padB + 28 + labelDrop + k * 26}" class="cc-label"
                            text-anchor="middle">${esc(ln)}</text>`).join('');
        }

        return `<rect x="${cx - barW / 2}" y="${y(s.value)}" width="${barW}" height="${h}"
                      rx="6" class="cc-bar${on ? ' on' : ''}" fill="${s.color}"/>`
             + (revealed
                 ? `<text x="${cx}" y="${y(s.value) - 10}" class="cc-val" text-anchor="middle">${s.value}</text>`
                 : '')
             + thumb
             + lines.map((ln, k) =>
                 `<text x="${cx}" y="${H - padB + 28 + labelDrop + k * 26}" class="cc-label"
                        text-anchor="middle">${esc(ln)}</text>`).join('')
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
 * the only reason to put a map on a question is to colour part of it — "these
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
    const W = 1000, rowH = 62, padT = 16, padB = 16;
    const labelW = 300, padR = 70;
    const H = padT + padB + n * rowH;
    const plotW = W - labelW - padR;

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
                <line x1="${labelW}" y1="${padT}" x2="${labelW}" y2="${H - padB}" class="cc-axisline"/>
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
    const x = i => padL + (n < 2 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => padT + plotH - (v / top) * plotH;

    const grid = cmGridHtml(top, step, padL, W - padR, y);

    const pts = chart.series.map((s, i) => `${x(i)},${y(s.value)}`).join(' ');
    const area = `${padL},${y(0)} ${pts} ${x(n - 1)},${y(0)}`;

    // A fat dot per reading, in that reading's own colour, so the line is
    // also a row of coloured markers rather than one undifferentiated stroke.
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
 * in different colours with a legend, which is also the honest way to show a
 * feeder that is busy at 8am and quiet at 8pm.
 */
function classroomClockHtml(chart, revealed) {
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
    // the drawing reaches 258 below centre while the canvas was 460 tall
    // with its centre at 240 — the bottom blob was cut in half by the edge.
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

    if (hands) {
        const hour24 = Number(hands.hour != null ? hands.hour : hands);
        const minute = Number(hands.minute || 0);
        const ha = ((hour24 % 12) + minute / 60) / 12 * Math.PI * 2 - Math.PI / 2;
        const ma = (minute / 60) * Math.PI * 2 - Math.PI / 2;
        const hand = (ang, len, cls) =>
            `<line x1="${cx}" y1="${cy}"
                   x2="${(cx + len * Math.cos(ang)).toFixed(1)}"
                   y2="${(cy + len * Math.sin(ang)).toFixed(1)}" class="${cls}"/>`;

        return `
        <figure class="classroom-chart clock">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${face}
                ${hand(ma, R * 0.80, 'cc-clock-hand minute')}
                ${hand(ha, R * 0.52, 'cc-clock-hand hour')}
                <circle cx="${cx}" cy="${cy}" r="10" class="cc-clock-pin"/>
            </svg>
            <figcaption>${esc(chart.caption)}</figcaption>
        </figure>`;
    }

    // One blob per hour that had birds, out beyond the numbers, sized by how
    // busy that hour was. Size rather than colour carries the quantity,
    // because colour is already carrying am/pm.
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
             + (revealed
                 ? `<text x="${bx.toFixed(1)}" y="${(by + 9).toFixed(1)}"
                          class="cc-clock-val" text-anchor="middle">${s.value}</text>`
                 : '');
    }).join('');

    return `
        <figure class="classroom-chart clock">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.caption)}">
                ${face}
                ${blobs}
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
                           cmSpeciesSeries(s), { band, highlight: top.species, showValues: true }),
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
            // Temperature is carried by the BAR'S COLOUR \u2014 not a second axis,
            // and not the label.
            //
            // Height is visits, colour is temperature, so a single mark holds
            // both variables and the chart gains no extra furniture. Cold
            // blue to warm red is the one ramp nearly everybody reads without
            // a legend, so the relationship the question actually asks about
            // \u2014 do the warm days have the taller bars? \u2014 is visible before
            // anyone has read a number.
            //
            // The degrees stay in small type under each date. Once colour is
            // carrying the PATTERN, the number is supporting detail rather
            // than something that has to be decoded, and a 6\u20138 class needs
            // the real values to justify an answer.
            chart: cmChart('Visits each day \u2014 bar colour is that day\u2019s temperature',
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
            // The run-up, with today marked AND tomorrow drawn as an empty
            // slot. A prediction chart that stops at today asks the class to
            // imagine the thing they are predicting; showing it as a dashed
            // box with a question mark puts it on the axis where it belongs,
            // and makes plain that the answer does not exist yet.
            chart: cmChart(`Visits each day at ${feeder}`,
                           cmDaySeries(s).concat([{
                               label: cmDayAxisLabel(tomorrowKey),
                               value: 0, key: tomorrowKey, pending: true,
                           }]),
                           { band, highlight: todayKey, ordered: true, kind: 'bars' }),
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

        const built = cmChoices(String(pick.n),
                                cmNumberDistractors(pick.n, rng, 2).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many ${pick.species}s came this week?`,
            ...built,
            chart: cmChart('Visits by species this week',
                           cmSpeciesSeries(s), { band, highlight: pick.species }),
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
        if (sorted[0].n === sorted[1].n) return null;

        const pick = sorted.slice(0, 4);
        const opts = cmShuffle(pick, rng);
        return {
            prompt: `Which day was quietest at ${feeder} this week?`,
            choices: opts.map(d => ({ label: cmDayAxisLabel(d.day) })),
            correct_index: opts.findIndex(d => d.day === sorted[0].day),
            chart: cmChart('Visits each day this week', cmDaySeries(s), { band }),
            explain: pick.map(d => `${cmDayAxisLabel(d.day)}: ${d.n}`).join(' · '),
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

// ── Colour and shape, for K–2 ────────────────────────────────────
//
// These ask about the birds rather than about the numbers, which is the
// point: a five-year-old who cannot yet read a bar chart can absolutely tell
// you which bird is red. They are still grounded in this feeder — every bird
// offered is one that actually came this week.

{
    id: 'which-bird-is-color',
    category: 'identification',
    title: 'Which bird is this colour?',
    bands: ['k-2'],
    build({ s, band, rng }) {
        // Only a colour exactly ONE of the birds on offer has, or the
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
    title: 'What colour is it?',
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
            prompt: `What colour is a ${species}?`,
            ...built,
            // No chart: this one is about the bird, not the data, and a chart
            // of visit counts beside it would only suggest the answer is in
            // there somewhere.
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
        // The "shape" half of colour/shape matching. Features are written so
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
        const todayKey = cmDayKey(new Date());
        const today = s.daySpec.get(todayKey);
        if (!today || !today.size) return null;

        const seenToday = [...today.keys()];
        const notToday = s.species.map(x => x.species).filter(sp => !today.has(sp));
        if (!seenToday.length || notToday.length < 2) return null;

        const answer = cmShuffle(seenToday, rng)[0];
        const built = cmChoices(answer, cmShuffle(notToday, rng).slice(0, 2), rng);
        if (!built) return null;
        return {
            prompt: 'Which of these birds came to the feeder TODAY?',
            ...built,
            explain: `${answer} came ${today.get(answer)} time(s) today. `
                   + `The others came earlier in the week, but not today.`,
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
    // The whole point is to solve it, not to recognise it in a list.
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

        const built = cmChoices(pick.species,
            cmLengthMatchedDistractors(
                s.species.map(x => ({ species: x.species, short: cmShortName(x.species) }))
                         .filter(x => x.species !== pick.species),
                pick.short.length, rng, band === 'k-2' ? 2 : 3).map(x => x.species), rng);
        if (!built) return null;
        return {
            prompt: `Which bird is this? ${jumbled.split('').join(' ')}`,
            ...built,
            explain: `${jumbled} unscrambles to ${pick.short} — the ${pick.species}. `
                   + `It came ${s.bySpecies.get(pick.species)} time(s) this week.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'missing-letters',
    category: 'puzzle',
    // The whole point is to solve it, not to recognise it in a list.
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
            cmLengthMatchedDistractors(pool.filter(x => x.species !== pick.species),
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
    // The whole point is to solve it, not to recognise it in a list.
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
    // The whole point is to solve it, not to recognise it in a list.
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
            cmLengthMatchedDistractors(pool.filter(x => x.species !== pick.species),
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
    // The whole point is to solve it, not to recognise it in a list.
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
            cmLengthMatchedDistractors(pool.filter(x => x.species !== pick.species),
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
        const pool = cmShuffle(BIRD_SOUNDS, rng);
        const pick = pool[0];
        const built = cmChoices(pick.bird, pool.slice(1, 4).map(x => x.bird), rng);
        if (!built) return null;
        return {
            template_id: 'sound-' + pick.bird.toLowerCase().replace(/\W+/g, '-'),
            prompt: `Birders learn songs by putting words to them. Which bird sounds `
                  + `like this?\n"${pick.says}"`,
            ...built,
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
    title: 'Match the colour',
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
            prompt: 'Which colour matches this bird?',
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
        const built = cmChoices(answer, [warm ? 'Cool' : 'Warm'], rng);
        if (!built) return null;

        const photo = cmShotFor(s, pick.species);
        return {
            prompt: 'Artists call red, orange and yellow WARM colours, and blue '
                  + `and grey COOL colours. The ${pick.species} is `
                  + `${pick.look.color}. Is that warm or cool?`,
            ...built,
            image: photo || null,
            chart: photo ? null : undefined,
            explain: `${pick.look.color} is a ${answer.toLowerCase()} colour.`,
            fact: speciesFact(pick.species, band),
        };
    },
},

{
    id: 'art-primary-color',
    category: 'art',
    title: 'Primary colours',
    bands: ['3-5'],
    build({ s, band, rng }) {
        // Needs at least two primaries actually present, or "which is not a
        // primary" is a question about one bird rather than about the idea.
        const pool = cmColorfulSpecies(s);
        const primaries = pool.filter(x => PRIMARY_COLORS.includes(x.look.color));
        const others    = pool.filter(x => !PRIMARY_COLORS.includes(x.look.color)
                                        && x.look.color !== 'black and white');
        if (primaries.length < 2 || !others.length) return null;

        const answer = cmShuffle(others, rng)[0];
        const built = cmChoices(answer.species,
            cmShuffle(primaries, rng).slice(0, 3).map(x => x.species), rng);
        if (!built) return null;

        return {
            prompt: 'Artists call red, yellow and blue the PRIMARY colours — '
                  + 'you cannot mix any other paints to make them. Which of these '
                  + 'birds is NOT wearing a primary colour?',
            ...built,
            explain: `The ${answer.species} is ${answer.look.color}, which is not `
                   + `red, yellow or blue. The others are.`,
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
        // Anchored to a bird that is actually orange, so the mixing question
        // has something in the room to point at.
        const orange = cmColorfulSpecies(s, ['orange'])[0];
        if (!orange) return null;

        const built = cmChoices('red + yellow',
            ['blue + yellow', 'red + blue', 'black + white'], rng);
        if (!built) return null;

        const photo = cmShotFor(s, orange.species);
        return {
            prompt: `The ${orange.species} came to our feeder this week. Its `
                  + 'orange is not a primary colour — which two paints would '
                  + 'you mix to make it?',
            ...built,
            image: photo || null,
            explain: 'Red and yellow make orange. Blue and yellow make green, '
                   + 'and red and blue make purple.',
            fact: speciesFact(orange.species, band),
        };
    },
},

{
    id: 'art-missing-color',
    category: 'art',
    title: 'The colour that stayed away',
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

        return {
            prompt: 'Which of these colours did NOT come to our feeder this week?',
            ...built,
            chart: cmChart('Birds that came this week', cmSpeciesSeries(s), { band }),
            explain: `No ${answer} birds this week.`,
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
        const days = cmDaySeries(s).slice(-2);
        if (days.length < 2) return null;
        const total = days.reduce((a, d) => a + d.value, 0);
        if (total < 4) return null;

        // Pick a divisor that divides cleanly, so the answer is a whole
        // number of scoops rather than a remainder nobody asked about.
        const per = [2, 3, 4, 5].filter(n => total % n === 0).pop();
        if (!per) return null;
        const answer = total / per;

        const built = cmChoices(String(answer),
            cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;

        return {
            prompt: `Our class puts out one scoop of seed for every ${per} visits. `
                  + `There were ${days[0].value} visits on ${cmDayProse(days[0].key)}, `
                  + `and ${days[1].value} visits on ${cmDayProse(days[1].key)}. `
                  + 'How many scoops of seed do we owe the feeder?',
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s), { band, ordered: true }),
            explain: `${days[0].value} + ${days[1].value} = ${total} visits. `
                   + `${total} ÷ ${per} = ${answer} scoops.`,
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

// ── Maths across the bands ───────────────────────────────────────
//
// The curriculum a K-8 class is actually working through, asked against this
// week's feeder. The feeder supplies the numbers; the skill being practised
// is the one named in the title.

{
    id: 'count-one-day',
    category: 'math',
    // Not "Counting": the picker lists this under Maths, directly below a
    // whole subject called Counting, and "Maths > Counting" reads as either
    // a mistake or a duplicate. The only title in all 104 that collided with
    // a subject name.
    title: 'Birds on one day',
    bands: ['k-2'],
    build({ s, band, rng }) {
        const days = cmDaySeries(s).filter(d => d.value > 0 && d.value <= 20);
        if (!days.length) return null;
        const pick = cmShuffle(days, rng)[0];
        const built = cmChoices(String(pick.value),
                                cmNumberDistractors(pick.value, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `How many birds came on ${cmDayProse(pick.key)}?`,
            ...built,
            chart: cmChart('Visits each day', cmDaySeries(s),
                           { band, highlight: pick.key }),
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
            chart: cmChart(dial ? 'What time is it?' : 'When the birds came', series,
                           { band, hours: true, kind: 'clock',
                             hands: dial ? { hour: busiest.h, minute: 0 } : null }),
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
        const days = cmDaySeries(s).filter(d => d.value > 0);
        if (!days.length) return null;
        const pick = cmShuffle(days, rng)[0];
        if (pick.value < 2 || pick.value > 15) return null;
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
        const groups = [2, 3, 4, 5].filter(n => total % n === 0 && total / n >= 2);
        if (!groups.length) return null;
        const per = cmShuffle(groups, rng)[0];
        const answer = total / per;
        const built = cmChoices(String(answer),
                                cmNumberDistractors(answer, rng, 3).map(String), rng);
        if (!built) return null;
        return {
            prompt: `Our feeder had ${total} visits this week. If ${per} groups of `
                  + 'children shared the job of counting them equally, how many '
                  + 'would each group count?',
            ...built,
            explain: `${total} ÷ ${per} = ${answer} each.`,
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
             'She cannot make bright colours',
             'Brown feathers are warmer'], rng);
        if (!built) return null;
        return {
            prompt: 'In many birds the male is brightly coloured and the female is '
                  + 'plain brown. Why would being dull be an ADVANTAGE?',
            ...built,
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
            explain: 'Straight down the middle: one wing, one eye and one foot on '
                   + 'each side, mirrored. Almost every animal is built this way, '
                   + 'which is why a drawing looks wrong the moment it is not.',
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
    title: 'Complementary colours',
    bands: ['6-8'],
    needsData: false,
    build({ rng }) {
        const built = cmChoices('Green', ['Blue', 'Orange', 'Yellow'], rng);
        if (!built) return null;
        return {
            prompt: 'On the colour wheel, complementary colours sit opposite each '
                  + 'other and make each other look brighter. A cardinal is red — '
                  + 'which colour is its complement?',
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

    const picked = classroomPickSet(room);

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

    const ordered = cmShuffle(out, cmRng(seed + '|order'));
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
    byHour: new Array(24).fill(0), daySpec: new Map(), snapshots: [],
    distinct: 0, avgTemp: null, tempCoverage: 0, dayTemp: new Map(),
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
function classroomPickSet(room) {
    const picks = room && room.template_picks;
    if (!Array.isArray(picks) || !picks.length) return null;
    return new Set(picks);
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

function buildClassroomQuestions(room, data, opts) {
    const o = opts || {};
    const source = cmPickSource(data);

    // A feeder with nothing on it used to mean no lesson at all: the function
    // gave up here and the stage said "not enough data yet". That was true
    // when every question was computed from detections. It is not true now -
    // the fact slides, the colour and language questions and the state-bird
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

    const picked = classroomPickSet(room);

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
            const plotted = new Set(q.chart.series.map(r => String(r.value)));
            const givesItAway = (q.choices || []).some(c =>
                (String(c.label).match(/\d+/g) || []).some(num => plotted.has(num)));
            if (!givesItAway) q.chart.showValues = true;
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
            scope:       source.isHome ? 'home' : 'partner',
            source_feeder_id:   source.feederId,
            source_feeder_name: source.name,
            from_partner: !source.isHome,
            ...q,
        });
    }

    const rng = cmRng(seed + '|order');
    const ident = out.filter(q => q.category === 'identification');
    let   rest  = cmShuffle(out.filter(q => q.category !== 'identification'), rng);

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

    const ordered = ident.concat(rest);

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
    const fbBtn = document.getElementById('classroom-feedback-btn');
    if (fbBtn) fbBtn.style.display = classroomCanAssign() ? '' : 'none';
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

// Whether the list shows every classroom or only the one the picker names.
// Default is "only this one": a dropdown naming 3-5 sitting above a list of
// all three classrooms reads as a filter that does not work, which is exactly
// how it was reported. One class at a time is also what the panel is FOR -
// you run one lesson, review one set, read one set of results.
let classroomShowAll = false;

function setClassroomShowAll(on) {
    classroomShowAll = !!on;
    renderClassroomList();
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

    // Keep the picker in step FIRST: the filter below reads its value, and on
    // the first render it has no options yet.
    syncClassroomPicker();

    const picked = classroomPicked();
    const shown = (classroomShowAll || !picked)
        ? classroomList
        : classroomList.filter(r => r.id === picked);

    const others = classroomList.length - shown.length;
    const toggle = classroomList.length < 2 ? '' : `
        <div class="classroom-list-toggle">
            ${classroomShowAll
                ? `<button class="classroom-btn" onclick="setClassroomShowAll(false)">
                     Show only the class above</button>`
                : `<button class="classroom-btn" onclick="setClassroomShowAll(true)">
                     Show all ${classroomList.length} classes</button>`}
            ${others > 0 ? `<span class="classroom-muted">${others} hidden</span>` : ''}
        </div>`;

    list.innerHTML = toggle + shown.map(r => {
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
                    <button class="classroom-btn classroom-btn-more" title="Edit, link, delete"
                            onclick="toggleClassroomMore('${esc(r.id)}')">⋯</button>
                </div>
            </div>
            <div class="classroom-card-meta">
                ${feederLine}
                ${partners.length ? ` · partners: ${esc(partners.join(', '))}` : ''}
                ${r.session_count ? ` · ${r.session_count} session${r.session_count === 1 ? '' : 's'}` : ''}
                ${r.is_mine ? '' : ` · taught by ${esc(r.teacher_label)}`}
            </div>
            <div class="classroom-card-more" id="classroom-more-${esc(r.id)}" style="display:none;">
                <button class="classroom-btn" onclick="editClassroom('${esc(r.id)}')">Edit</button>
                <button class="classroom-btn" onclick="copyClassroomLink('${esc(r.id)}')"
                        title="A link that opens straight into this class">🔗 Link</button>
                <button class="classroom-btn-danger" onclick="deleteClassroom('${esc(r.id)}')">Delete</button>
            </div>
            <div class="classroom-pending" id="classroom-pending-${esc(r.id)}"></div>
        </div>`;
    }).join('');
}

/**
 * Keep the between-lessons class picker in step with the list.
 *
 * Rebuilt rather than patched, because classrooms can be created, renamed,
 * deleted or handed to another teacher while the panel is open. The current
 * choice survives the rebuild where that class still exists, so refreshing
 * the list cannot quietly move Review and Results onto a different class
 * than the one showing.
 */
function syncClassroomPicker() {
    const pick = document.getElementById('classroom-pick');
    if (!pick) return;

    // Re-render on change, so choosing a class actually shows that class.
    if (!pick.dataset.wired) {
        pick.dataset.wired = '1';
        pick.addEventListener('change', () => renderClassroomList());
    }

    const wanted = pick.value;
    pick.innerHTML = classroomList.map(r =>
        `<option value="${esc(r.id)}">${esc(r.name)}`
        + ` — ${esc(GRADE_BAND_LABELS[r.grade_band] || r.grade_band)}</option>`).join('');

    if (classroomList.some(r => r.id === wanted)) pick.value = wanted;

    // Nothing to review or report on until there is a class.
    const bar = pick.closest('.classroom-toolbar');
    if (bar) bar.classList.toggle('no-classes', !classroomList.length);
}

function classroomPicked() {
    return document.getElementById('classroom-pick')?.value || null;
}

/**
 * Edit, Link and Delete live behind this.
 *
 * Seven buttons per classroom pushed three classes past a screenful, which
 * made the common case - start the lesson that is about to begin - a scroll.
 * The two that start a lesson stay out; the three you touch a few times a
 * year fold away.
 */
function toggleClassroomMore(roomId) {
    const box = document.getElementById(`classroom-more-${roomId}`);
    if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
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
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Building a lesson from the feeder…</div>';

    const data = await loadClassroomData(room);
    const { questions, source, built, offered } =
        buildClassroomQuestions(room, data, { all: true });
    classroomReviewRoom = room;
    classroomReviewQuestions = questions;

    if (!questions.length) {
        box.innerHTML = `<div class="classroom-muted">
            ${esc(room.home_feeder_name || 'This feeder')} hasn't logged enough
            visits to build a lesson from, so there is nothing to review yet.</div>
            <button class="classroom-btn" onclick="hideClassroomReview()">Close</button>`;
        return;
    }

    const band = GRADE_BAND_LABELS[room.grade_band] || room.grade_band;
    box.innerHTML = `
        <h4 class="classroom-h">Questions for ${esc(room.name)} — ${esc(band)}</h4>
        <p class="classroom-muted">
            All ${built} question${built === 1 ? '' : 's'} this band can build from
            ${esc(source.name)}${source.isHome ? '' : ' (a partner feeder)'} today,
            exactly as a class would see them. A lesson shows
            ${CLASSROOM_QUESTIONS_PER_SESSION} of these; this is the whole set, so
            nothing goes unreviewed just because a lesson did not pick it.
            ${offered > built
                ? `<br><span class="classroom-warn">${offered - built} more
                   template${offered - built === 1 ? '' : 's'} exist for this band but
                   had nothing to say about this week's data.</span>`
                : ''}
        </p>
        <div class="classroom-review-list">
            ${questions.map((q, i) => classroomReviewItem(q, i)).join('')}
        </div>
        <button class="classroom-btn" onclick="hideClassroomReview()">Close</button>`;
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
                <span class="classroom-pill">${esc(q.category)}</span>
                <code class="classroom-review-tid">${esc(q.template_id)}</code>
                ${q.from_partner ? '<span class="classroom-pill partner">partner data</span>' : ''}
            </div>
            ${slide ? `<div class="classroom-review-slide">${slide}</div>` : ''}
            ${classroomIntroHtml(q)}
            <p class="classroom-review-prompt">${esc(q.prompt)}</p>
            <ol class="classroom-review-choices">${choices}</ol>
            ${q.correct_index == null
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
// "The bars are too far apart and maybe should be different colours" is worth
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
                   + 'it \u2014 spacing, colours, wording all count.',
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
        chart_kind:       q.image ? 'photo' : (q.chart ? q.chart.kind : null),
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
            <button class="classroom-btn" onclick="hideClassroomReview()">Cancel</button>
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
            <button class="classroom-btn" onclick="hideClassroomReview()">Close</button>
        </div>`;
}

// ── Reading the feedback back ────────────────────────────────────
//
// Owner and moderator only, matching the RPC. The counts by template come
// first because the actionable question is which TEMPLATE keeps drawing
// complaints, not which question drew one.

async function showClassroomFeedback() {
    const box = document.getElementById('classroom-review');
    if (!box) return;
    hideClassroomHistory();
    box.style.display = '';
    box.innerHTML = '<div class="classroom-muted">Loading feedback…</div>';

    const { data, error } = await sbRpc('classroom_feedback_list',
        { p_community_id: classroomCommunityId, p_include_resolved: false }, true);
    if (error) {
        box.innerHTML = `<div class="classroom-error">${esc(error.message || 'Could not load.')}</div>`
                      + '<button class="classroom-btn" onclick="hideClassroomReview()">Close</button>';
        return;
    }

    const items = (data && data.items) || [];
    const byTemplate = (data && data.by_template) || [];
    if (!items.length) {
        box.innerHTML = '<div class="classroom-muted">No open feedback. '
                      + 'Use "Review questions" on a class to go through a lesson and flag anything that reads badly.</div>'
                      + '<button class="classroom-btn" onclick="hideClassroomReview()">Close</button>';
        return;
    }

    const REASONS = { unclear: 'unclear', wrong: 'answer looks wrong',
                      too_hard: 'too hard', too_easy: 'too easy',
                      bad_visual: 'photo or chart', improvement: 'would be better',
                      idea: 'new question idea', other: 'other' };

    // Kept so the bulk action acts on exactly what is on screen.
    classroomFeedbackShown = items.map(f => f.id);

    box.innerHTML = `
        <h4 class="classroom-h">Question feedback (${items.length} open)</h4>
        <p class="classroom-muted">Most flagged templates:
            ${byTemplate.slice(0, 5).map(t => `<code>${esc(t.template_id)}</code> ×${t.n}`).join(' · ')}</p>
        <div class="classroom-form-actions">
            <button class="classroom-btn" onclick="resolveAllClassroomFeedback()">
                ✓ Mark all ${items.length} as addressed</button>
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
                <button class="classroom-btn" onclick="resolveClassroomFeedback('${esc(f.id)}')">Mark handled</button>
            </div>`).join('')}
        </div>
        <button class="classroom-btn" onclick="hideClassroomReview()">Close</button>`;
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
                <select id="classroom-grade-band" onchange="renderClassroomPickChecks()">
                    <option value="k-2"${editing?.grade_band === 'k-2' ? ' selected' : ''}>K–2 — pictures and counting</option>
                    <option value="3-5"${editing?.grade_band === '3-5' ? ' selected' : ''}>Grades 3–5 — charts and averages</option>
                    <option value="6-8"${editing?.grade_band === '6-8' ? ' selected' : ''}>Grades 6–8 — percents and trends</option>
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
    math:           'Maths',
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
    renderClassroomForm();
    document.getElementById('classroom-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelClassroomEdit() {
    classroomEditingId = null;
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
    const size   = parseInt(document.getElementById('classroom-quiz-size')?.value, 10);
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
        await saveClassroomQuizSize(roomId, size, say);
        await saveClassroomTemplatePicks(roomId, say);
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

    // Both in parallel: the recent-template list is a nicety and should not
    // add a round trip to the wait a class is watching.
    const [data, recent] = await Promise.all([
        loadClassroomData(room),
        loadClassroomRecentTemplates(room.id),
    ]);
    const { questions, source, no_data } = buildClassroomQuestions(room, data, { recent });

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
            ${q.correct_index == null
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
          <div class="classroom-fit">
            ${classroomEvidenceHtml(q, S.revealed)}
            ${classroomIntroHtml(q)}
            <h1 class="classroom-prompt">${esc(q.prompt)}</h1>
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
    if (!q.image || !q.image.url) return '';
    const hideCaption = q.category === 'identification' && !revealed;

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

    // Never below roughly a quarter of the slide: past that the photograph
    // stops being a photograph and the uniform scale may as well take over.
    const floor = Math.min(imgH, Math.max(120, available * 0.26));
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
                chart_kind:       q.image ? 'photo' : (q.chart ? q.chart.kind : null),
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
 * CURRENTLY ALWAYS EMPTY. community-qr.js is deliberately not loaded, because
 * the symbols it produces do not scan — confirmed against a phone camera on
 * both a join link and a plain 'HELLO' rendered large and clean. A QR on the
 * board that a class cannot scan is worse than no QR: thirty children try it,
 * it fails, and the lesson stops while the teacher works out why. The address
 * and the code beside it are what the lobby relies on.
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
