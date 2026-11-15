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
    'word-seed-scoops':    ['MA.3.AR.1.2', 'MA.4.DP.1.3', 'MA.5.AR.1.1'],
    'word-watch-minutes':  ['MA.3.AR.1.2', 'MA.4.M.2.1'],
    'word-feeder-empty':   ['MA.6.AR.3.2', 'MA.6.AR.3.5'],
    'count-one-day':       ['MA.K.NSO.1.1', 'MA.1.DP.1.2'],
    'total-two-days':      ['MA.3.AR.1.2', 'MA.3.NSO.2.1', 'MA.4.DP.1.3'],
    'multiply-days':       ['MA.3.AR.1.2'],
    'divide-share':        ['MA.3.AR.1.2', 'MA.5.AR.1.1'],
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

    // ════════════════════════════════════════════════════════════════
    //  Second batch from the gap list
    // ════════════════════════════════════════════════════════════════
    //
    // Mostly Nature of Science, which is what was left: observation,
    // inference, evidence, records, repeatability. Those are also the
    // benchmarks that most need a real photograph to be asked honestly,
    // which is why this batch is heavy on them.

    // ── Looking carefully ────────────────────────────────────────────
    'observe-carefully':    ['SC.K.N.1.2', 'SC.K.N.1.5', 'SC.1.N.1.4'],
    'how-do-you-know':      ['SC.1.N.1.3', 'SC.1.N.1.4'],
    'same-tools-different-counts': ['SC.2.N.1.2', 'SC.3.N.1.2'],
    'repeat-the-count':     ['SC.2.N.1.4'],
    'keeping-records':      ['SC.1.N.1.3', 'SC.3.N.1.3'],
    'evidence-or-opinion':  ['SC.3.N.1.7', 'SC.4.N.1.7', 'SC.5.N.1.6', 'SC.5.N.2.1'],
    'art-read-the-photo':   ['VA.3.C.1.2', 'VA.5.C.1.2', 'VA.4.C.1.2'],

    // ── Numbers ──────────────────────────────────────────────────────
    'order-the-days':       ['MA.1.NSO.1.4', 'MA.2.NSO.1.3', 'MA.1.DP.1.2'],
    'ten-more-ten-less':    ['MA.1.NSO.2.3'],
    'round-to-ten':         ['MA.2.NSO.1.4'],
    'two-step-k2':          ['MA.2.AR.1.1', 'MA.1.AR.1.2'],
    'extend-pattern':       ['MA.4.AR.3.2', 'MA.3.AR.3.3'],
    'multi-step-seed':      ['MA.5.AR.1.1', 'MA.4.DP.1.3'],
    'equivalent-fractions': ['MA.4.FR.1.3'],
    'temp-difference':      ['MA.3.M.1.2'],

    // ── Geography ────────────────────────────────────────────────────
    'map-elements':         ['SS.1.G.1.2'],
    'equator-poles':        ['SS.2.G.1.3'],
    // Tagged to the weather benchmark and to Nature of Science, because
    // the answer is about how you would FIND OUT — which is the plan of
    // an investigation, not a fact about Florida.
    'weather-impact':       ['SS.4.G.1.3', 'SC.5.N.1.6'],

    // ── Words ────────────────────────────────────────────────────────
    'roots-in-names':       ['ELA.3.V.1.2', 'ELA.4.V.1.2', 'ELA.5.V.1.2'],
    'chart-and-words':      ['ELA.1.R.2.3', 'ELA.1.R.2.1'],

    // ── 6-8 ──────────────────────────────────────────────────────────
    'which-chart':          ['MA.7.DP.1.5'],
    'linnaean-names':       ['SC.6.L.15.1'],
    'feeder-competition':   ['SC.7.L.17.2', 'SC.7.L.17.3'],
    'predict-from-probability': ['MA.8.DP.2.3', 'MA.7.DP.1.3'],
    'feeder-impact':        ['SC.4.L.17.4'],

    // ── Music, unblocked by the recordings ───────────────────────────
    //
    // These six were the last of the gap list and they were blocked on
    // one thing: every benchmark asks a class to compare melodic and
    // rhythmic patterns BY EAR. Written against printed mnemonics they
    // would have been vocabulary questions wearing a music label, which
    // is the over-claiming this file exists to prevent. With real
    // recordings they are what the benchmarks describe, and each one
    // refuses to build without its audio.
    'music-same-or-different':  ['MU.K.O.1.2'],
    'music-high-or-low':        ['MU.2.O.1.1'],
    'music-match-written':      ['MU.2.S.3.4', 'MU.3.S.3.4'],
    'music-tempo-change':       ['MU.2.O.3.1'],
    'music-timbre':             ['MU.3.H.1.3'],
    'music-pitched-unpitched':  ['MU.1.C.1.3'],

    // ── Charts the class builds ──────────────────────────────────────
    //
    // These are the only questions in the set that may claim the
    // "collect and represent" benchmarks, and they may claim them
    // because the class actually represents something: a table of real
    // counts goes in, a chart they construct comes out. Every other
    // question in this file that touches data INTERPRETS it, which is a
    // different verb and a different benchmark.
    'build-tally':          ['MA.1.DP.1.1', 'MA.2.DP.1.1', 'MA.K.DP.1.1'],
    'build-pictograph':     ['MA.3.DP.1.1'],
    // SS.5.G.1.4 is "construct maps, charts and graphs to display
    // geographic information" — which bird visits a place and how often
    // is geographic information, and the class is constructing the chart
    // rather than reading one.
    'build-bar-chart':      ['MA.5.DP.1.1', 'MA.4.DP.1.1', 'SS.5.G.1.4'],

    // ── The last four ────────────────────────────────────────────────
    //
    // MA.6.DP.1.5 says CREATE a histogram, and this one does: the raw
    // daily counts are handed over unsorted and the class bins them
    // before a single bar goes up. Reading one is MA.6.DP.1.4, which
    // histogram-spread already has.
    'build-histogram':      ['MA.6.DP.1.5', 'MA.6.DP.1.4'],

    // MA.6.GR.1.1 wants a point PLOTTED in all four quadrants, so the
    // class plots one on a real grid. Counts and temperatures are
    // positive and never leave quadrant I; day-to-day CHANGES are signed,
    // which is what lets feeder data meet that clause at all.
    'plot-the-change':      ['MA.6.GR.1.1', 'MA.6.NSO.1.2'],

    // SC.K.N.1.1 is "collaborate with a partner to collect information",
    // which is an activity — and this is the only question in the set
    // that claims it, because the pair really does collect the
    // information: both count the clip alone, then compare.
    'partner-count':        ['SC.K.N.1.1', 'SC.K.N.1.2'],

    'lang-base-words':      ['ELA.2.V.1.2', 'ELA.1.V.1.2'],

    // ── Statistics the community site already draws ──────────────────
    //
    // These close no gap — every benchmark was covered before them. They
    // exist for variety, and they tag to benchmarks that were already
    // served, which is the normal case and not a problem: a benchmark
    // deserves more than one question.
    'stat-streak':          ['MA.3.DP.1.2', 'MA.3.AR.3.3'],
    'stat-new-arrival':     ['SC.3.L.17.1', 'SC.4.L.17.1'],
    'stat-pair-days':       ['SC.7.L.17.2', 'SC.7.N.1.6'],
    'stat-species-hour':    ['MA.3.M.2.1', 'MA.3.DP.1.2'],

    // ── Temperature ──────────────────────────────────────────────────
    //
    // Every detection has carried a temperature since the feeders were
    // built and almost nothing read it. These three do, and they are
    // shaped by published findings rather than by what feels true —
    // including a null result, which is the harder idea to teach.
    'temp-below-average':   ['MA.8.DP.1.2', 'MA.7.DP.1.2', 'SC.7.N.1.4'],
    'temp-what-else':       ['SC.7.N.1.4', 'SC.8.N.1.3', 'SC.6.N.1.2'],
    // Grounded in the feeder-watch literature rather than invented: the
    // two-peak argument, the dominance ranking, and the camera's own
    // non-birds. SC.8.N.1.3 is the point of the first - the research
    // disagrees with itself, so a class says "supports" or "fails to
    // support" rather than "right" or "wrong".
    'shape-of-the-day':    ['MA.6.DP.1.4', 'SC.8.N.1.3'],
    'who-gives-way':       ['SC.7.L.17.2', 'SC.7.L.17.3'],
    'not-a-bird':          ['SC.3.L.15.1'],

    // ── The confidence figure the detector has always recorded ─────────
    //
    // MA.7.DP.2.2 is "given the probability of a chance event, interpret the
    // likelihood of it occurring; compare the probabilities of chance
    // events", and confidence-compare is that benchmark almost word for
    // word: two stated figures, which is likelier, say why. The camera
    // supplies the two numbers and the two birds.
    //
    // confidence-same-bird and confidence-threshold both claim MA.6.DP.1.4,
    // "given a histogram ... qualitatively describe and interpret the spread
    // and distribution", and in both the histogram is the question rather
    // than decoration. One asks what a 59-point spread within a SINGLE
    // species means; the other asks what cutting that distribution off at
    // 80% would cost. Neither is tagged to a Nature of Science benchmark,
    // though both carry a Nature of Science lesson in the explanation: the
    // child is reading a distribution, not explaining what evidence is, and
    // the tag has to describe what they DO.
    //
    // confidence-same-bird was first written as "which species was the
    // camera least sure about, on average" and tagged MA.7.DP.1.2. Real data
    // retired it: the species means cluster within a few points of each
    // other on three sightings apiece, so the question would have rested on
    // noise. The spread inside one species is the real signal and the
    // honest question.
    'confidence-compare':    ['MA.7.DP.2.2'],
    'confidence-same-bird':  ['MA.6.DP.1.4'],
    'confidence-threshold':  ['MA.6.DP.1.4'],

    // SC.7.N.1.6 is "empirical evidence is the CUMULATIVE body of
    // observations on which scientific explanations are based", and the
    // cumulative is the whole point here: both forms of this question turn
    // on one feeder's fortnight being a small piece of a record built from
    // years of sightings by thousands of people. The child has to pick the
    // reading that says so.
    'rarity-one-sighting':   ['SC.7.N.1.6'],
    'temp-coldest-busiest': ['MA.3.M.1.2', 'SC.4.N.1.7'],
};

// ════════════════════════════════════════════════════════════════════
//  Seven templates do not record their own id
// ════════════════════════════════════════════════════════════════════
//
//  Most questions are stored under the id of the template that built
//  them. Seven are not: they override template_id with one derived from
//  the instance, so bird-by-sound files a question as
//  "sound-carolina-chickadee" and lang-idiom files one as
//  "lang-idiom-a-night-owl".
//
//  That is deliberate and worth keeping — the repeat-avoidance in
//  buildClassroomQuestions works on recorded ids, and without it a class
//  that met the night-owl idiom on Monday would count every other idiom
//  as "seen" too. But it means an alignment keyed on the template id
//  resolves to nothing for exactly those seven, and the questions render
//  with no benchmark chips while looking no different from a word puzzle
//  that genuinely claims none.
//
//  Resolved by prefix rather than by recording a second id, because that
//  also repairs HISTORY: lessons taught before any of this existed are
//  already stored under the instance ids, and nothing can go back and
//  add a field to them.
//
//  The bird-wonder case is the odd one — its instances are named
//  "wonder-<bird>" from the BIRD_WONDERS table rather than built from a
//  prefix the template controls, so the prefix is "wonder-".
//
//  ⚠ ORDER MATTERS. "lang-compound-" must be tested before "lang-" would
//  be, if a bare "lang-" prefix is ever added. Longest first.
const CLASSROOM_ID_PREFIXES = [
    ['lang-syllables-', 'lang-syllables'],
    ['lang-compound-',  'lang-compound-word'],
    ['lang-idiom-',     'lang-idiom'],
    ['geo-continent-',  'geo-continents'],
    ['collective-',     'bird-collective-noun'],
    ['sound-',          'bird-by-sound'],
    ['wonder-',         'bird-wonder'],
];

/**
 * The template a recorded question id belongs to.
 *
 * Returns the id unchanged when it is already a template's own — which is
 * the common case — and null for a teacher's own question, which claims
 * nothing because nobody but the teacher knows what it asks.
 */
function classroomTemplateIdOf(recordedId) {
    if (!recordedId) return null;
    if (CLASSROOM_TEMPLATE_STANDARDS[recordedId] !== undefined) return recordedId;
    if (recordedId.indexOf('teacher:') === 0) return null;
    for (const [prefix, id] of CLASSROOM_ID_PREFIXES) {
        if (recordedId.indexOf(prefix) === 0) return id;
    }
    return recordedId;
}

/**
 * Every benchmark a set of asked questions touched, in catalogue order.
 *
 * Takes whatever carries a template id — a live question, a history row —
 * so the lesson report and the challenge preview can share one path.
 *
 * ⚠ FILTERED BY THE BAND THE QUESTION WAS ASKED AT.
 * A template that serves K-2 and 3-5 claims benchmarks from both, because
 * it genuinely exercises both — at the band it was built for. The set of
 * codes is a property of the TEMPLATE; what a given lesson covered is a
 * property of the question as asked. Without this filter a fifth-grade
 * lesson reported MA.K.DP.1.1, which is the exact failure the header of
 * this file calls out: a coverage report flattering the lesson.
 *
 * A question with no band recorded falls back to every code the template
 * claims. That is the honest fallback for a row written before the band
 * was stored — better to over-list on old history than to silently drop
 * a lesson's coverage to nothing.
 */
function classroomStandardsFor(items) {
    const seen = new Set();
    (items || []).forEach(q => {
        // A question may carry its OWN benchmarks rather than inheriting
        // them from a template — that is how a teacher's hand-written
        // question gets counted. classroomTemplateIdOf returns null for
        // 'teacher:…' precisely because there is no template to look up,
        // so without this branch every teacher question in a lesson would
        // report as unaligned no matter how carefully it was tagged.
        if (q && Array.isArray(q.standards) && q.standards.length) {
            const band0 = q.grade_band || q.band;
            q.standards.forEach(c => {
                const s = CLASSROOM_STANDARDS[c];
                if (!band0 || !s || s.bands.includes(band0)) seen.add(c);
            });
            return;
        }
        const id   = classroomTemplateIdOf(q && (q.template_id || q.templateId || q.id));
        const band = q && (q.grade_band || q.band);
        (CLASSROOM_TEMPLATE_STANDARDS[id] || []).forEach(c => {
            const s = CLASSROOM_STANDARDS[c];
            if (!band || !s || s.bands.includes(band)) seen.add(c);
        });
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

    CLASSROOM_ID_PREFIXES.forEach(([prefix, id]) => {
        if (!(id in CLASSROOM_TEMPLATE_STANDARDS)) {
            bad.push(`id prefix "${prefix}" resolves to ${id}, which has no alignment entry`);
        }
    });

    if (typeof CLASSROOM_TEMPLATES !== 'undefined') {
        const known = new Set(CLASSROOM_TEMPLATES.map(t => t.id));
        CLASSROOM_ID_PREFIXES.forEach(([prefix, id]) => {
            if (!known.has(id)) bad.push(`id prefix "${prefix}" resolves to ${id}, which is not a template`);
        });
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
