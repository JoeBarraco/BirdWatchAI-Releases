#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  Check the standards alignment without opening a browser
// ════════════════════════════════════════════════════════════════════
//
//  Usage:  node tools/check-alignment.js [--gaps]
//
//  classroom-alignment.js carries its own self-check, but it only runs in
//  a browser and only writes to the console, where nobody is looking. This
//  runs the same check from the command line and EXITS NON-ZERO, so a bad
//  alignment can fail a commit instead of shipping quietly.
//
//  --gaps lists benchmarks in the catalogue that no question covers yet.
//  That list is the backlog for new questions: it is the whole reason the
//  catalogue holds benchmarks we do not serve, rather than only the ones
//  we do.
//
//  HOW IT GETS THE TEMPLATES. ⚠
//  By reading the CLASSROOM_TEMPLATES literal out of community-classroom.js
//  with a regex, not by running the file — the file is a browser script
//  that touches document on load. A parse that finds nothing would make
//  every check trivially pass, which is the failure this project has been
//  bitten by before, so finding fewer than 50 templates is a hard error.
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// Line endings normalised on the way in, ALWAYS. This repo commits with
// core.autocrlf on, so the working copy carries CRLF, and the template
// split below matches a newline-brace-newline sequence that CRLF breaks.
// It stopped matching, the parse found zero templates, and the guard in
// templates() correctly refused to run — but the cause took longer to find
// than it should have. Reading a source file is not the place to be clever
// about platforms.
const read = p => fs.readFileSync(path.join(root, p), 'utf8')
                     .split(String.fromCharCode(13)).join('');

// ── Pull id + bands out of the template list ────────────────────────
function templates() {
    const src = read('docs/js/community-classroom.js');
    const start = src.indexOf('const CLASSROOM_TEMPLATES = [');
    if (start < 0) throw new Error('CLASSROOM_TEMPLATES not found in community-classroom.js');
    const body = src.slice(start, src.indexOf('\n];', start));

    const out = [];
    for (const chunk of body.split(/\n\{\n/).slice(1)) {
        const id = (chunk.match(/id: *'([a-z0-9-]+)'/) || [])[1];
        const bands = (chunk.match(/bands: *\[([^\]]*)\]/) || [])[1];
        if (id) out.push({ id, bands: (bands || '').replace(/['\s]/g, '').split(',').filter(Boolean) });
    }
    if (out.length < 50) {
        throw new Error(`parsed only ${out.length} templates — the literal's shape changed, `
                      + `and every check below would pass for the wrong reason`);
    }
    return out;
}

// ── Run both files in one sandbox, as the browser does ──────────────
let warned = null;
const ctx = {
    console: Object.assign({}, console, { warn: m => { warned = m; } }),
    CLASSROOM_TEMPLATES: templates(),
};
vm.createContext(ctx);

const result = vm.runInContext(
    read('docs/js/classroom-standards.js') + '\n' +
    read('docs/js/classroom-alignment.js') + '\n' +
    `;(() => {
        const covered = new Set([].concat(...Object.values(CLASSROOM_TEMPLATE_STANDARDS)));
        return {
            templates: CLASSROOM_TEMPLATES.length,
            tagged:    Object.values(CLASSROOM_TEMPLATE_STANDARDS).filter(v => v.length).length,
            benchmarks: Object.keys(CLASSROOM_STANDARDS).length,
            covered:   covered.size,
            gaps: Object.entries(CLASSROOM_STANDARDS)
                    .filter(([k]) => !covered.has(k))
                    .map(([k, v]) => [k, v.bands.join('/'), v.subject, v.text]),
        };
    })()`,
    ctx);

if (warned) {
    console.error(warned);
    process.exit(1);
}

const blank = result.templates - result.tagged;
console.log(`✓ alignment OK`);
console.log(`  ${result.templates} templates — ${result.tagged} tagged, ${blank} deliberately blank`);
console.log(`  ${result.covered} of ${result.benchmarks} benchmarks covered `
          + `(${result.gaps.length} with no question yet)`);

if (process.argv.includes('--gaps')) {
    console.log('\nBenchmarks nothing asks about yet:\n');
    let subject = null;
    for (const [code, bands, subj, text] of result.gaps) {
        if (subj !== subject) { subject = subj; console.log(`  ── ${subj}`); }
        console.log(`  ${code.padEnd(14)} ${bands.padEnd(5)} ${text.slice(0, 96)}`);
    }
}
