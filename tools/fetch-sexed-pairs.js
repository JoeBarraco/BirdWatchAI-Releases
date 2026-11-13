// Fetch a MALE and a FEMALE photograph of the same species from Wikimedia
// Commons, with the attribution their licences require.
//
// Why this is separate from fetch-bird-photos.js
// ──────────────────────────────────────────────
// That script asks Wikipedia for a species' lead image — one picture, and
// whichever one the article happens to use. This needs two pictures of the
// same species that differ in a specific way, which the lead image cannot
// give and a search alone cannot guarantee: searching "northern cardinal
// female" happily returns pictures of males.
//
// So the sex is VERIFIED rather than hoped for. Only a file whose own title
// says which sex it shows is accepted, and "male" is matched with a lookbehind
// so that the word "female" cannot satisfy it — the single most likely way to
// end up shipping a slide that shows two males and asks a class to spot the
// difference.
//
// A pair where either half cannot be verified is dropped whole. Half a pair
// is worse than none: the slide's entire point is the comparison.
//
// Licensing is the same rule as the other fetcher: public domain, CC0, CC BY
// and CC BY-SA only. NonCommercial and NoDerivatives are refused.
//
// Run:  node tools/fetch-sexed-pairs.js
// Writes: docs/img/birds/*-male.jpg, *-female.jpg
//         docs/js/community-bird-pairs.js

const fs = require('fs');
const path = require('path');

const UA = 'BirdWatchAI-Classroom/1.0 (educational bird-feeder project; '
         + 'contact via project repository)';

// Species where the difference is unmistakable across a classroom. A subtle
// pair teaches nothing at projector size from the back of a room.
const PAIRS = [
    ['Northern Cardinal',    'Cardinalis cardinalis'],
    ['Red-winged Blackbird', 'Agelaius phoeniceus'],
    ['Mallard',              'Anas platyrhynchos'],
    ['House Finch',          'Haemorhous mexicanus'],
];

const OK_LICENCE  = /^(cc0|cc[- ]by(?:[- ]sa)?([- ]\d(\.\d)?)?|public domain|pd-|no restrictions)/i;
const BAD_LICENCE = /\b(nc|nd|noncommercial|noderiv)\b/i;

// "female" contains "male". Without the lookbehind every female photograph
// also matches the male test, and the pair silently becomes two of the same.
const SEX_RE = { male: /(?<!fe)male/i, female: /female/i };

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}

async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
        if (!/429/.test(e.message)) throw e;
        await sleep(15000);
        return fn();
    }
}

function plain(html) {
    if (!html) return '';
    return String(html)
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Commons file search, newest-irrelevant: relevance order is what we want,
// because the best-described files tend to be the best photographs.
async function searchFiles(term, limit = 40) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
            + '&list=search&srnamespace=6&srlimit=' + limit
            + '&srsearch=' + encodeURIComponent(term);
    const j = await api(u);
    return ((j.query && j.query.search) || []).map(r => r.title.replace(/^File:/, ''));
}

async function fileInfo(fileName) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
            + '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900'
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
        thumb:      info.thumburl || info.url,
        descUrl:    info.descriptionurl,
        licence:    plain(get('LicenseShortName')),
        licenceUrl: plain(get('LicenseUrl')),
        artist:     plain(get('Artist')) || plain(get('Credit')) || 'Unknown',
        fileName,
    };
}

function acceptable(info) {
    const l = info.licence || '';
    if (!l) return false;
    if (BAD_LICENCE.test(l)) return false;
    return OK_LICENCE.test(l);
}

async function download(url, dest) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} downloading ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return buf.length;
}

const slug = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * One verified photograph of one sex.
 *
 * The title test is the whole guarantee. A file called
 * "Cardinalis_cardinalis_female_Ohio.jpg" says what it shows; one called
 * "Cardinal_in_snow.jpg" does not, whatever the search ranking thinks, and is
 * skipped rather than guessed at.
 */
async function findSexed(sci, common, sex, outDir) {
    const want = SEX_RE[sex];
    const seen = new Set();
    const terms = [`${sci} ${sex}`, `${common} ${sex}`];

    for (const term of terms) {
        let names = [];
        try { names = await withRetry(() => searchFiles(term)); }
        catch (e) { console.log(`    search "${term}" failed: ${e.message}`); continue; }

        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            if (!/\.(jpe?g|png)$/i.test(name)) continue;
            // The file must SAY which sex it is, and must not say the other.
            if (!want.test(name)) continue;
            if (sex === 'male' && SEX_RE.female.test(name)) continue;
            if (sex === 'female' && !SEX_RE.female.test(name)) continue;

            let info = null;
            try { info = await withRetry(() => fileInfo(name)); }
            catch { continue; }
            if (!info || !acceptable(info)) continue;

            const dest = path.join(outDir, `${slug(common)}-${sex}.jpg`);
            try {
                const bytes = await download(info.thumb, dest);
                console.log(`    ${sex}: ${name}  (${(bytes / 1024).toFixed(0)}KB, ${info.licence})`);
                return {
                    file: `img/birds/${slug(common)}-${sex}.jpg`,
                    artist: info.artist,
                    licence: info.licence,
                    licenceUrl: info.licenceUrl,
                    source: info.descUrl,
                };
            } catch (e) {
                console.log(`    download failed for ${name}: ${e.message}`);
            }
            await sleep(400);
        }
    }
    return null;
}

(async () => {
    const outDir = path.join(__dirname, '..', 'docs', 'img', 'birds');
    fs.mkdirSync(outDir, { recursive: true });

    const out = {};
    for (const [common, sci] of PAIRS) {
        console.log(`\n${common} (${sci})`);
        const male   = await findSexed(sci, common, 'male', outDir);
        const female = await findSexed(sci, common, 'female', outDir);
        if (male && female) {
            out[common] = { male, female };
        } else {
            // Half a pair cannot carry a side-by-side comparison, so it is
            // dropped rather than shipped as a single picture that implies
            // something the slide is not showing.
            console.log(`    INCOMPLETE — male:${!!male} female:${!!female}; dropping the pair`);
            for (const sex of ['male', 'female']) {
                const p = path.join(outDir, `${slug(common)}-${sex}.jpg`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            }
        }
        await sleep(600);
    }

    const header = `// Male/female photographs of the same species, from Wikimedia Commons.
//
// GENERATED by tools/fetch-sexed-pairs.js — do not edit by hand.
//
// Each entry carries the author and licence because CC BY and CC BY-SA
// REQUIRE them wherever the image appears; the slide renders them.
//
// The sex of each photograph was verified against the Commons file title
// rather than trusted from a search ranking — "female" contains "male", and
// a pair showing two males would quietly break the one question these exist
// for. A species whose pair could not be completed is absent entirely.
window.BIRD_PAIRS = `;
    const file = path.join(__dirname, '..', 'docs', 'js', 'community-bird-pairs.js');
    fs.writeFileSync(file, header + JSON.stringify(out, null, 4) + ';\n');
    console.log(`\nWrote ${Object.keys(out).length} complete pair(s) to ${file}`);
})();
