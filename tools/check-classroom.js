#!/usr/bin/env node
// ── Build every classroom question from made-up feeder data, no login ──────
//
// WHY THIS EXISTS (TODO.MD, CLASSROOM, 2026-11-14)
// The clock-turning-into-bars bug only showed up by building a dozen
// synthetic weeks and comparing every question against the previous code.
// That was done by hand with throwaway scripts. This is those scripts, kept.
//
// WHAT IT DOES
// Serves docs/ on a local port, opens community.html in headless Chromium,
// and calls the real buildClassroomQuestions() for each grade band against
// several synthetic fortnights (busy, quiet, one species, a cold snap...),
// with { all: true } so every template that CAN build does. No Supabase, no
// sign-in: the data is made here and handed straight to the builder.
//
// Then it checks what every built question must satisfy, and prints a
// table of anything that does not:
//   * at least two choices, and a correct_index inside them (or null for a
//     poll or a prediction, which must say which it is);
//   * a prompt;
//   * something on the reveal — an `explain` or a "how we know" line — so a
//     class is never told only "Not quite" (classroom-stage-extras.js);
//   * no "undefined", "NaN" or "[object" in any text a class will see.
//
// USAGE
//   node tools/check-classroom.js                 check, exit 1 on a failure
//   node tools/check-classroom.js --dump out.json write every question
//   node tools/check-classroom.js --diff old.json compare with a dump, e.g.
//                                                 one taken before a change
//
// Needs Playwright with Chromium (preinstalled in the cloud sessions; on a
// laptop: npm i -g playwright && npx playwright install chromium).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Needs playwright: npm i -g playwright'); process.exit(2); }

const DOCS = path.join(__dirname, '..', 'docs');
const args = process.argv.slice(2);
const dumpTo = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : null;
const diffWith = args.includes('--diff') ? args[args.indexOf('--diff') + 1] : null;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };

function serve() {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const p = path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
            const file = path.join(DOCS, p === '/' ? 'community.html' : p);
            if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); res.end(); return;
            }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

// Runs inside the page. Everything it needs is the page's own globals.
function buildAll() {
    const DAY = 864e5;
    const now = new Date();
    const SPECIES = ['Northern Cardinal', 'Blue Jay', 'Tufted Titmouse', 'Carolina Wren',
                     'Mourning Dove', 'House Finch', 'Downy Woodpecker', 'American Goldfinch',
                     'Carolina Chickadee', 'Red-bellied Woodpecker', 'Squirrel'];
    // A seeded generator, so a run today and a run tomorrow build the same
    // fortnights and --diff compares like with like.
    function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

    function rows(feederId, days, perDay, kinds, seed, tempBase) {
        const r = rng(seed); const out = [];
        for (let d = days - 1; d >= 0; d--) {
            const n = Math.max(0, Math.round(perDay * (0.4 + r() * 1.2)));
            for (let i = 0; i < n; i++) {
                const sp = SPECIES[Math.floor(Math.pow(r(), 1.6) * kinds)];
                const at = new Date(now.getTime() - d * DAY);
                at.setHours(6 + Math.floor(r() * 12), Math.floor(r() * 60), 0, 0);
                // Later today than now: pinned to just after midnight, not
                // to "an hour ago", so two runs a minute apart build the
                // same rows and --diff compares like with like.
                if (at > now) { at.setHours(0, i % 60, 0, 0); }
                out.push({
                    id: `${feederId}-${d}-${i}`, feeder_id: feederId, species: sp,
                    confidence: 60 + r() * 39, detected_at: at.toISOString(),
                    image_url: r() < 0.6 ? `https://example.invalid/${sp.replace(/\W/g, '')}-${d}-${i}.jpg` : null,
                    video_url: r() < 0.05 ? `https://example.invalid/clip-${d}-${i}.mp4` : null,
                    temperature: tempBase + Math.round((r() - 0.5) * 16),
                    rarity: r() < 0.9 ? 'Common' : 'Uncommon',
                    latitude: 39.36, longitude: -76.63, zip_code: '21210',
                });
            }
        }
        return out;
    }

    function yearRoll(feederId, all) {
        const months = new Map(), species = new Map();
        all.forEach(x => {
            const m = x.detected_at.slice(0, 7), d = x.detected_at.slice(0, 10);
            const mm = months.get(m) || { feeder_id: feederId, m, visits: 0, days: new Set() };
            mm.visits++; mm.days.add(d); months.set(m, mm);
            const k = m + '|' + x.species;
            species.set(k, { feeder_id: feederId, m, sp: x.species, n: ((species.get(k) || {}).n || 0) + 1 });
        });
        return { months: [...months.values()].map(m => ({ ...m, days: m.days.size })), species: [...species.values()] };
    }

    const WEEKS = [
        { name: 'busy',        perDay: 40, kinds: 10, temp: 45 },
        { name: 'quiet',       perDay: 4,  kinds: 4,  temp: 30 },
        { name: 'one species', perDay: 15, kinds: 1,  temp: 55 },
        { name: 'warm',        perDay: 25, kinds: 7,  temp: 75 },
    ];
    const out = [];
    WEEKS.forEach((w, wi) => {
        const feederId = '00000000-0000-0000-0000-00000000000' + (wi + 1);
        const long = rows(feederId, 120, w.perDay, w.kinds, 1000 + wi, w.temp);
        const recent = long.filter(x => new Date(x.detected_at) >= new Date(now.getTime() - CLASSROOM_WINDOW_DAYS * DAY));
        const home = cmSummarize(feederId, 'Test Feeder', recent, true, CLASSROOM_WINDOW_DAYS);
        const data = { home, partners: [], all: [home], each: [home], pooled: null, scope: 'home',
                       longRows: long.map(x => ({ feeder_id: x.feeder_id, species: x.species, detected_at: x.detected_at })),
                       yearRoll: yearRoll(feederId, long) };
        for (const band of ['k-2', '3-5', '6-8']) {
            const room = { id: `room-${wi}-${band}`, name: 'Test Room', grade_band: band,
                           home_feeder_id: feederId, home_feeder_name: 'Test Feeder', partners: [] };
            let built;
            try { built = buildClassroomQuestions(room, data, { all: true }); }
            catch (e) { out.push({ week: w.name, band, error: String(e && e.stack || e) }); continue; }
            for (const q of built.questions) {
                // Exactly what the stage does on the reveal.
                if (typeof ccRevealPrepare === 'function') ccRevealPrepare(q);
                out.push({
                    week: w.name, band, template_id: q.template_id, category: q.category,
                    prompt: q.prompt, choices: (q.choices || []).map(c => String(c.label)),
                    correct_index: q.correct_index, poll: !!q.poll, pending: !!q.pending_check,
                    explain: q.explain || '', how: q.cc_how || '',
                    chart: q.chart ? q.chart.kind : null,
                });
            }
        }
    });
    return out;
}

function problems(q) {
    const p = [];
    if (q.error) return ['threw: ' + q.error.split('\n')[0]];
    if (!q.prompt) p.push('no prompt');
    if (q.choices.length < 2) p.push('fewer than two choices');
    if (q.correct_index != null && (q.correct_index < 0 || q.correct_index >= q.choices.length)) p.push('correct_index out of range');
    if (q.correct_index == null && !q.poll && !q.pending) p.push('no answer, but not a poll or prediction');
    if (!q.explain && !q.how) p.push('nothing to say on the reveal');
    const text = [q.prompt, q.explain, q.how, ...q.choices].join(' ');
    const bad = text.match(/undefined|NaN|\[object/);
    if (bad) p.push(`"${bad[0]}" in the text`);
    return p;
}

(async () => {
    const srv = await serve();
    const port = srv.address().port;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // Nothing leaves the machine: the feed's own requests to Supabase and
    // the CDNs are refused, and the builder never makes one.
    await page.route(u => !u.toString().startsWith(`http://127.0.0.1:${port}/`), r => r.abort());
    await page.goto(`http://127.0.0.1:${port}/community.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof buildClassroomQuestions === 'function');
    const qs = await page.evaluate(buildAll);
    await browser.close();
    srv.close();

    const bad = [];
    for (const q of qs) {
        const p = problems(q);
        if (p.length) bad.push({ q, p });
    }
    const templates = new Set(qs.map(q => q.template_id).filter(Boolean));
    console.log(`Built ${qs.length} questions from ${templates.size} templates `
              + `(4 synthetic fortnights × 3 bands).`);

    if (dumpTo) { fs.writeFileSync(dumpTo, JSON.stringify(qs, null, 1)); console.log(`Wrote ${dumpTo}`); }

    if (diffWith) {
        const old = JSON.parse(fs.readFileSync(diffWith, 'utf8'));
        const key = q => `${q.week}|${q.band}|${q.template_id}`;
        const was = new Map(old.map(q => [key(q), q]));
        const now = new Map(qs.map(q => [key(q), q]));
        let n = 0;
        for (const [k, q] of now) {
            const o = was.get(k);
            if (!o) { console.log(`+ ${k}`); n++; continue; }
            for (const f of ['prompt', 'choices', 'correct_index', 'chart', 'explain', 'how']) {
                if (JSON.stringify(o[f]) !== JSON.stringify(q[f])) {
                    console.log(`~ ${k} ${f}\n    was: ${JSON.stringify(o[f])}\n    now: ${JSON.stringify(q[f])}`);
                    n++;
                }
            }
        }
        for (const k of was.keys()) if (!now.has(k)) { console.log(`- ${k}`); n++; }
        console.log(n ? `${n} difference(s) from ${diffWith}.` : `No differences from ${diffWith}.`);
    }

    if (bad.length) {
        const by = new Map();
        bad.forEach(({ q, p }) => p.forEach(msg => {
            const k = `${q.template_id || '(build)'}: ${msg}`;
            by.set(k, (by.get(k) || []).concat(`${q.week}/${q.band}`));
        }));
        console.log(`\n${by.size} problem(s):`);
        for (const [k, where] of [...by.entries()].sort()) console.log(`  ${k}  [${[...new Set(where)].join(', ')}]`);
    }
    if (pageErrors.length) console.log(`\nPage errors (the map library is blocked here on purpose):\n  ${[...new Set(pageErrors)].join('\n  ')}`);
    process.exit(bad.length ? 1 : 0);
})();
