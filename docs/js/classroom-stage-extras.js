// BirdWatchAI Classroom — the projector stage, read aloud and explained
//
// Two additions to the stage in community-classroom.js, kept here so that
// 19,000-line file only gains the hooks that call them:
//
//   🔊 Read aloud   The browser's own speech (speechSynthesis) reads the
//                   question and its choices, and after the reveal reads the
//                   answer and why. K-2 children cannot read the prompt yet,
//                   and an English learner can hear it as well as see it. On
//                   by default for K-2, off for the older bands; the choice is
//                   remembered per class on this machine. R reads, or stops.
//
//   🔎 How we know  On the reveal, the chart points at its own evidence: the
//                   bar, slice or point that IS the answer is highlighted, and
//                   one line under the answer says where to look. Before the
//                   reveal a chart may only highlight what the question is
//                   ABOUT, never the answer (see cmChart); once the answer is
//                   up there is nothing left to give away.
//
// Nothing here talks to the server, and nothing is stored but the read-aloud
// preference.

// ── 🔊 Read aloud ────────────────────────────────────────

const ccVoice = { key: null, speaking: false };

function ccVoiceSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
        && typeof SpeechSynthesisUtterance === 'function';
}

function ccVoiceAuto(room) {
    if (!room) return false;
    try {
        const v = localStorage.getItem('cc-voice-auto-' + room.id);
        if (v === '1') return true;
        if (v === '0') return false;
    } catch { /* private window: fall through to the band default */ }
    return room.grade_band === 'k-2';
}

function ccVoiceSetAuto(on) {
    const S = classroomSession;
    if (!S) return;
    try { localStorage.setItem('cc-voice-auto-' + S.room.id, on ? '1' : '0'); } catch { /* fine */ }
    if (on) ccVoiceRead(); else ccVoiceStop();
}

/**
 * Text as a voice should say it. Written for the eye, the prompts carry
 * things a speech engine reads badly or not at all: "42–58" comes out as
 * "forty-two fifty-eight", "°F" as nothing, an emoji as its Unicode name.
 */
function ccSpeakable(t) {
    return String(t || '')
        .replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2')
        .replace(/°\s*F\b/g, ' degrees')
        .replace(/°/g, ' degrees')
        .replace(/(\d)\s*%/g, '$1 percent')
        .replace(/\s&\s/g, ' and ')
        .replace(/≈/g, ' about ')
        .replace(/×/g, ' times ')
        .replace(/÷/g, ' divided by ')
        .replace(/\bvs\.?\s/gi, 'versus ')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
        .replace(/[·•|]/g, ', ')
        // Dates as the slide writes them, "Sun 11/15", as a person says them.
        .replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (m, mo, d) =>
            mo >= 1 && mo <= 12 ? `${CC_MONTHS[mo - 1]} ${Number(d)}` : m)
        .replace(/\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b\.?/g, m => CC_DAYS[m.slice(0, 3)])
        .replace(/\s+([,.?!])/g, '$1')
        .replace(/,(\s*,)+/g, ',')
        .replace(/\s+/g, ' ')
        .trim();
}

const CC_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'];
const CC_DAYS = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
                  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

/** What to say for the slide as it stands: the question, or the answer. */
function ccVoiceScript(S, q) {
    if (!S || !q) return '';
    const labels = (q.choices || []).map(c => String(c.label || '').trim()).filter(Boolean);
    if (!S.revealed) {
        const parts = [];
        if (Array.isArray(q.intro)) parts.push(...q.intro);
        parts.push(q.prompt);
        // A build or grid question is answered on the chart, not from a list.
        if (!q.build && !q.grid && labels.length >= 2 && labels.length <= 6
            && labels.every(l => l.length <= 60)) {
            parts.push(labels.slice(0, -1).join(', ') + ', or ' + labels[labels.length - 1] + '?');
        }
        return ccSpeakable(parts.join(' '));
    }
    const parts = [];
    if (q.poll) parts.push('There is no single right answer to this one. What did you notice?');
    else if (q.correct_index == null) parts.push('Answer recorded. We will check it next class.');
    else {
        const right = labels[q.correct_index] || '';
        parts.push(q.class_index === q.correct_index ? 'The class got it!' : 'Not quite.');
        if (right) parts.push(`The answer is ${right}.`);
    }
    if (q.cc_how) parts.push(q.cc_how);
    if (q.explain) parts.push(q.explain);
    return ccSpeakable(parts.join(' '));
}

function ccVoicePick() {
    const voices = window.speechSynthesis.getVoices() || [];
    const en = voices.filter(v => /^en(-|_)US/i.test(v.lang));
    return en.find(v => v.localService) || en[0]
        || voices.find(v => /^en/i.test(v.lang)) || null;
}

function ccVoiceSpeak(text, band) {
    if (!ccVoiceSupported() || !text) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    // One utterance per sentence. Chrome stops a long utterance dead after
    // about fifteen seconds, mid-word, and an intro plus a question plus
    // four choices is longer than that.
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const voice = ccVoicePick();
    ccVoice.speaking = true;
    ccVoiceButtonState();
    chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c.trim());
        if (voice) u.voice = voice;
        u.lang = (voice && voice.lang) || 'en-US';
        // Slower for the youngest. 0.85 is still a natural voice; below
        // about 0.8 most engines start to sound broken.
        u.rate = band === 'k-2' ? 0.85 : 0.95;
        if (i === chunks.length - 1) {
            u.onend = u.onerror = () => { ccVoice.speaking = false; ccVoiceButtonState(); };
        }
        synth.speak(u);
    });
}

function ccVoiceStop() {
    if (ccVoiceSupported()) window.speechSynthesis.cancel();
    ccVoice.speaking = false;
    ccVoiceButtonState();
}

function ccVoiceRead() {
    const S = classroomSession;
    if (!S) return;
    ccVoiceSpeak(ccVoiceScript(S, S.questions[S.index]), S.room.grade_band);
}

/** The button and R both toggle: read if quiet, stop if reading. */
function ccVoiceToggle() {
    if (ccVoice.speaking) ccVoiceStop(); else ccVoiceRead();
}

function ccVoiceButtonState() {
    const b = document.getElementById('cc-voice-btn');
    if (b) b.textContent = ccVoice.speaking ? '⏹ Stop reading' : '🔊 Read aloud';
}

/** For the stage foot. Nothing at all in a browser that cannot speak. */
function ccVoiceControlsHtml(S) {
    if (!ccVoiceSupported() || !S) return '';
    const auto = ccVoiceAuto(S.room);
    return `<span class="cc-voice">
        <button class="classroom-btn" id="cc-voice-btn" onclick="ccVoiceToggle()"
                title="Read the question aloud (R)">${ccVoice.speaking ? '⏹ Stop reading' : '🔊 Read aloud'}</button>
        <label class="cc-voice-auto" title="Read every question, and every answer, as it comes up">
            <input type="checkbox" ${auto ? 'checked' : ''} onchange="ccVoiceSetAuto(this.checked)"> auto</label>
    </span>`;
}

/**
 * After every stage render. Speaks only when the SLIDE changed — a new
 * question, or the same question revealed — never on a re-render of the
 * same slide (the vote poll re-renders every second and a half).
 */
function ccVoiceAfterRender(S) {
    if (!S) return;
    const key = `${S.id}:${S.index}:${S.revealed ? 'r' : 'q'}`;
    if (key === ccVoice.key) return;
    ccVoice.key = key;
    if (ccVoiceAuto(S.room)) ccVoiceRead();
    else if (ccVoice.speaking) ccVoiceStop();   // still reading the last slide
}

// ── 🔎 How we know ───────────────────────────────────────

const CC_POINTER_NOUN = {
    bars: 'bar', hbars: 'bar', dots: 'column', donut: 'slice',
    line: 'point', picto: 'row', clock: 'hour',
};

function ccNorm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The chart row that IS the answer, or null.
 *
 * Only an unambiguous match counts: the correct choice's label equal to one
 * row's label or key, or contained in exactly one row's label ("Sunday" in
 * "Sun 11/15"), never a number. A count like "12" matching a row called
 * "12pm" is the kind of coincidence that would point a class at the wrong
 * bar, and pointing wrongly is worse than not pointing.
 */
function ccAnswerRow(q) {
    const chart = q && q.chart;
    if (!chart || !Array.isArray(chart.series) || !chart.series.length) return null;
    if (!CC_POINTER_NOUN[chart.kind]) return null;
    if (q.correct_index == null || !q.choices || !q.choices[q.correct_index]) return null;
    const ans = ccNorm(q.choices[q.correct_index].label);
    if (!ans || /^\d+( \d+)*$/.test(ans)) return null;

    const rows = chart.series;
    const exact = rows.filter(r => ccNorm(r.label) === ans || ccNorm(r.key) === ans);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    // Partial, either way round, on whole words: "Sunday" against "Sun 11/15"
    // is a prefix of a word, "Northern Cardinal" against "Cardinal" is a word.
    const words = s => ccNorm(s).split(' ').filter(Boolean);
    const aw = words(ans);
    const loose = rows.filter(r => {
        const rw = words(r.label);
        if (!rw.length) return false;
        const dayish = aw.length === 1 && rw[0].length >= 3 && aw[0].startsWith(rw[0]) && !/^\d/.test(rw[0]);
        const contains = aw.length > 1 && aw.every(w => rw.includes(w));
        const within = rw.length > 1 && rw.every(w => aw.includes(w));
        return dayish || contains || within;
    });
    return loose.length === 1 ? loose[0] : null;
}

/**
 * What the reveal says about where the answer came from.
 *   { text, pointer } — pointer is true when the chart has been told to
 *   highlight the answer, and text says where to look. Null when there is
 *   nothing to add to the question's own explanation.
 */
function ccHowWeKnow(q) {
    const row = ccAnswerRow(q);
    if (!row) return null;
    const noun = CC_POINTER_NOUN[q.chart.kind] || 'bar';
    const label = String(row.label || row.key);
    const value = typeof row.value === 'number' && isFinite(row.value)
        ? ` It shows ${Number.isInteger(row.value) ? row.value : row.value.toFixed(1)}.` : '';
    return { pointer: true, key: row.key,
             text: `Look at the highlighted ${noun} for ${label} on the chart.${value}` };
}

/**
 * Called once a question is revealed, before the stage draws it: points the
 * chart at the answer. The question's own pre-reveal highlight (what the
 * question is about) is kept where there is one — it is usually the same
 * row, and when it is not, it is the row the explanation talks about.
 */
function ccRevealPrepare(q) {
    if (!q || !q.chart || q.chart.highlight || q.cc_how_done) return;
    q.cc_how_done = true;
    const how = ccHowWeKnow(q);
    if (how) { q.chart.highlight = how.key; q.cc_how = how.text; }
}

function ccHowHtml(q) {
    return q && q.cc_how ? `<div class="cc-how">🔎 ${esc(q.cc_how)}</div>` : '';
}
