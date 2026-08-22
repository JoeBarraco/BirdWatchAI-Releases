// ════════════════════════════════════════════════════════════════════
//  Feeder badges — the rule catalog and its UI
// ════════════════════════════════════════════════════════════════════
//
//  Ports the WinForms BadgeService achievements (Services/BadgeService.cs
//  in the BirdWatchAI repo) to the community dashboard, scored per feeder
//  so feeders can compete on shared sightings.
//
//  Data comes from the feeder_badge_stats view — one row per feeder of
//  raw aggregates (supabase/setup-feeder-badges.sql). Rules live HERE, in
//  plain JS, so adding a badge is a one-line edit and never a migration.
//  Badges are re-derived on every page load rather than stored, which
//  means a species correction automatically un-earns a badge — the thing
//  ReevaluateAllBadges() had to work at locally.
//
//  ── What did NOT come over from the app, and why ──────────────────
//
//  * The 9 runtime/session badges (marathon_session, thousand_hours,
//    hundred_sessions, week_runtime, …). They measure app uptime, which
//    never leaves the local machine. Nothing to score them against.
//  * first_exceptional / 3_exceptional. There is no "Exceptional" rarity
//    tier server-side — CommunityShareService.ToCommunityRarity only
//    emits Common/Uncommon/Rare/Very Rare — so they could never fire.
//  * The app's songbird_lover / raptor_spotter / family_master all
//    `return true` unconditionally (BadgeService.cs:1375), i.e. they are
//    free badges today. Rewritten here with real family logic.
//
//  That leaves 127 badges. The app had 138.
//
//  ── Fairness, which is the real design constraint ─────────────────
//
//  Community history starts when a feeder joined AND enabled sharing, so
//  every cumulative-count badge is partly a tenure trophy and a new
//  feeder can never catch up on the all-time board. Three consequences
//  are handled deliberately:
//
//    1. These are labelled "Community Badges — earned on shared
//       sightings", never presented as the in-app achievement count.
//       They will disagree with the app's own number and that is correct.
//    2. The leaderboard carries a points-per-active-day column so a
//       feeder that came online last month has something it can win.
//    3. Media badges are partly a config artifact (video_url is only
//       populated when clip sharing is on), so they are grouped last and
//       flagged in the modal rather than mixed into the headline count.
//
//  A true "badges earned this month" board needs unlock timestamps,
//  which needs the persisted feeder_badges table we deliberately did not
//  build. Points-per-day is the honest stand-in until then.
// ════════════════════════════════════════════════════════════════════

// ── Not-a-bird filter ───────────────────────────────────────────────
// The detector reports mammals too ("Squirrel" is live in the data), and
// they must not inflate the species-collection ladder.
const BADGE_NON_BIRDS = new Set([
    'squirrel', 'chipmunk', 'raccoon', 'opossum', 'possum', 'rabbit',
    'deer', 'cat', 'dog', 'fox', 'bear', 'rat', 'mouse', 'chipmonk',
    'human', 'person', 'unknown', 'none', 'background',
]);

function badgeIsBird(species) {
    return !BADGE_NON_BIRDS.has(String(species || '').trim().toLowerCase());
}

// ── Family classification ───────────────────────────────────────────
// The app matched families with SQL LIKE '%Woodpecker%' patterns. Same
// idea, but as regexes so the awkward cases can be spelled out: plenty
// of warblers aren't called "Warbler" (Common Yellowthroat, Ovenbird,
// Northern Parula, American Redstart — all live or plausible here), and
// "Louisiana Waterthrush" is a warbler that would otherwise be captured
// by the thrush pattern. `not` runs first and wins.
const BADGE_FAMILIES = [
    { family: 'Woodpeckers',   re: /woodpecker|flicker|sapsucker/i },
    { family: 'Finches',       re: /finch|siskin|redpoll|crossbill|grosbeak/i },
    { family: 'Sparrows',      re: /sparrow|towhee|junco/i },
    { family: 'Warblers',      re: /warbler|yellowthroat|ovenbird|parula|redstart|waterthrush|chat$/i },
    { family: 'Doves',         re: /dove|pigeon/i },
    { family: 'Blackbirds',    re: /blackbird|grackle|cowbird|meadowlark|bobolink/i },
    { family: 'Thrushes',      re: /thrush|robin|bluebird|veery|solitaire/i, not: /waterthrush/i },
    { family: 'Hummingbirds',  re: /hummingbird/i },
    { family: 'Orioles',       re: /oriole/i },
    { family: 'Cardinals',     re: /cardinal|bunting|pyrrhuloxia|dickcissel/i },
    { family: 'Chickadees',    re: /chickadee|titmouse|bushtit/i },
    { family: 'Nuthatches',    re: /nuthatch/i },
    { family: 'Creepers',      re: /creeper/i },
    { family: 'Wrens',         re: /wren/i },
    { family: 'Corvids',       re: /jay|crow|raven|magpie|nutcracker/i },
    { family: 'Raptors',       re: /hawk|falcon|eagle|kestrel|merlin|osprey|harrier|kite|caracara|vulture/i },
    { family: 'Owls',          re: /owl/i },
    { family: 'Mimids',        re: /mockingbird|thrasher|catbird/i },
    { family: 'Starlings',     re: /starling|myna/i },
    { family: 'Waxwings',      re: /waxwing|phainopepla/i },
    { family: 'Kinglets',      re: /kinglet|gnatcatcher/i },
    { family: 'Vireos',        re: /vireo/i },
    { family: 'Flycatchers',   re: /flycatcher|phoebe|kingbird|pewee|wood-pewee/i },
    { family: 'Swallows',      re: /swallow|martin(?!\s*eagle)/i },
    { family: 'Tanagers',      re: /tanager/i },
    { family: 'Gamebirds',     re: /quail|turkey|pheasant|grouse|partridge|bobwhite/i },
    { family: 'Waterbirds',    re: /duck|goose|heron|egret|ibis|mallard|teal|coot|grebe|cormorant|anhinga/i },
    { family: 'Shorebirds',    re: /gull|tern|sandpiper|plover|killdeer|yellowlegs|dowitcher/i },
];

// Passerine families that count as songbirds for songbird_lover. Raptors,
// owls, gamebirds, waterbirds and shorebirds are excluded on purpose.
const BADGE_SONGBIRD_FAMILIES = new Set([
    'Finches', 'Sparrows', 'Warblers', 'Blackbirds', 'Thrushes', 'Orioles',
    'Cardinals', 'Chickadees', 'Nuthatches', 'Creepers', 'Wrens', 'Corvids',
    'Mimids', 'Starlings', 'Waxwings', 'Kinglets', 'Vireos', 'Flycatchers',
    'Swallows', 'Tanagers',
]);

function badgeFamilyOf(species) {
    const name = String(species || '');
    for (const f of BADGE_FAMILIES) {
        if (f.not && f.not.test(name)) continue;
        if (f.re.test(name)) return f.family;
    }
    return null;
}

// Distinct species whose name matches a pattern — the app's
// COUNT(DISTINCT BirdName) LIKE '%x%' rules.
function badgeSpeciesMatching(species, re) {
    return species.filter(s => re.test(s)).length;
}

// ── Ranks ───────────────────────────────────────────────────────────
// The app's 10 ranks keyed off raw badge count out of its 138 (6, 15, 30,
// 45, 60, 80, 100, 120, 138). Held as FRACTIONS of the catalog instead so
// the ladder rescales itself whenever a badge is added or retired, rather
// than silently making a rank unreachable. Top rank is 90%, not 100% —
// some badges are geographically impossible (arctic_observer at a Florida
// feeder) and "Grand Master" should not require moving house.
const BADGE_RANKS = [
    { level: 1,  name: 'Novice Watcher',      icon: '🐣', pct: 0.00 },
    { level: 2,  name: 'Casual Observer',     icon: '🔭', pct: 0.045 },
    { level: 3,  name: 'Bird Enthusiast',     icon: '🪶', pct: 0.11 },
    { level: 4,  name: 'Avid Birder',         icon: '🦅', pct: 0.22 },
    { level: 5,  name: 'Expert Spotter',      icon: '🎯', pct: 0.33 },
    { level: 6,  name: 'Master Naturalist',   icon: '🏅', pct: 0.44 },
    { level: 7,  name: 'Elite Ornithologist', icon: '🥇', pct: 0.58 },
    { level: 8,  name: 'Legendary Watcher',   icon: '👑', pct: 0.70 },
    { level: 9,  name: 'BirdWatch Champion',  icon: '🏆', pct: 0.80 },
    { level: 10, name: 'Grand Master',        icon: '💎', pct: 0.90 },
];

const BADGE_CATEGORIES = [
    { key: 'detection',  label: 'Detection Milestones', icon: '🐦' },
    { key: 'species',    label: 'Species Collection',   icon: '🔍' },
    { key: 'daily',      label: 'Daily Activity',       icon: '☀️' },
    { key: 'streak',     label: 'Streak & Consistency', icon: '📅' },
    { key: 'rarity',     label: 'Rarity Hunter',        icon: '💎' },
    { key: 'families',   label: 'Species Families',     icon: '🪶' },
    { key: 'weather',    label: 'Weather Warrior',      icon: '🌡️' },
    { key: 'special',    label: 'Special Achievements', icon: '🎯' },
    { key: 'dedication', label: 'Dedication & Loyalty', icon: '🎖️' },
    // Last on purpose: video_url is only populated when a feeder has clip
    // sharing switched on, so these measure configuration as much as
    // achievement. Flagged as such in the modal.
    { key: 'media',      label: 'Media Milestones',     icon: '📸' },
];

// ── The catalog ─────────────────────────────────────────────────────
// Two rule shapes:
//   { v: s => number, goal: n }  → progress badge, shows "412 / 500"
//   { on: s => boolean }         → one-shot badge, no progress bar
// `s` is an augmented feeder_badge_stats row (see badgeAugment).
const BADGE_CATALOG = [];

function defBadge(cat, id, name, desc, icon, points, rule) {
    BADGE_CATALOG.push({ id, name, desc, icon, points, cat, ...rule });
}

// A ladder of count badges over one metric — the shape most of the app's
// catalog takes.
function defLadder(cat, metric, rows) {
    rows.forEach(([id, name, desc, icon, points, goal]) =>
        defBadge(cat, id, name, desc, icon, points, { v: s => s[metric] || 0, goal }));
}

// === DETECTION MILESTONES (15) ===
defLadder('detection', 'total_detections', [
    ['first_sighting',    'First Sighting',      'Share your first bird detection', '🐦',    5,      1],
    ['ten_detections',    'Getting Started',     '10 shared detections',            '🔟',   10,     10],
    ['fifty_detections',  'Keen Observer',       '50 shared detections',            '👁️',   20,     50],
    ['hundred_detections','Century Club',        '100 shared detections',           '💯',   35,    100],
    ['250_detections',    'Dedicated Watcher',   '250 shared detections',           '🎯',   50,    250],
    ['500_detections',    'Half Millennium',     '500 shared detections',           '⭐',   75,    500],
    ['1000_detections',   'Thousand Club',       '1,000 shared detections',         '🌟',  100,   1000],
    ['2500_detections',   'Expert Spotter',      '2,500 shared detections',         '🏅',  150,   2500],
    ['5000_detections',   'Master Observer',     '5,000 shared detections',         '🥇',  200,   5000],
    ['7500_detections',   'Elite Watcher',       '7,500 shared detections',         '🏆',  250,   7500],
    ['10000_detections',  'Ten Thousand!',       '10,000 shared detections',        '💎',  350,  10000],
    ['15000_detections',  'Legendary Observer',  '15,000 shared detections',        '👑',  450,  15000],
    ['20000_detections',  'Bird Whisperer',      '20,000 shared detections',        '🦅',  550,  20000],
    ['50000_detections',  'Grand Master',        '50,000 shared detections',        '🌠',  750,  50000],
    ['100000_detections', 'Ultimate Champion',   '100,000 shared detections',       '⚡', 1000, 100000],
]);

// === SPECIES COLLECTION (18) ===
// birdSpeciesCount, not the raw distinct_species, so "Squirrel" doesn't count.
defLadder('species', 'birdSpeciesCount', [
    ['first_species', 'First Contact',        'Identify your first species',  '🔍',   5,   1],
    ['5_species',     'Budding Naturalist',   'Identify 5 unique species',    '🌱',  15,   5],
    ['10_species',    'Diverse Watcher',      'Identify 10 unique species',   '🌿',  25,  10],
    ['15_species',    'Growing Collection',   'Identify 15 unique species',   '🌳',  35,  15],
    ['20_species',    'Avian Explorer',       'Identify 20 unique species',   '🗺️',  50,  20],
    ['25_species',    'Quarter Century',      'Identify 25 unique species',   '📚',  60,  25],
    ['30_species',    'Collector',            'Identify 30 unique species',   '📖',  75,  30],
    ['40_species',    'Enthusiast',           'Identify 40 unique species',   '🔭',  90,  40],
    ['50_species',    'Half Century',         'Identify 50 unique species',   '🎖️', 110,  50],
    ['60_species',    'Experienced',          'Identify 60 unique species',   '🏵️', 130,  60],
    ['75_species',    'Expert Collector',     'Identify 75 unique species',   '🥈', 150,  75],
    ['100_species',   'Century of Species',   'Identify 100 unique species',  '💯', 200, 100],
    ['125_species',   'Master Collector',     'Identify 125 unique species',  '🏆', 250, 125],
    ['150_species',   'Elite Naturalist',     'Identify 150 unique species',  '👑', 300, 150],
    ['175_species',   'Legendary Collector',  'Identify 175 unique species',  '💎', 375, 175],
    ['200_species',   'Bicentennial',         'Identify 200 unique species',  '🌟', 450, 200],
    ['250_species',   'Quarter Millennium',   'Identify 250 unique species',  '⭐', 550, 250],
    ['300_species',   'Ultimate Collector',   'Identify 300 unique species',  '🦅', 750, 300],
]);

// === DAILY ACTIVITY (12) ===
defLadder('daily', 'max_day_count', [
    ['5_in_day',   'Active Day',       '5 detections in one day',   '☀️',  10,   5],
    ['10_in_day',  'Busy Day',         '10 detections in one day',  '🌤️',  20,  10],
    ['20_in_day',  'Productive Day',   '20 detections in one day',  '🌞',  35,  20],
    ['30_in_day',  'Exceptional Day',  '30 detections in one day',  '🔥',  50,  30],
    ['50_in_day',  'Bird Bonanza',     '50 detections in one day',  '💥',  75,  50],
    ['75_in_day',  'Incredible Day',   '75 detections in one day',  '⚡', 100,  75],
    ['100_in_day', 'Century Day',      '100 detections in one day', '💯', 150, 100],
]);
defLadder('daily', 'max_day_species', [
    ['5_species_day',  'Diverse Day',              '5 unique species in one day',  '🌈',  25,  5],
    ['10_species_day', 'Species Spree',            '10 unique species in one day', '🎨',  50, 10],
    ['15_species_day', 'Variety Master',           '15 unique species in one day', '🎭',  75, 15],
    ['20_species_day', 'Extraordinary Diversity',  '20 unique species in one day', '🦚', 125, 20],
    ['25_species_day', 'Ultimate Diversity',       '25 unique species in one day', '👑', 200, 25],
]);

// === STREAK & CONSISTENCY (15) ===
// Scored on the LONGEST streak, not the current one, so a badge already
// earned can't be taken away by one quiet day. The current streak is
// shown separately on the card.
defLadder('streak', 'longest_streak', [
    ['2_day_streak',   'Getting Consistent',    'Detections 2 days in a row',   '2️⃣',   10,   2],
    ['3_day_streak',   'Three Day Run',         'Detections 3 days in a row',   '3️⃣',   15,   3],
    ['5_day_streak',   'Work Week',             'Detections 5 days in a row',   '5️⃣',   25,   5],
    ['7_day_streak',   'Full Week',             'Detections 7 days in a row',   '📅',   40,   7],
    ['14_day_streak',  'Two Week Warrior',      'Detections 14 days in a row',  '🗓️',   60,  14],
    ['21_day_streak',  'Three Week Champion',   'Detections 21 days in a row',  '🏃',   85,  21],
    ['30_day_streak',  'Monthly Master',        'Detections 30 days in a row',  '📆',  125,  30],
    ['60_day_streak',  'Two Month Wonder',      'Detections 60 days in a row',  '🌙',  200,  60],
    ['90_day_streak',  'Quarterly Champion',    'Detections 90 days in a row',  '🌟',  300,  90],
    ['180_day_streak', 'Half Year Hero',        'Detections 180 days in a row', '⭐',  500, 180],
    ['365_day_streak', 'Year-Round Watcher',    'Detections 365 days in a row', '🏆', 1000, 365],
]);
defBadge('streak', 'weekend_warrior', 'Weekend Warrior',
    'A weekend sighting 4 weeks running', '🎉', 50,
    { v: s => s.longest_weekend_weeks || 0, goal: 4 });
defBadge('streak', 'early_bird_streak', 'Early Bird',
    'Detections before 7am, 7 days straight', '🌅', 75,
    { v: s => s.longest_early_streak || 0, goal: 7 });
defBadge('streak', 'night_owl_streak', 'Night Owl',
    'Detections after 8pm, 7 days straight', '🌙', 75,
    { v: s => s.longest_late_streak || 0, goal: 7 });
defBadge('streak', 'all_seasons', 'All Seasons',
    'Detections in spring, summer, fall and winter', '🍂', 100,
    { v: s => s.season_count || 0, goal: 4 });

// === RARITY HUNTER (10) ===
// The app's two *_exceptional badges are absent: no such tier exists
// server-side. Note "Rare" has zero rows live so far, so in practice this
// ladder currently turns on Very Rare.
defBadge('rarity', 'first_rare', 'Rare Find',
    'First rare bird detection', '💎', 30, { v: s => s.rare_count || 0, goal: 1 });
defBadge('rarity', 'first_very_rare', 'Very Rare Discovery',
    'First very rare bird detection', '🌟', 50, { v: s => s.very_rare_count || 0, goal: 1 });
defLadder('rarity', 'rare_count', [
    ['5_rare',  'Rare Collector', '5 rare bird detections',  '💎',  75,  5],
    ['10_rare', 'Rare Hunter',    '10 rare bird detections', '💎', 125, 10],
    ['25_rare', 'Rare Master',    '25 rare bird detections', '💎', 200, 25],
]);
defLadder('rarity', 'very_rare_count', [
    ['3_very_rare',  'Very Rare Collector', '3 very rare bird detections',  '🌟', 100,  3],
    ['10_very_rare', 'Very Rare Expert',    '10 very rare bird detections', '🌟', 200, 10],
]);
defBadge('rarity', 'rare_day', 'Lucky Day',
    '3 rare-or-better birds in a single day', '🍀', 75,
    { v: s => s.max_day_rare_plus || 0, goal: 3 });
defBadge('rarity', 'rare_species_10', 'Rare Species Diversity',
    '10 unique rare species', '🔮', 150, { v: s => s.rare_species || 0, goal: 10 });
defBadge('rarity', 'rarity_master', 'Rarity Master',
    '50 rare-or-better detections', '👑', 300,
    { v: s => s.rare_plus_count || 0, goal: 50 });

// === SPECIES FAMILIES (15) ===
defBadge('families', 'woodpecker_watcher', 'Woodpecker Watcher',
    'Detect 3 woodpecker species', '🪶', 40,
    { v: s => badgeSpeciesMatching(s.birdSpecies, /woodpecker|flicker|sapsucker/i), goal: 3 });
defBadge('families', 'finch_fanatic', 'Finch Fanatic',
    'Detect 5 finch species', '🐤', 40,
    { v: s => badgeSpeciesMatching(s.birdSpecies, /finch|siskin|redpoll|crossbill/i), goal: 5 });
defBadge('families', 'sparrow_specialist', 'Sparrow Specialist',
    'Detect 5 sparrow species', '🐦', 40,
    { v: s => badgeSpeciesMatching(s.birdSpecies, /sparrow/i), goal: 5 });
defBadge('families', 'warbler_watcher', 'Warbler Watcher',
    'Detect 5 warbler species', '🎶', 60,
    { v: s => s.familyCounts['Warblers'] || 0, goal: 5 });
defBadge('families', 'dove_devotee', 'Dove Devotee',
    'Detect 3 dove or pigeon species', '🕊️', 30,
    { v: s => badgeSpeciesMatching(s.birdSpecies, /dove|pigeon/i), goal: 3 });
defBadge('families', 'blackbird_brigade', 'Blackbird Brigade',
    'Detect 5 blackbird species', '⬛', 45,
    { v: s => badgeSpeciesMatching(s.birdSpecies, /blackbird|grackle|cowbird/i), goal: 5 });
defBadge('families', 'thrush_tracker', 'Thrush Tracker',
    'Detect 3 thrush species', '🟤', 50,
    { v: s => s.familyCounts['Thrushes'] || 0, goal: 3 });
defBadge('families', 'hummingbird_hero', 'Hummingbird Hero',
    'Detect any hummingbird species', '💨', 50,
    { on: s => (s.familyCounts['Hummingbirds'] || 0) > 0 });
defBadge('families', 'oriole_observer', 'Oriole Observer',
    'Detect any oriole species', '🟠', 60,
    { on: s => (s.familyCounts['Orioles'] || 0) > 0 });
// Single-species volume badges — these need per-species counts, which is
// why the view ships the species_counts map.
defBadge('families', 'cardinal_collector', 'Cardinal Collector',
    'Detect Northern Cardinal 50 times', '❤️', 35,
    { v: s => badgeCountSpecies(s, /cardinal/i), goal: 50 });
defBadge('families', 'blue_jay_buddy', 'Blue Jay Buddy',
    'Detect Blue Jay 50 times', '💙', 35,
    { v: s => badgeCountSpecies(s, /blue jay/i), goal: 50 });
defBadge('families', 'robin_regular', 'Robin Regular',
    'Detect American Robin 50 times', '🧡', 35,
    { v: s => badgeCountSpecies(s, /robin/i), goal: 50 });
// The three the app never actually evaluated, given real rules.
defBadge('families', 'songbird_lover', 'Songbird Lover',
    'Detect 10 songbird species', '🎵', 50,
    { v: s => s.songbirdCount, goal: 10 });
defBadge('families', 'raptor_spotter', 'Raptor Spotter',
    'Detect 3 raptor species', '🦅', 60,
    { v: s => (s.familyCounts['Raptors'] || 0) + (s.familyCounts['Owls'] || 0), goal: 3 });
defBadge('families', 'family_master', 'Family Master',
    'Detect birds from 15 different families', '👨‍👩‍👧‍👦', 200,
    { v: s => Object.keys(s.familyCounts).length, goal: 15 });

// === WEATHER WARRIOR (10) ===
defBadge('weather', 'cold_watcher', 'Cold Watcher',
    'A detection below 32°F', '❄️', 25, { on: s => s.min_temp != null && s.min_temp < 32 });
defBadge('weather', 'hot_watcher', 'Hot Watcher',
    'A detection above 90°F', '🌡️', 25, { on: s => s.max_temp != null && s.max_temp > 90 });
defBadge('weather', 'arctic_observer', 'Arctic Observer',
    'A detection below 10°F', '🥶', 50, { on: s => s.min_temp != null && s.min_temp < 10 });
defBadge('weather', 'desert_watcher', 'Desert Watcher',
    'A detection above 100°F', '🔥', 50, { on: s => s.max_temp != null && s.max_temp > 100 });
defBadge('weather', 'temperature_range_50', 'Temperature Ranger',
    'Detections across a 50°F range', '📊', 40, { v: s => Math.round(s.temp_range || 0), goal: 50 });
defBadge('weather', 'temperature_range_75', 'Climate Master',
    'Detections across a 75°F range', '🌡️', 75, { v: s => Math.round(s.temp_range || 0), goal: 75 });
defBadge('weather', 'freezing_dedication', 'Freezing Dedication',
    '10 detections below 32°F', '🧊', 60, { v: s => s.below_32_count || 0, goal: 10 });
defBadge('weather', 'summer_enthusiast', 'Summer Enthusiast',
    '50 detections above 80°F', '☀️', 50, { v: s => s.above_80_count || 0, goal: 50 });
defBadge('weather', 'winter_warrior', 'Winter Warrior',
    '100 detections below 40°F', '⛄', 100, { v: s => s.below_40_count || 0, goal: 100 });
defBadge('weather', 'four_season_temp', 'Four Season Watcher',
    'Detections in 4 temperature bands', '🌈', 150, { v: s => s.temp_buckets || 0, goal: 4 });

// === SPECIAL ACHIEVEMENTS (8) ===
defBadge('special', 'perfect_id', 'Perfect ID',
    'A detection at 99%+ confidence', '🎯', 20,
    { on: s => (s.max_confidence || 0) >= 99 });
defBadge('special', 'high_confidence_10', 'Sharp Eye',
    '10 detections at 95%+ confidence', '👁️', 40, { v: s => s.conf_95_count || 0, goal: 10 });
defBadge('special', 'high_confidence_100', 'Expert Identifier',
    '100 detections at 95%+ confidence', '🔬', 100, { v: s => s.conf_95_count || 0, goal: 100 });
defBadge('special', 'midnight_detection', 'Midnight Watcher',
    'A detection between midnight and 5am', '🌃', 30, { on: s => (s.midnight_count || 0) > 0 });
defBadge('special', 'dawn_chorus', 'Dawn Chorus',
    'A detection at sunrise (5–6am)', '🌄', 25, { on: s => (s.dawn_count || 0) > 0 });
defBadge('special', 'holiday_watcher', 'Holiday Watcher',
    'A detection on a major holiday', '🎄', 25, { on: s => (s.holiday_count || 0) > 0 });
defBadge('special', 'new_year_bird', 'New Year Bird',
    'A detection on New Year’s Day', '🎆', 50, { on: s => (s.new_year_count || 0) > 0 });
defBadge('special', 'anniversary_detection', 'Anniversary Detection',
    'A detection on your feeder’s anniversary', '🎂', 75,
    { on: s => (s.anniversary_count || 0) > 0 });

// === DEDICATION & LOYALTY (16) ===
// days_of_history, not days_since_joined: the three original feeders had
// their WinForms history backfilled, so registration date understates
// their tenure by ~5 months. See the view's comment.
defLadder('dedication', 'days_of_history', [
    ['welcome_aboard',       'Welcome Aboard',       'First day of shared history', '🎉',   5,    1],
    ['one_week_in',          'One Week In',          '7 days of history',           '📅',  10,    7],
    ['two_weeks_strong',     'Two Weeks Strong',     '14 days of history',          '🗓️',  15,   14],
    ['monthly_member',       'Monthly Member',       '30 days of history',          '📆',  25,   30],
    ['two_month_veteran',    'Two Month Veteran',    '60 days of history',          '⭐',  35,   60],
    ['quarter_year',         'Quarter Year',         '90 days of history',          '🌟',  50,   90],
    ['half_year_hero',       'Half Year Hero',       '180 days of history',         '🏅',  75,  180],
    ['one_year_anniversary', 'One Year Anniversary', '365 days of history',         '🎂', 150,  365],
    ['two_year_veteran',     'Two Year Veteran',     '730 days of history',         '🥈', 250,  730],
    ['three_year_legend',    'Three Year Legend',    '1,095 days of history',       '🥇', 400, 1095],
    ['five_year_champion',   'Five Year Champion',   '1,825 days of history',       '👑', 750, 1825],
]);
defLadder('dedication', 'active_days', [
    ['second_day',    'Second Day',     '2 days with a sighting',   '2️⃣',   5,   2],
    ['week_of_days',  'Week of Days',   '7 days with a sighting',   '📅',  15,   7],
    ['month_of_days', 'Month of Days',  '30 days with a sighting',  '📆',  40,  30],
    ['hundred_days',  'Hundred Days',   '100 days with a sighting', '💯', 100, 100],
    ['year_of_days',  'Year of Days',   '365 days with a sighting', '🎖️', 300, 365],
]);

// === MEDIA MILESTONES (8) ===
defLadder('media', 'image_count', [
    ['first_photo',  'First Photo',          'Your first shared photo', '📸',   5,    1],
    ['100_photos',   'Photo Album',          '100 shared photos',       '📷',  50,  100],
    ['500_photos',   'Photo Library',        '500 shared photos',       '🖼️', 100,  500],
    ['1000_photos',  'Master Photographer',  '1,000 shared photos',     '📸', 200, 1000],
]);
defLadder('media', 'video_count', [
    ['first_video',  'First Video',          'Your first shared clip', '🎬',  10,    1],
    ['100_videos',   'Video Collection',     '100 shared clips',       '🎥',  75,  100],
    ['500_videos',   'Video Library',        '500 shared clips',       '📹', 150,  500],
    ['1000_videos',  'Master Videographer',  '1,000 shared clips',     '🎬', 300, 1000],
]);

// Catalog position by id, so the modal can restore ladder order without
// re-scanning the array per tile.
const BADGE_ORDER = new Map(BADGE_CATALOG.map((b, i) => [b.id, i]));

// ── Evaluation ──────────────────────────────────────────────────────

// Total detections for every species whose name matches — the app's
// "WHERE BirdName LIKE '%Cardinal%'" volume rules.
function badgeCountSpecies(s, re) {
    let n = 0;
    for (const [species, count] of Object.entries(s.species_counts || {})) {
        if (re.test(species)) n += Number(count) || 0;
    }
    return n;
}

// Derive everything the rules need that isn't a plain view column.
function badgeAugment(row) {
    const birdSpecies = (row.species_list || []).filter(badgeIsBird);
    const familyCounts = {};
    birdSpecies.forEach(sp => {
        const fam = badgeFamilyOf(sp);
        if (fam) familyCounts[fam] = (familyCounts[fam] || 0) + 1;
    });
    const songbirdCount = Object.entries(familyCounts)
        .filter(([fam]) => BADGE_SONGBIRD_FAMILIES.has(fam))
        .reduce((acc, [, n]) => acc + n, 0);

    return {
        ...row,
        birdSpecies,
        birdSpeciesCount: birdSpecies.length,
        familyCounts,
        songbirdCount,
    };
}

// Score one feeder. Returns earned/locked badge lists, points, rank, and
// the points-per-active-day rate the leaderboard uses as its fairness
// counterweight to raw totals.
function evaluateFeederBadges(row) {
    const s = badgeAugment(row);
    const earned = [];
    const locked = [];

    for (const b of BADGE_CATALOG) {
        let done, value = null, goal = null;
        if (b.on) {
            done = !!b.on(s);
        } else {
            value = b.v(s);
            goal  = b.goal;
            done  = value >= goal;
        }
        (done ? earned : locked).push({ ...b, value, goal, done });
    }

    // Closest-first, so the modal's locked list reads as "what's next".
    locked.sort((a, b) => {
        const pa = a.goal ? Math.min(1, (a.value || 0) / a.goal) : 0;
        const pb = b.goal ? Math.min(1, (b.value || 0) / b.goal) : 0;
        if (pb !== pa) return pb - pa;
        return a.points - b.points;
    });

    const points = earned.reduce((acc, b) => acc + b.points, 0);
    const total  = BADGE_CATALOG.length;
    const count  = earned.length;

    let rank = BADGE_RANKS[0];
    for (const r of BADGE_RANKS) if (count >= Math.round(r.pct * total)) rank = r;
    const next = BADGE_RANKS.find(r => r.level === rank.level + 1) || null;
    const nextAt = next ? Math.round(next.pct * total) : null;

    const activeDays = Math.max(1, row.active_days || 1);

    return {
        feederId: row.feeder_id,
        displayName: row.display_name,
        stats: s,
        earned, locked,
        count, total, points,
        rank, next, nextAt,
        toNext: next ? Math.max(0, nextAt - count) : 0,
        nextPct: next && nextAt > 0 ? Math.min(100, Math.round(count / nextAt * 100)) : 100,
        // Fairness counterweight: rewards intensity rather than tenure, so
        // a feeder that came online last month can top a column. A true
        // "earned this month" board needs unlock timestamps — i.e. the
        // persisted table we deliberately deferred.
        pointsPerDay: points / activeDays,
    };
}

// ── Data loading ────────────────────────────────────────────────────

let badgeResultsById   = new Map();   // feeder_id   → evaluation
let badgeResultsByName = new Map();   // display_name → evaluation
let badgeStatsPromise  = null;
let badgeStatsError    = null;

async function loadBadgeStats() {
    const url = `${SUPABASE_URL}/rest/v1/feeder_badge_stats?select=*&limit=1000`;
    const res = await fetch(url, { headers: sbHeaders(sbAuthed()) });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
    }
    const rows = await res.json();

    badgeResultsById   = new Map();
    badgeResultsByName = new Map();
    rows.forEach(r => {
        const evald = evaluateFeederBadges(r);
        badgeResultsById.set(String(r.feeder_id), evald);
        if (r.display_name) badgeResultsByName.set(r.display_name, evald);
    });
    return rows.length;
}

// Fetched once per page load and shared by the feeder cards and the
// leaderboard. A failure is remembered rather than retried per card, so a
// missing view (migration not applied yet) degrades to "no badges" instead
// of hammering the API once per feeder.
function ensureBadgeStats() {
    if (!badgeStatsPromise) {
        badgeStatsPromise = loadBadgeStats().catch(err => {
            badgeStatsError = err;
            console.warn('Badges unavailable:', err.message);
            return 0;
        });
    }
    return badgeStatsPromise;
}

// Force a refetch — the feeders view polls every 30s, but badges move far
// more slowly, so this is only wired to the explicit Refresh button.
function invalidateBadgeStats() {
    badgeStatsPromise = null;
    badgeStatsError = null;
}

function badgesForFeederId(id) {
    return badgeResultsById.get(String(id)) || null;
}

function badgesForFeederName(name) {
    return badgeResultsByName.get(name) || null;
}

// ── Feeder-card badge strip ─────────────────────────────────────────

const BADGE_STRIP_MAX = 6;

// Rendered into each feeder card. Shows the rank, the badge/points
// tallies, progress to the next rank, and the highest-value badges
// earned. Returns '' when stats aren't loaded so the card just omits the
// section rather than showing a broken shell.
function feederBadgeStripHtml(feederId) {
    const b = badgesForFeederId(feederId);
    if (!b) return '';

    const top = b.earned
        .slice()
        .sort((x, y) => y.points - x.points)
        .slice(0, BADGE_STRIP_MAX);
    const more = b.earned.length - top.length;

    const chips = top.map(x =>
        `<span class="badge-chip" title="${esc(x.name)} — ${esc(x.desc)} (${x.points} pts)">
            <span class="badge-chip-icon" aria-hidden="true">${x.icon}</span>
         </span>`).join('');

    return `
    <div class="feeder-badges">
        <div class="feeder-badges-head">
            <span class="badge-rank" title="Rank ${b.rank.level} of 10">
                <span aria-hidden="true">${b.rank.icon}</span> ${esc(b.rank.name)}
            </span>
            <span class="badge-tally">${b.count}/${b.total} · ${b.points.toLocaleString()} pts</span>
        </div>
        ${b.next ? `
        <div class="badge-next" title="${b.toNext} more badge${b.toNext === 1 ? '' : 's'} to reach ${esc(b.next.name)}">
            <span class="badge-next-bar"><span class="badge-next-fill" style="width:${b.nextPct}%"></span></span>
            <span class="badge-next-label">${b.toNext} to ${b.next.icon} ${esc(b.next.name)}</span>
        </div>` : `
        <div class="badge-next"><span class="badge-next-label">Top rank reached 💎</span></div>`}
        <div class="badge-chips">
            ${chips || '<span class="badge-chips-empty">No badges yet</span>'}
            ${more > 0 ? `<span class="badge-chip badge-chip-more">+${more}</span>` : ''}
        </div>
        <button class="feeder-badges-btn" data-feeder-id="${esc(String(feederId))}"
                onclick="openFeederBadges(this)">🏆 All badges →</button>
    </div>`;
}

// ── Badge wall modal ────────────────────────────────────────────────

function openFeederBadges(el) {
    const id = el?.dataset?.feederId;
    const b  = badgesForFeederId(id);
    const modal = document.getElementById('badges-modal');
    if (!b || !modal) return;

    document.getElementById('badges-modal-title').textContent =
        `${b.displayName || 'Feeder'} — Community Badges`;
    document.getElementById('badges-modal-sub').innerHTML =
        `${b.rank.icon} <strong>${esc(b.rank.name)}</strong> · ${b.count} of ${b.total} badges
         · ${b.points.toLocaleString()} points`;

    const byCat = new Map(BADGE_CATEGORIES.map(c => [c.key, { earned: [], locked: [] }]));
    b.earned.forEach(x => byCat.get(x.cat)?.earned.push(x));
    b.locked.forEach(x => byCat.get(x.cat)?.locked.push(x));

    document.getElementById('badges-modal-body').innerHTML = BADGE_CATEGORIES.map(cat => {
        const g = byCat.get(cat.key);
        if (!g || (!g.earned.length && !g.locked.length)) return '';
        const n = g.earned.length, tot = g.earned.length + g.locked.length;
        // Catalog order reads as a ladder (10 → 50 → 100 detections), so
        // restore it within the category — the earned/locked split and the
        // closest-first sort on `locked` would otherwise scramble it.
        const ordered = [...g.earned, ...g.locked]
            .sort((x, y) => BADGE_ORDER.get(x.id) - BADGE_ORDER.get(y.id));
        return `
        <section class="badge-cat">
            <h4 class="badge-cat-head">
                <span aria-hidden="true">${cat.icon}</span> ${esc(cat.label)}
                <span class="badge-cat-count">${n}/${tot}</span>
            </h4>
            ${cat.key === 'media' ? `<p class="badge-cat-note">Clips only count when a feeder
                has clip sharing switched on, so these reflect settings as much as effort.</p>` : ''}
            <div class="badge-grid">
                ${ordered.map(badgeTileHtml).join('')}
            </div>
        </section>`;
    }).join('');

    modal.classList.add('open');
    document.addEventListener('keydown', badgesEscHandler);
}

function badgeTileHtml(x) {
    const pct = x.goal ? Math.min(100, Math.round((x.value || 0) / x.goal * 100)) : 0;
    const progress = (!x.done && x.goal)
        ? `<span class="badge-tile-bar"><span class="badge-tile-fill" style="width:${pct}%"></span></span>
           <span class="badge-tile-progress">${(x.value || 0).toLocaleString()} / ${x.goal.toLocaleString()}</span>`
        : '';
    return `
    <div class="badge-tile ${x.done ? 'earned' : 'locked'}">
        <span class="badge-tile-icon" aria-hidden="true">${x.icon}</span>
        <span class="badge-tile-name">${esc(x.name)}</span>
        <span class="badge-tile-desc">${esc(x.desc)}</span>
        ${progress}
        <span class="badge-tile-points">${x.points} pts</span>
    </div>`;
}

function closeFeederBadges() {
    document.getElementById('badges-modal')?.classList.remove('open');
    document.removeEventListener('keydown', badgesEscHandler);
}

function badgesEscHandler(e) {
    if (e.key === 'Escape') closeFeederBadges();
}

// ── Leaderboard integration ─────────────────────────────────────────

// Extra <th>s appended to the existing Stats → Leaderboard table.
function badgeLeaderboardHeadHtml() {
    return `<th class="stats-count" title="Community badges earned, out of ${BADGE_CATALOG.length}">Badges</th>
            <th class="stats-count" title="Total badge points">Points</th>
            <th class="stats-count" title="Points per day with a sighting — rewards intensity rather than tenure, so a newer feeder can lead this column">Pts / day</th>
            <th title="Rank, from Novice Watcher to Grand Master">Rank</th>`;
}

// Matching <td>s. Keyed by display_name because that is what the existing
// leaderboard groups by. A feeder with no badge row (private, or the
// migration isn't applied) gets em-dashes rather than a broken row.
function badgeLeaderboardCellsHtml(feederName) {
    const b = badgesForFeederName(feederName);
    if (!b) return `<td class="stats-count">—</td><td class="stats-count">—</td>
                    <td class="stats-count">—</td><td>—</td>`;
    return `
        <td class="stats-count">${b.count}</td>
        <td class="stats-count">${b.points.toLocaleString()}</td>
        <td class="stats-count">${b.pointsPerDay.toFixed(1)}</td>
        <td class="badge-rank-cell" title="Rank ${b.rank.level} of 10">
            <span aria-hidden="true">${b.rank.icon}</span> ${esc(b.rank.name)}
        </td>`;
}
