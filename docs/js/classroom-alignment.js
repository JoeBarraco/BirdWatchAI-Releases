// ════════════════════════════════════════════════════════════════════
//  Which Florida benchmark each classroom question actually exercises
// ════════════════════════════════════════════════════════════════════
//
//  Hand-written, and it has to stay that way. docs/js/classroom-standards.js
//  is generated from CPALMS; this file is the judgement about what our
//  questions do, and a judgement belongs in a diff somebody read.
//
//  THE RULE, AND IT IS A NARROW ONE. ⚠
//  A template claims a benchmark only when the CHILD DOES THE THING THE
//  BENCHMARK DESCRIBES while answering. Not when the question is about the
//  same topic. Not when it is adjacent. MA.3.DP.1.2 says "interpret data
//  ... by solving one- and two-step problems": a question that shows the
//  week's bar chart and asks how many more visits Tuesday had than Friday
//  earns it. A question that asks which bird is prettiest, on the same
//  chart, does not.
//
//  AN EMPTY LIST IS A RESULT, NOT AN OMISSION.
//  Several templates claim nothing — the word puzzles especially. Jumbling
//  CHICKADEE is a pleasant thing to do with a bird name and it is not
//  Florida's ELA foundational-skills benchmark, which is about decoding
//  unfamiliar words using phonics, not about rearranging a word the child
//  has already been given. Leaving those blank is what makes the rest
//  worth reading. A teacher who finds one bogus tag has no reason to trust
//  any of the others.
//
//  WHY THIS MATTERS MORE THAN IT LOOKS.
//  "Aligned to SC.3.L.15.1" is the sentence that gets Classroom Mode past
//  a curriculum coordinator. It is also a claim a teacher repeats to their
//  principal with their own name on it. Over-tagging to make the coverage
//  grid look full would trade their credibility for our screenshot.
// ════════════════════════════════════════════════════════════════════

const CLASSROOM_TEMPLATE_STANDARDS = {

    // ── Identification: looking carefully at a real photograph ──────────
    //
    // These lean on Nature of Science rather than Life Science. A child
    // picking a Blue Jay out of four options is making an observation and
    // describing it, which is SC.K.N.1.2 — they are not classifying animals
    // into major groups (SC.3.L.15.1), whatever the subject feels like.
    'id-snapshot':         ['SC.K.N.1.2', 'SC.1.L.14.1', 'VA.4.C.1.2'],
    'clip-which-bird':     ['SC.K.N.1.2', 'SC.1.L.14.1', 'SC.1.N.1.2'],
    'which-bird-is-color': ['SC.1.N.1.2', 'VA.1.O.1.1'],
    'what-color-is':       ['SC.1.N.1.2', 'VA.1.O.1.1'],
    'spot-the-feature':    ['SC.1.N.1.2', 'SC.K.L.14.3'],

    // The clip poll is the strongest Nature-of-Science question in the whole
    // set, and it earns those codes precisely BECAUSE it has no right
    // answer: the class watches, votes, and is then told that what they saw
    // is an interpretation, not a record. That is SC.2.N.1.5 and SC.5.N.1.6
    // almost word for word.
    'clip-what-doing':     ['SC.1.N.1.2', 'SC.2.N.1.5', 'SC.3.N.1.6', 'SC.5.N.1.6'],

    // ── Counting: the category-and-count benchmarks ────────────────────
    'most-common-week':    ['MA.K.DP.1.1', 'MA.1.DP.1.2', 'MA.2.DP.1.2', 'MA.3.DP.1.2'],
    'total-visits':        ['MA.1.DP.1.2', 'MA.2.DP.1.2', 'MA.3.DP.1.2'],
    'species-variety':     ['MA.3.DP.1.2'],
    'count-one-species':   ['MA.K.NSO.1.1', 'MA.1.DP.1.2', 'MA.2.DP.1.2'],
    'did-it-visit':        ['MA.K.DP.1.1', 'MA.1.DP.1.2'],
    'how-many-days':       ['MA.K.NSO.1.1', 'MA.1.DP.1.2'],
    'came-today':          ['MA.K.DP.1.1'],

    // ── Comparison ─────────────────────────────────────────────────────
    'more-or-fewer':       ['MA.K.NSO.1.4', 'MA.K.DP.1.1', 'MA.1.DP.1.2'],
    'how-many-more':       ['MA.3.DP.1.2', 'MA.3.NSO.2.1'],
    'day-difference-k2':   ['MA.1.AR.1.2', 'MA.2.DP.1.2'],
    'day-difference':      ['MA.3.DP.1.2', 'MA.3.NSO.2.1'],
    'species-rank':        ['MA.3.DP.1.2'],
    'species-on-day':      ['MA.3.DP.1.2'],
    'week-over-week':      ['MA.7.DP.1.2'],

    // ── Time ───────────────────────────────────────────────────────────
    'busiest-day':         ['MA.1.DP.1.2', 'MA.2.DP.1.2', 'MA.3.DP.1.2'],
    'morning-or-afternoon':['MA.1.DP.1.2', 'MA.2.M.2.1'],
    'peak-hour':           ['MA.3.DP.1.2', 'MA.3.M.2.1'],
    'quietest-day':        ['MA.3.DP.1.2'],
    'compare-two-hours':   ['MA.3.DP.1.2', 'MA.3.M.2.1'],

    // ── Fractions, percents, averages, rates ───────────────────────────
    'fraction-species':    ['MA.3.FR.1.1', 'MA.3.FR.2.1', 'MA.4.DP.1.3'],
    'fraction-of-week':    ['MA.3.FR.1.1', 'MA.3.DP.1.2'],
    'percent-species':     ['MA.6.AR.3.4', 'MA.6.DP.1.2'],
    'percent-of-days':     ['MA.6.AR.3.4', 'MA.6.DP.1.2'],
    'percent-change':      ['MA.6.AR.3.4', 'MA.7.DP.1.2'],
    'visits-per-day':      ['MA.4.DP.1.3', 'MA.5.DP.1.2'],
    'above-average-days':  ['MA.4.DP.1.3', 'MA.5.DP.1.2'],
    'median-daily':        ['MA.6.DP.1.2'],
    'mean-vs-median':      ['MA.6.DP.1.2', 'MA.7.DP.1.1'],
    'day-range':           ['MA.6.DP.1.2', 'MA.6.DP.1.4'],
    'visits-rate':         ['MA.6.AR.3.2', 'MA.6.AR.3.5'],
    'unit-rate':           ['MA.6.AR.3.2', 'MA.6.AR.3.5'],
    'ratio-two-species':   ['MA.6.AR.3.1'],
    'proportion-scale':    ['MA.6.AR.3.4', 'MA.7.DP.1.3'],
    'expected-count':      ['MA.6.AR.3.5', 'MA.7.DP.1.3'],
    'integer-temp-change': ['MA.6.NSO.1.2'],

    // Temperature against visits is two variables moving together, which is
    // the 8th-grade association benchmark — and it is also a test variable
    // and an outcome variable, which is why SC.7.N.1.4 is here too.
    'warm-or-cold':        ['MA.8.DP.1.2', 'SC.7.N.1.4'],

    // ── Probability ────────────────────────────────────────────────────
    'probability-next':    ['MA.7.DP.2.2', 'MA.7.DP.2.3'],
    'probability-two-same':['MA.7.DP.2.3', 'MA.8.DP.2.2'],

    // ── Word problems built on the week's own numbers ──────────────────
    'word-seed-scoops':    ['MA.3.AR.1.2', 'MA.4.DP.1.3'],
    'word-watch-minutes':  ['MA.3.AR.1.2', 'MA.4.M.2.1'],
    'word-feeder-empty':   ['MA.6.AR.3.2', 'MA.6.AR.3.5'],
    'count-one-day':       ['MA.K.NSO.1.1', 'MA.1.DP.1.2'],
    'total-two-days':      ['MA.3.AR.1.2', 'MA.3.NSO.2.1', 'MA.4.DP.1.3'],
    'multiply-days':       ['MA.3.AR.1.2'],
    'divide-share':        ['MA.3.AR.1.2'],
    'round-nearest-ten':   ['MA.3.NSO.1.4'],
    'odd-or-even':         ['MA.2.AR.3.1'],
    'ordinal-rank':        ['MA.K.NSO.1.3', 'MA.3.DP.1.2'],
    'clock-hour':          ['MA.2.M.2.1', 'MA.3.M.2.1'],
    'elapsed-hours':       ['MA.3.M.2.2', 'MA.4.M.2.1'],

    // ── Prediction: a guess the data later marks ───────────────────────
    //
    // Worth the Nature-of-Science codes rather than only the maths ones.
    // The class commits to a prediction, the feeder settles it, and being
    // wrong is explicitly fine — SC.8.N.1.4 territory, taught early.
    'predict-tomorrow':    ['SC.3.N.1.6', 'SC.4.N.1.4', 'MA.4.DP.1.3'],
    'predict-week':        ['SC.4.N.1.4', 'MA.5.DP.1.2', 'MA.7.DP.1.3'],

    // ── Analysis ───────────────────────────────────────────────────────
    'weekday-weekend':     ['MA.6.DP.1.2', 'MA.7.DP.1.2'],
    'quiet-hours':         ['MA.6.DP.1.4'],

    // ── Puzzles ────────────────────────────────────────────────────────
    //
    // Deliberately almost empty. Unscrambling, masking letters, Caesar
    // shifts and word searches are good fun and good for recall of a name
    // the class has just met. None of them is a Florida benchmark: the ELA
    // foundational-skills standards are about decoding unfamiliar words,
    // and these questions hand the child the word.
    //
    // "Which one did NOT come?" is the exception, and only because the
    // answer is in the week's data rather than in the child's memory.
    'word-jumble':         [],
    'missing-letters':     [],
    'hidden-bird':         [],
    'letter-code':         [],
    'caesar-bird':         [],
    'odd-one-out':         ['MA.K.DP.1.1', 'MA.1.DP.1.2'],

    // ── Wonder ─────────────────────────────────────────────────────────
    'bird-wonder':         ['ELA.2.R.2.2'],

    // ── Language ───────────────────────────────────────────────────────
    'lang-syllables':      ['ELA.1.F.1.2'],
    'lang-compound-word':  ['ELA.1.V.1.2'],
    'lang-alphabetical':   ['ELA.1.V.1.3'],
    'lang-adjective':      ['ELA.3.C.3.1'],
    'lang-idiom':          ['ELA.3.V.1.3', 'ELA.6.V.1.3'],
    'lang-onomatopoeia':   ['ELA.3.V.1.3'],
    'lang-prefix':         ['ELA.6.V.1.2', 'ELA.6.V.1.3'],
    'bird-collective-noun':['ELA.3.V.1.3', 'ELA.6.V.1.3'],
    'bird-by-sound':       ['ELA.3.V.1.3', 'MU.K.C.1.2', 'MU.2.C.1.4'],

    // ── Science ────────────────────────────────────────────────────────
    'sci-what-birds-need':  ['SC.1.L.17.1', 'SC.2.L.17.1'],
    'sci-feathers':         ['SC.K.L.14.3'],
    'sci-baby-bird':        ['SC.2.L.16.1'],
    'sci-beak-shape':       ['SC.4.L.16.3', 'SC.5.L.17.1'],
    'sci-life-cycle':       ['SC.4.L.16.4'],
    'sci-why-migrate':      ['SC.3.L.17.1', 'SC.4.L.17.1'],
    'sci-camouflage':       ['SC.5.L.15.1', 'SC.5.L.17.1'],
    'sci-food-chain':       ['SC.4.L.17.2', 'SC.4.L.17.3'],
    'sci-trophic-level':    ['SC.7.L.17.1'],
    'sci-natural-selection':['SC.7.L.15.2'],
    'sci-introduced-species':['SC.7.L.17.3', 'SC.7.E.6.6'],
    'sci-variable':         ['SC.6.N.1.2', 'SC.7.N.1.4'],

    // ── Geography ──────────────────────────────────────────────────────
    'geo-cardinal-range':   ['SS.3.G.2.2', 'SS.5.G.1.6'],
    'geo-continents':       ['SS.3.G.1.3'],
    'geo-hemisphere':       ['SS.6.G.1.1'],
    'geo-flyway':           ['SS.6.G.4.2'],
    'bird-state-symbol':    ['SS.3.G.2.2', 'SS.5.G.1.6'],

    // ── History ────────────────────────────────────────────────────────
    //
    // Tagged to science, not to social studies. Florida's 6-8 American
    // history benchmarks are organised around periods and documents; the
    // Passenger Pigeon question is about a species failing to survive a
    // changed environment, which is SC.7.L.15.3.
    'hist-passenger-pigeon':['SC.7.L.15.3', 'SC.7.E.6.6'],
    'hist-feather-trade':   ['SC.7.E.6.6'],

    // ── Art ────────────────────────────────────────────────────────────
    'art-color-match':      ['VA.1.O.1.1'],
    'art-warm-cool':        ['VA.1.O.1.1', 'VA.4.O.1.2'],
    'art-primary-color':    ['VA.4.O.1.2'],
    'art-color-mix':        ['VA.4.O.1.2', 'VA.68.C.3.1'],
    'art-missing-color':    ['VA.1.O.1.1', 'MA.K.DP.1.1'],
    'art-symmetry':         ['MA.2.GR.1.3', 'MA.3.GR.1.3', 'VA.4.O.1.2'],
    'art-pattern':          ['VA.1.O.1.1', 'MA.3.AR.3.3'],
    'art-scale':            ['VA.4.O.1.2', 'VA.68.C.3.1'],
    'art-complementary':    ['VA.68.C.3.1'],

    // ── Music ──────────────────────────────────────────────────────────
    'music-pitch':          ['MU.K.C.1.2', 'MU.1.C.1.2', 'MU.3.O.1.1'],
    'music-rhythm':         ['MU.3.S.2.1', 'MU.3.S.3.4'],

    // Why a bird sings is behaviour, not musicianship. Tagged to the
    // animal-behaviour benchmark and nothing in MU, because nothing in MU
    // is about what a sound is FOR.
    'music-dawn-chorus':    ['SC.4.L.16.3'],

    // ════════════════════════════════════════════════════════════════
    //  Written from the gaps this file found
    // ════════════════════════════════════════════════════════════════

    // ── Reading a chart ──────────────────────────────────────────────
    //
    // Note what picto-read does NOT claim. MA.2.DP.1.1 and MA.3.DP.1.1 say
    // "collect and represent"; a child reading our pictograph is doing
    // neither — the chart did the representing. It earns the INTERPRET
    // benchmarks and only those. The scaled pictograph was still worth
    // building: reading one with a key of 5 is a different skill from
    // reading a tally chart, and it is the one MA.3.DP.1.2 names.
    'picto-read':          ['MA.1.DP.1.2', 'MA.2.DP.1.2', 'MA.3.DP.1.2'],
    'chart-title':         ['ELA.1.R.2.1', 'ELA.2.R.2.1', 'MA.2.DP.1.2', 'MA.3.DP.1.2'],

    // ── Centre and spread ────────────────────────────────────────────
    'mode-daily':          ['MA.4.DP.1.2', 'MA.6.DP.1.2'],
    'box-quartile':        ['MA.6.DP.1.3'],
    'histogram-spread':    ['MA.6.DP.1.4'],
    'center-shift':        ['MA.6.DP.1.6', 'MA.7.DP.1.1'],

    // ── Two variables ────────────────────────────────────────────────
    'scatter-temp':        ['MA.8.DP.1.1', 'MA.8.DP.1.2'],
    'fit-line':            ['MA.8.DP.1.3'],
    'circle-graph':        ['MA.7.DP.1.4', 'MA.6.AR.3.4'],
    'compare-feeders':     ['MA.7.DP.1.2'],
    'sample-space':        ['MA.7.DP.2.1'],

    // ── Nature of science ────────────────────────────────────────────
    'observe-or-infer':    ['SC.3.N.1.6', 'SC.4.N.1.6', 'SC.5.N.1.6', 'SC.7.N.1.6'],
    'results-support':     ['SC.7.N.1.6', 'SC.8.N.1.3'],
    'replication-repetition': ['SC.6.N.1.2', 'SC.7.N.1.2'],
    'stat-question':       ['MA.6.DP.1.1'],

    // ── Life science ─────────────────────────────────────────────────
    'classify-animal':      ['SC.3.L.15.1'],
    'parents-and-variation':['SC.1.L.16.1'],
    'habitat-needs':        ['SC.1.L.17.1', 'SC.2.L.17.2'],

    // ── Geography ────────────────────────────────────────────────────
    'geo-latlong':          ['SS.5.G.1.2', 'SS.6.G.1.1'],
    'geo-read-chart':       ['SS.3.G.1.1'],

    // ── Argument ─────────────────────────────────────────────────────
    'claim-evidence':       ['ELA.3.R.2.4', 'ELA.4.R.2.4', 'ELA.5.R.2.4'],
};

/**
 * Every benchmark a set of asked questions touched, in catalogue order.
 *
 * Takes whatever carries a template id — a live question, a history row —
 * so the lesson report and the challenge preview can share one path.
 */
function classroomStandardsFor(items) {
    const seen = new Set();
    (items || []).forEach(q => {
        const id = q && (q.template_id || q.templateId || q.id);
        (CLASSROOM_TEMPLATE_STANDARDS[id] || []).forEach(c => seen.add(c));
    });
    return Object.keys(CLASSROOM_STANDARDS).filter(c => seen.has(c));
}

/**
 * Template ids that cover at least one of `codes`.
 *
 * The teacher picks benchmarks; the challenge builder needs templates.
 */
function classroomTemplatesForStandards(codes) {
    const want = new Set(codes || []);
    return Object.keys(CLASSROOM_TEMPLATE_STANDARDS)
        .filter(id => CLASSROOM_TEMPLATE_STANDARDS[id].some(c => want.has(c)));
}

// ── Self-check ──────────────────────────────────────────────────────
//
// Runs once, in the browser, and only complains to the console. Three ways
// this file rots, all of them silent without it:
//
//   1. A code is typed wrong, or CPALMS retires a benchmark, and the chip
//      renders as a dead code pointing at a search that finds nothing.
//   2. A template is renamed or deleted and its alignment is orphaned —
//      the question stops claiming anything and nobody notices.
//   3. A k-2 template claims a 6-8 benchmark. That is the dangerous one:
//      it is the error that makes a coverage report look better than the
//      lesson was, which is the exact lie this whole file exists to avoid.
//
// Deliberately not an exception. A mis-typed benchmark must not stop a
// lesson that is already running.
(function checkClassroomAlignment() {
    if (typeof CLASSROOM_STANDARDS === 'undefined') return;
    const bad = [];

    Object.entries(CLASSROOM_TEMPLATE_STANDARDS).forEach(([id, codes]) => {
        codes.forEach(c => {
            if (!CLASSROOM_STANDARDS[c]) bad.push(`${id}: unknown benchmark ${c}`);
        });
    });

    if (typeof CLASSROOM_TEMPLATES !== 'undefined') {
        const known = new Set(CLASSROOM_TEMPLATES.map(t => t.id));
        Object.keys(CLASSROOM_TEMPLATE_STANDARDS).forEach(id => {
            if (!known.has(id)) bad.push(`alignment for a template that no longer exists: ${id}`);
        });
        CLASSROOM_TEMPLATES.forEach(t => {
            if (!(t.id in CLASSROOM_TEMPLATE_STANDARDS)) {
                bad.push(`${t.id}: no alignment entry — add one, or [] to say so on purpose`);
            }
            (CLASSROOM_TEMPLATE_STANDARDS[t.id] || []).forEach(c => {
                const s = CLASSROOM_STANDARDS[c];
                if (s && !s.bands.some(b => t.bands.includes(b))) {
                    bad.push(`${t.id} (${t.bands.join('/')}) claims ${c}, which is ${s.bands.join('/')}`);
                }
            });
        });
    }

    if (bad.length) console.warn('[classroom alignment]\n  ' + bad.join('\n  '));
})();
