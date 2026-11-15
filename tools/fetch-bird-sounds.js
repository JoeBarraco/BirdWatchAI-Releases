// Fetch a recording of each bird song the classroom quotes, from Wikimedia
// Commons, together with the attribution its licence requires.
//
// Why this exists
// ───────────────
// A teacher flagged bird-by-sound: "it would be better if these types of
// questions included a clickable link to play the sound." They are right in
// a way that goes past that one question — six Florida music benchmarks ask
// a class to compare melodic and rhythmic patterns BY EAR, and no amount of
// printed text substitutes. Without audio those benchmarks are unreachable
// and writing questions for them would be pretending.
//
// Why Commons and not xeno-canto
// ──────────────────────────────
// xeno-canto is the obvious source and it was the first thing tried. Its
// API v2 is retired, and v3 requires a key tied to a personal account:
//
//     {"error":"client_error","message":"Missing or invalid 'key' parameter"}
//
// THIS REPOSITORY IS PUBLIC, so that key could never be committed, and a
// build step that only works for whoever holds the account is a build step
// that rots. Commons mirrors a great many xeno-canto recordings under the
// same Creative Commons licences, reachable through the same API this
// project already uses for bird photographs — no key, no account, and the
// licence and attribution machinery already written and already correct.
//
// What it refuses
// ───────────────
// The same rule as fetch-bird-photos.js, for the same reason: anything that
// is not public domain, CC0, CC BY or CC BY-SA. NonCommercial and
// NoDerivatives are rejected outright. A school is arguably non-commercial
// and this project sells school subscriptions, so "arguably" is not a basis
// on which to ship somebody else's recording.
//
// It also refuses anything that is not audio, anything over 3 MB — a lesson
// should not wait on a download — and prefers mp3 over ogg, because Safari
// will not play ogg and a silent button is worse than no button.
//
// A bird with no acceptable recording simply gets no sound, and the
// question falls back to the written mnemonic it has always used.
//
// Run:  node tools/fetch-bird-sounds.js
// Writes: docs/audio/birds/*.mp3  and  docs/js/community-bird-sounds.js

const fs = require('fs');
const path = require('path');

const UA = 'BirdWatchAI-Classroom/1.0 (educational bird-feeder project; '
         + 'contact via project repository)';

// Every bird BIRD_SOUNDS quotes a mnemonic for, plus the common feeder
// species the music questions compare. Scientific name included because
// Commons files are titled with it far more often than with the English
// name, and searching for "Killdeer" alone finds a Yellowstone field
// recording before it finds the bird.
const BIRDS = [
    ['Barred Owl',             'Strix varia'],
    ['Carolina Chickadee',     'Poecile carolinensis'],
    ['Eastern Towhee',         'Pipilo erythrophthalmus'],
    ['White-throated Sparrow', 'Zonotrichia albicollis'],
    ['Killdeer',               'Charadrius vociferus'],
    ['Mourning Dove',          'Zenaida macroura'],
    ['Northern Cardinal',      'Cardinalis cardinalis'],
    ['Blue Jay',               'Cyanocitta cristata'],
    ['American Crow',          'Corvus brachyrhynchos'],
    ['Tufted Titmouse',        'Baeolophus bicolor'],
];

const OK_LICENCE  = /^(cc0|cc[- ]by(?:[- ]sa)?([- ]\d(\.\d)?)?|public domain|pd-|no restrictions)/i;
const BAD_LICENCE = /\b(nc|nd|noncommercial|noderiv)\b/i;

const MAX_BYTES = 3 * 1024 * 1024;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Commons rate-limits an unauthenticated client readily, and one retry was
// not enough: three birds in a row were lost to 429 on the first run. Backs
// off further each time rather than hammering, because the failure mode is
// a bird that silently has no sound.
async function withRetry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); }
        catch (e) {
            last = e;
            if (!/429|503/.test(e.message)) throw e;
            await sleep(8000 * (i + 1));
        }
    }
    throw last;
}

async function api(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}

function plain(html) {
    if (!html) return '';
    return String(html)
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

// Candidate files, best first. Searching on the scientific name and
// filetype:audio is what keeps a documentary narration about killdeer from
// being picked over a recording of one.
async function candidates(common, latin) {
    const q = `${latin} filetype:audio`;
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
            + '&list=search&srnamespace=6&srlimit=12&srsearch=' + encodeURIComponent(q);
    const j = await api(u);
    const hits = ((j.query && j.query.search) || []).map(x => x.title.replace(/^File:/, ''));

    // mp3 first: Safari plays no ogg, and a play button that does nothing on
    // an iPad at the front of a classroom is worse than no play button.
    const mp3 = hits.filter(t => /\.mp3$/i.test(t));
    const ogg = hits.filter(t => /\.og[ga]$/i.test(t));
    return mp3.concat(ogg);
}

async function fileInfo(fileName) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
            + '&prop=imageinfo&iiprop=url|extmetadata|mime|size'
            + '&titles=' + encodeURIComponent('File:' + fileName);
    const j = await api(u);
    const pages = j.query && j.query.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    const info = page && page.imageinfo && page.imageinfo[0];
    if (!info) return null;

    const meta = info.extmetadata || {};
    const get = k => (meta[k] && meta[k].value) || '';
    return {
        // Commons appends UTM parameters here. Downloading with them works,
        // but they end up in the saved filename if anything derives one from
        // the URL — the same trap fetch-bird-photos.js documents.
        url:        String(info.url).split('?')[0],
        mime:       info.mime || '',
        size:       info.size || 0,
        descUrl:    info.descriptionurl,
        licence:    plain(get('LicenseShortName')),
        licenceUrl: plain(get('LicenseUrl')),
        artist:     plain(get('Artist')) || plain(get('Credit')) || 'Unknown',
        fileName,
    };
}

function acceptable(info) {
    if (!info) return 'no file info';
    // ⚠ application/ogg IS AUDIO HERE. Commons serves .ogg and .oga with
    // the container type rather than audio/ogg, and rejecting it threw away
    // every recording of the Carolina Chickadee, Mourning Dove and Tufted
    // Titmouse on the first run — three birds reported as "no recording
    // available" when Commons had several of each.
    if (!/^audio\/|^application\/ogg$/.test(info.mime)) return `not audio (${info.mime})`;
    if (info.size > MAX_BYTES) return `too big (${Math.round(info.size / 1024)}kB)`;
    const l = info.licence || '';
    if (!l) return 'no licence stated';
    if (BAD_LICENCE.test(l)) return `licence: ${l}`;
    if (!OK_LICENCE.test(l)) return `licence: ${l}`;
    return null;
}

async function download(url, dest) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return buf.length;
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
    const root    = path.join(__dirname, '..');
    const audioDir = path.join(root, 'docs', 'audio', 'birds');
    fs.mkdirSync(audioDir, { recursive: true });

    const kept = [], skipped = [];

    // ── Resume ──────────────────────────────────────────────────────
    //
    // Commons rate-limits downloads hard, and on the first full run three
    // birds were lost to 429 AFTER seven had been fetched successfully.
    // Re-running from scratch would re-download the seven and make the
    // limit more likely, not less. So anything already on disk, with
    // attribution already recorded, is kept as it is: the tool can be run
    // again an hour later and will only reach for what is missing.
    //
    // Delete docs/audio/birds to force a genuine refetch of everything.
    const prevPath = path.join(root, 'docs', 'js', 'community-bird-sounds.js');
    const prev = {};
    if (fs.existsSync(prevPath)) {
        const src = fs.readFileSync(prevPath, 'utf8');
        const re = /"([^"]+)": \{\s*file:\s*"([^"]+)",\s*artist:\s*"([^"]*)",\s*licence:\s*"([^"]*)",\s*licenceUrl:\s*"([^"]*)",\s*source:\s*"([^"]*)",/g;
        let m;
        while ((m = re.exec(src))) {
            prev[m[1]] = { species: m[1], file: m[2].replace(/^audio\/birds\//, ''),
                           artist: m[3], licence: m[4], licenceUrl: m[5], source: m[6] };
        }
    }

    for (const [common, latin] of BIRDS) {
        const have = prev[common];
        if (have && fs.existsSync(path.join(audioDir, have.file))) {
            kept.push({ ...have, bytes: fs.statSync(path.join(audioDir, have.file)).size });
            console.log(`  · ${common.padEnd(24)} ${have.file} (already have it)`);
            continue;
        }

        let done = false;
        try {
            const names = await withRetry(() => candidates(common, latin));
            for (const name of names) {
                const info = await withRetry(() => fileInfo(name));
                const why  = acceptable(info);
                if (why) { skipped.push([common, `${name}: ${why}`]); continue; }

                const ext  = path.extname(name).toLowerCase() || '.mp3';
                const file = slug(common) + ext;
                const bytes = await withRetry(() => download(info.url, path.join(audioDir, file)));

                kept.push({
                    species: common, file, bytes,
                    artist: info.artist, licence: info.licence,
                    licenceUrl: info.licenceUrl, source: info.descUrl,
                });
                console.log(`  ✓ ${common.padEnd(24)} ${file} (${Math.round(bytes / 1024)}kB, ${info.licence})`);
                done = true;
                break;
            }
        } catch (e) {
            skipped.push([common, e.message]);
        }
        if (!done && !skipped.some(s => s[0] === common)) {
            skipped.push([common, 'no candidates']);
        }
        await sleep(1200);
    }

    if (kept.length < 4) {
        throw new Error(`only ${kept.length} recordings accepted — refusing to write a `
                      + `data file that would silently disable every audio question`);
    }

    const out = `// ════════════════════════════════════════════════════════════════════
//  Bird song, for the classroom
// ════════════════════════════════════════════════════════════════════
//
//  GENERATED. Do not hand-edit — rerun tools/fetch-bird-sounds.js.
//
//  Recordings from Wikimedia Commons, every one under a licence that
//  permits commercial reuse. CC BY and CC BY-SA REQUIRE the author and
//  the licence to be shown wherever the recording is played, which is why
//  the attribution travels in this file rather than living in somebody's
//  notes — the slide renders what is recorded here, and if it is wrong
//  here it is wrong on the projector.
//
//  Fetched: ${new Date().toISOString().slice(0, 10)}
// ════════════════════════════════════════════════════════════════════

const BIRD_SOUND_FILES = {
${kept.map(k => `    ${JSON.stringify(k.species)}: {
        file:    ${JSON.stringify('audio/birds/' + k.file)},
        artist:  ${JSON.stringify(k.artist)},
        licence: ${JSON.stringify(k.licence)},
        licenceUrl: ${JSON.stringify(k.licenceUrl)},
        source:  ${JSON.stringify(k.source)},
    },`).join('\n')}
};

/**
 * The recording for a species, or null.
 *
 * Null is an ordinary answer: most feeder birds have no acceptable
 * recording on Commons, and a question that wanted one simply falls back
 * to its written mnemonic.
 */
function birdSound(species) {
    return (typeof BIRD_SOUND_FILES !== 'undefined' && BIRD_SOUND_FILES[species]) || null;
}
`;

    fs.writeFileSync(path.join(root, 'docs', 'js', 'community-bird-sounds.js'), out);

    console.log(`\n${kept.length} recordings written to docs/audio/birds/`);
    if (skipped.length) {
        console.log('\nSkipped:');
        for (const [bird, why] of skipped) console.log(`  · ${bird}: ${why}`);
    }
    console.log('\nNow run: node tools/stamp-assets.js');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
