const fs = require('fs');
const sp = process.argv[2], outPath = process.argv[3];
const all = require(sp + '/standards.json');
const by  = new Map(all.map(x => [x.code, x]));

const raw = fs.readFileSync(sp + '/codes.txt', 'utf8').split(/\r?\n/);
const groups = []; let cur = null; const seenAll = new Set();
for (const line of raw) {
  if (!line.trim()) continue;
  if (line.startsWith('#')) { cur = { label: line.replace(/^#\s*/, ''), codes: [] }; groups.push(cur); }
  else if (cur && !seenAll.has(line.trim())) { seenAll.add(line.trim()); cur.codes.push(line.trim()); }
}

const ents = { '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&rsquo;':'\u2019','&lsquo;':'\u2018','&ldquo;':'\u201c','&rdquo;':'\u201d','&nbsp;':' ','&mdash;':'\u2014','&ndash;':'\u2013' };
const dec = s => s.replace(/&[a-z#0-9]+;/gi, m => ents[m] !== undefined ? ents[m] : m);

const SUBJ = { MA:'Mathematics (B.E.S.T.)', SC:'Science', ELA:'English Language Arts (B.E.S.T.)',
               SS:'Social Studies', VA:'Visual Art', MU:'Music' };

// Which classroom band a standard's grade belongs to. "68" (art/music span
// codes) is 6-8; everything else is a single grade.
function bandsFor(code) {
  const g = code.split('.')[1];
  if (g === '68') return ['6-8'];
  if (g === 'K') return ['k-2'];
  const n = parseInt(g, 10);
  if (!Number.isFinite(n)) return [];
  if (n <= 2) return ['k-2'];
  if (n <= 5) return ['3-5'];
  return ['6-8'];
}

let out = `// ════════════════════════════════════════════════════════════════════
//  Florida standards, for Classroom Mode
// ════════════════════════════════════════════════════════════════════
//
//  GENERATED. Do not hand-edit — rerun tools/fetch-standards.sh instead.
//
//  Every entry is a real benchmark from CPALMS (cpalms.org), Florida's
//  official standards repository, run by Florida State University. The text
//  is verbatim: a teacher who clicks through to the benchmark has to find
//  the same words, or the alignment claim is worthless.
//
//  WHY THESE AND NOT THE OTHER 2,500. ⚠
//  This is not Florida's K-8 standards. It is the subset a bird feeder can
//  produce EVIDENCE for — where a question built from real detections,
//  photographs or clips genuinely exercises the benchmark, rather than
//  mentioning its topic. "Collect and sort objects into categories and
//  compare the categories by counting" is a feeder question. "Identify the
//  organs in the human body" is not, and no amount of birds makes it one.
//
//  A TAG IS A CLAIM, AND A WRONG ONE IS WORSE THAN NONE.
//  A teacher who tells an administrator a lesson covered MA.3.DP.1.2 is
//  staking their own credibility on this file. So a template claims a
//  benchmark only where the QUESTION ITSELF does the work the benchmark
//  describes. Being about birds is not alignment. Being about data is not
//  alignment with a data standard, unless the child has to do the thing.
//
//  Grade bands come from the code's own grade digit, so they are not a
//  judgement call: K-2, 3-5, 6-8. Art and music use a "68" span code,
//  which is the 6-8 band whole.
//
//  Source: https://www.cpalms.org/Public/search/Standard
//  Fetched: ${new Date().toISOString().slice(0, 10)}
// ════════════════════════════════════════════════════════════════════

const CLASSROOM_STANDARDS = {
`;

let n = 0;
for (const g of groups) {
  if (!g.codes.length) continue;
  out += `\n    // ── ${g.label} ${'─'.repeat(Math.max(2, 62 - g.label.length))}\n`;
  for (const c of g.codes) {
    const s = by.get(c);
    if (!s) throw new Error('missing ' + c);
    const text = dec(s.text).replace(/\s+/g, ' ').trim();
    const subject = SUBJ[c.split('.')[0]] || c.split('.')[0];
    out += `    ${JSON.stringify(c)}: { subject: ${JSON.stringify(subject)}, `
         + `bands: ${JSON.stringify(bandsFor(c))}, text: ${JSON.stringify(text)} },\n`;
    n++;
  }
}
out += `};

// cpalms.org has no stable per-code URL, so the search page carries the code
// as its keyword. A teacher lands on the benchmark they were promised.
function classroomStandardUrl(code) {
    return 'https://www.cpalms.org/Public/search/Standard?keyword=' + encodeURIComponent(code);
}

// Short label for a chip: the code alone. The full text belongs in a tooltip
// or the lesson report, not on a slide a seven-year-old is looking at.
function classroomStandardLabel(code) {
    return code;
}

function classroomStandard(code) {
    return CLASSROOM_STANDARDS[code] || null;
}
`;

// A scrape that silently returns nothing is the failure mode worth
// guarding: without this the generator would happily write a catalogue
// with no standards in it, every alignment chip would vanish, and the
// only symptom would be a quieter UI. The curated list is ~130 codes, so
// anything under 100 means the fetch or the parse broke.
if (n < 100) {
  throw new Error(`only ${n} standards resolved — the CPALMS fetch or parse `
                + `is broken; refusing to overwrite ${outPath}`);
}

fs.writeFileSync(outPath, out);
console.log('wrote', n, 'standards to', outPath);
