#!/usr/bin/env node
// ── Content-hash cache busting for the static site ──────────────────────────
//
// WHY THIS EXISTS
// Every local script and stylesheet is referenced with a hand-written
// `?v=<number>`, and the number only moves when somebody remembers to move it.
// Twice now it was not moved:
//
//   * 2f86d59 rebuilt the feed card across community-views.js and
//     community.css without touching community.html. Browsers with a warm
//     cache kept the old renderer. It stayed invisible for two months because
//     they were holding the old stylesheet too — old JS with old CSS is a
//     consistent pair.
//   * Bumping the stylesheet for classroom mode broke that pairing. Fresh CSS
//     arrived against two-month-old JS, `.card .card-photo` matched nothing,
//     and every detection photo rendered at its natural 1280px.
//
// The failure mode is nasty precisely because it does not reproduce for the
// person who made the change: their browser has both new files. It only shows
// up for people with a warm cache, which is everyone else.
//
// WHAT IT DOES
// Replaces each `?v=` with the first 8 hex of the SHA-1 of the file's content
// with its line endings normalised to LF. The stamp then cannot be out of step
// with the file, because it IS the file. An unchanged file keeps its stamp, so
// running this does not invalidate caches needlessly.
//
// WHY LF AND NOT THE BYTES ON DISK
// This repository is checked out with core.autocrlf=true, so a working tree on
// Windows holds CRLF while the blob — the thing committed, and the thing
// GitHub Pages serves — holds LF. Hashing the bytes on disk made the stamp
// depend on how the file last reached the disk:
//
//   * materialised by `git checkout`  ->  CRLF  ->  one hash
//   * written by an editor that saves LF  ->  LF  ->  a different hash
//
// Both are the same file as far as git is concerned, so the diff was invisible
// while the stamp silently disagreed. community-auth.js was committed with an
// LF-derived stamp that way, and every later run on Windows offered to change
// it back; a run on Linux would have offered the reverse. Normalising first
// makes the stamp the hash of what a browser actually downloads, and the same
// on every machine.
//
// USAGE
//   node tools/stamp-assets.js            rewrite the HTML in place
//   node tools/stamp-assets.js --check    report only; exit 1 if anything stale
//
// The --check mode is the one to put in CI, or in a pre-commit hook, so the
// answer stops depending on memory.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

// HTML files that reference local assets. Listed explicitly rather than
// globbed: the manual's chapter pages reference their own assets and are
// versioned as a set, and sweeping them in here silently would be a much
// larger change than the one this script is for.
const HTML_FILES = [
    'docs/community.html',
    'docs/live.html',
    'index.html',
];

// src="js/x.js" or href="css/x.css", with an optional existing query.
// Deliberately NOT matching protocol-relative or absolute URLs: a CDN copy of
// Leaflet is version-pinned in its own path and is not ours to stamp.
const ASSET_REF = /((?:src|href)=")((?!https?:|\/\/)[^"?]+\.(?:js|css))(\?[^"]*)?(")/g;

// The latin1 round trip is byte-exact, so nothing but CRLF pairs is touched:
// a UTF-8 decode and re-encode would rewrite a BOM or a lone surrogate and
// change the hash for reasons that have nothing to do with the file's content.
// Only \r\n is folded; a lone \r is left alone, since in these files it would
// be data rather than a line ending.
function shortHash(buf) {
    const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    return crypto.createHash('sha1').update(lf).digest('hex').slice(0, 8);
}

let changed = 0, checked = 0, missing = 0;
const stale = [];

for (const rel of HTML_FILES) {
    const htmlPath = path.join(repoRoot, rel);
    if (!fs.existsSync(htmlPath)) {
        console.warn(`  skip   ${rel} (not found)`);
        continue;
    }

    // Read as a Buffer and work on a latin1 string so the bytes survive a
    // round trip untouched. Decoding as UTF-8 and re-encoding would rewrite
    // every file with a BOM or a lone surrogate, and the line endings here are
    // CRLF that the repo cares about.
    const original = fs.readFileSync(htmlPath).toString('latin1');
    const htmlDir = path.dirname(htmlPath);

    const updated = original.replace(ASSET_REF, (full, pre, assetPath, query, post) => {
        const assetFile = path.join(htmlDir, assetPath);
        if (!fs.existsSync(assetFile)) {
            console.warn(`  MISSING ${rel} -> ${assetPath}`);
            missing++;
            return full;
        }
        checked++;

        const want = shortHash(fs.readFileSync(assetFile));
        const have = query ? (/[?&]v=([^&]*)/.exec(query) || [, null])[1] : null;

        if (have === want) return full;

        stale.push(`${rel}: ${assetPath}  ${have === null ? '(unstamped)' : have} -> ${want}`);
        changed++;

        // Preserve any other query parameters; only v= is ours.
        const rest = (query || '')
            .replace(/^\?/, '')
            .split('&')
            .filter(p => p && !/^v=/.test(p));
        rest.unshift(`v=${want}`);
        return `${pre}${assetPath}?${rest.join('&')}${post}`;
    });

    if (updated !== original && !checkOnly) {
        fs.writeFileSync(htmlPath, Buffer.from(updated, 'latin1'));
    }
}

console.log(`\n  ${checked} asset reference(s) checked, ${changed} stale, ${missing} missing`);
if (stale.length) {
    console.log('');
    stale.forEach(s => console.log('   ' + s));
}

if (checkOnly && (changed || missing)) {
    console.log('\n  --check: stamps are out of date. Run: node tools/stamp-assets.js\n');
    process.exit(1);
}
if (!checkOnly && changed) {
    console.log('\n  Stamped. Commit the HTML alongside the assets it points at.\n');
}
