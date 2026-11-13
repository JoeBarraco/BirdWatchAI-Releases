// Fetch a photograph of each "bird wonder" species from Wikimedia Commons,
// together with the attribution its licence requires.
//
// Why this exists
// ───────────────
// The fact slides talk about birds that will never visit a school feeder —
// an albatross, an emperor penguin — so there is no snapshot of them in our
// own data. Wikimedia Commons has photographs of all of them under licences
// that permit reuse, and those licences are the reason this is a script and
// not a handful of copied URLs: CC BY and CC BY-SA require the author and the
// licence to be shown wherever the image is, and getting that right by hand
// sixteen times is how it ends up wrong.
//
// So the attribution is fetched from the same API call as the image and
// written into the data file beside it. The slide renders what this records.
//
// What it refuses
// ───────────────
// Anything that is not public domain, CC0, CC BY or CC BY-SA. In particular
// it rejects NonCommercial and NoDerivatives: a school is arguably
// non-commercial, but "arguably" is not a basis on which to ship somebody
// else's photograph, and a fair-use argument is not available to us either.
// A bird with no acceptable image simply gets no picture.
//
// Run:  node tools/fetch-bird-photos.js
// Writes: docs/img/birds/*.jpg  and  docs/js/community-bird-photos.js

const fs = require('fs');
const path = require('path');

// Wikimedia asks automated clients to identify themselves. Deliberately
// generic: it names the project, not the person running it.
const UA = 'BirdWatchAI-Classroom/1.0 (educational bird-feeder project; '
         + 'contact via project repository)';

// The species each wonder needs a picture of. Where a fact is about a family
// rather than a species ("woodpeckers keep their tongue wrapped round their
// skull") a representative species is named, preferring one that actually
// turns up at feeders.
const BIRDS = [
    ['Budgerigar',                 'Budgerigar'],
    ['Arctic Tern',                'Arctic tern'],
    ['Peregrine Falcon',           'Peregrine falcon'],
    ['Bee Hummingbird',            'Bee hummingbird'],
    ['Emperor Penguin',            'Emperor penguin'],
    ['Common Swift',               'Common swift'],
    ['Woodpecker',                 'Downy woodpecker'],
    ['Carolina Chickadee',         'Carolina chickadee'],
    ['Wandering Albatross',        'Wandering albatross'],
    ['Homing Pigeon',              'Homing pigeon'],
    ['New Caledonian Crow',        'New Caledonian crow'],
    ['Barn Owl',                   'Barn owl'],
    ['Bar-headed Goose',           'Bar-headed goose'],
    ['Northern Cardinal',          'Northern cardinal'],
    ['Ruby-throated Hummingbird',  'Ruby-throated hummingbird'],
    ['Common Cuckoo',              'Common cuckoo'],
];

// Licences we may actually use. Matched against Commons' own short name.
const OK_LICENCE = /^(cc0|cc[- ]by(?:[- ]sa)?([- ]\d(\.\d)?)?|public domain|pd-|no restrictions)/i;
const BAD_LICENCE = /\b(nc|nd|noncommercial|noderiv)\b/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikimedia returns 429 readily. Retry once, slowly, rather than losing the
// bird to a transient limit.
async function withRetry(fn) {
    try { return await fn(); }
    catch (e) {
        if (!/429/.test(e.message)) throw e;
        await sleep(15000);
        return fn();
    }
}

async function api(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}

// Strip the HTML Commons puts in Artist/Credit fields. These contain links
// and markup; the slide wants a plain name.
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

async function leadImageFor(title) {
    const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json'
            + '&prop=pageimages&piprop=original&redirects=1'
            + '&titles=' + encodeURIComponent(title);
    const j = await api(u);
    const pages = j.query && j.query.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    if (!page || !page.original || !page.original.source) return null;

    // Wikipedia appends UTM parameters to this URL. Taking the basename
    // without stripping them yields a filename ending in
    // "...jpg?utm_source=en.wikipedia.org&..." which Commons reports as a
    // missing file — a silent miss that looks exactly like "this bird has no
    // photograph".
    const clean = page.original.source.split('?')[0];
    return decodeURIComponent(clean.split('/').pop());
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

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

(async () => {
    const outDir = path.join('docs', 'img', 'birds');
    fs.mkdirSync(outDir, { recursive: true });

    // Resume rather than restart. Wikimedia rate-limits an unauthenticated
    // client hard enough that a full pass rarely completes in one go, and
    // re-fetching the birds that already succeeded is both slower and ruder
    // than picking up where the last run stopped. Re-running until "0 skipped"
    // is the intended way to use this.
    const dataPath = path.join('docs', 'js', 'community-bird-photos.js');
    const got = {};
    if (fs.existsSync(dataPath)) {
        const prev = fs.readFileSync(dataPath, 'utf8');
        const json = prev.slice(prev.indexOf('{'), prev.lastIndexOf('}') + 1);
        try {
            for (const [k, v] of Object.entries(JSON.parse(json))) {
                if (fs.existsSync(path.join('docs', v.file))) got[k] = v;
            }
        } catch { /* a corrupt file just means a full re-fetch */ }
    }

    const skipped = [];

    for (const [bird, wikiTitle] of BIRDS) {
        if (got[bird]) continue;
        try {
            const file = await withRetry(() => leadImageFor(wikiTitle));
            if (!file) { skipped.push([bird, 'no lead image']); continue; }

            const info = await withRetry(() => fileInfo(file));
            if (!info)             { skipped.push([bird, 'no file info']); continue; }
            if (!acceptable(info)) { skipped.push([bird, `licence: ${info.licence || 'unknown'}`]); continue; }

            const ext  = (info.thumb.match(/\.(jpe?g|png)(?:$|\?)/i) || [, 'jpg'])[1].toLowerCase();
            const name = `${slug(bird)}.${ext === 'jpeg' ? 'jpg' : ext}`;
            const size = await download(info.thumb, path.join(outDir, name));

            got[bird] = {
                file:       `img/birds/${name}`,
                artist:     info.artist,
                licence:    info.licence,
                licenceUrl: info.licenceUrl,
                source:     info.descUrl,
            };
            console.log(`  ok   ${bird.padEnd(26)} ${info.licence.padEnd(16)} ${(size / 1024).toFixed(0)}KB  ${info.artist}`);

            // Be a polite client.
            await sleep(4000);
        } catch (e) {
            skipped.push([bird, e.message]);
        }
    }

    const header = `// Photographs of the birds in BIRD_WONDERS, from Wikimedia Commons.
//
// GENERATED by tools/fetch-bird-photos.js — do not edit by hand.
//
// Every entry carries the author and licence because CC BY and CC BY-SA
// REQUIRE them to be shown wherever the image appears. classroomShotHtml
// renders them onto the slide; removing that credit would make our use of
// these photographs an infringement rather than a licence.
//
// Only public domain, CC0, CC BY and CC BY-SA images are collected. Anything
// NonCommercial or NoDerivatives is rejected by the script.
window.BIRD_PHOTOS = `;

    fs.writeFileSync(path.join('docs', 'js', 'community-bird-photos.js'),
                     header + JSON.stringify(got, null, 4) + ';\n');

    console.log(`\n  ${Object.keys(got).length} photographs, ${skipped.length} skipped`);
    for (const [b, why] of skipped) console.log(`  skip ${b.padEnd(26)} ${why}`);
})();
