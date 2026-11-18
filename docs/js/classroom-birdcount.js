// BirdWatchAI Classroom — a class bird count, for eBird
//
// The class watches the feeder through the window for ten or fifteen
// minutes and counts what it sees. At the end the teacher downloads a file
// in eBird's "Record Format" and uploads it at ebird.org, where it becomes
// a real checklist in the world's biggest bird database.
//
// ⚠ WHY THE CLASS COUNTS, AND THE CAMERA DOES NOT
// eBird's own rules (support.ebird.org, "eBird Rules and Best Practices")
// say, in so many words: "Remote sensed images or video - do not enter any
// data from nest cameras, feeder cameras, trail cams". So nothing the
// feeder camera detected goes into this file. The tiles are pre-filled with
// the birds the camera has seen lately only so a class does not have to
// type names; every count starts at zero and is what the children saw.
//
// THE FILE (support.ebird.org, "Upload spreadsheet data to eBird", checked
// 2026-11-18): a .csv with NO header row, 19 columns in this order —
//   A Common Name  B Genus  C Species  D Number  E Species Comments
//   F Location Name  G Latitude  H Longitude  I Date (M/D/YYYY)
//   J Start Time (HH:MM)  K State/Province (1-3 chars)  L Country (2)
//   M Protocol  N Number of Observers  O Duration (minutes)
//   P All observations reported (Y/N)  Q Effort Distance Miles
//   R Effort area acres  S Submission Comments
// with no quotation marks and no line breaks anywhere in it. Protocol is
// "Stationary": a class standing at one window for a set time is exactly
// that, and it is the protocol eBird's science values most.
//
// HOW A CLASS SHOULD COUNT. eBird's count is how many birds, not how many
// visits; at a feeder the honest number is the MOST of one kind seen at the
// same moment (eight chickadees coming and going might be the same three).
// The tiles say so, and the number on each is that maximum.

const CB_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
    'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR'];

let cbCount = null;   // { room, setup, startedAt, endsAt, birds: [{name, photo, n}], timer }

function cbPrefs(room) {
    try { return JSON.parse(localStorage.getItem('cc-birdcount-' + room.id) || '{}'); } catch { return {}; }
}
function cbSavePrefs(room, p) {
    try { localStorage.setItem('cc-birdcount-' + room.id, JSON.stringify(p)); } catch { /* fine */ }
}

/** The feeder's position, from its most recent detection that has one. */
async function cbFeederPosition(feederId) {
    if (!feederId) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/community_detections?feeder_id=eq.${encodeURIComponent(feederId)}`
            + '&latitude=not.is.null&select=latitude,longitude&order=detected_at.desc&limit=1', { headers: sbHeaders(true) });
        if (!res.ok) return null;
        const r = (await res.json())[0];
        return r && isFinite(r.latitude) && isFinite(r.longitude)
            ? { lat: Number(r.latitude).toFixed(5), lng: Number(r.longitude).toFixed(5) } : null;
    } catch { return null; }
}

/** Birds to put on tiles: what the feeder has seen in the last month, most first. */
async function cbLikelyBirds(room) {
    const ids = room.home_feeder_id ? [room.home_feeder_id] : [];
    let out = [];
    if (ids.length && typeof ckFirsts === 'function') {
        const to = new Date(), from = new Date(to.getTime() - 30 * 864e5);
        out = ((await ckFirsts(ids, from, to)) || []).sort((a, b) => b.n - a.n)
            .map(f => ({ name: f.sp, photo: f.photo }));
    }
    // Topped up with common feeder birds so a new feeder still has tiles.
    for (const n of ['Northern Cardinal', 'Blue Jay', 'Mourning Dove', 'American Robin', 'House Sparrow',
                     'Carolina Chickadee', 'Downy Woodpecker', 'American Goldfinch']) {
        if (out.length >= 12) break;
        if (!out.some(b => b.name === n)) out.push({ name: n, photo: null });
    }
    return out.slice(0, 12);
}

// ── Setup ────────────────────────────────────────────────

async function showClassroomBirdCount(roomId) {
    const room = (typeof classroomList !== 'undefined' ? classroomList : []).find(r => r.id === roomId);
    const stage = document.getElementById('classroom-stage');
    if (!room || !stage) return;
    stage.style.display = 'flex';
    stage.innerHTML = '<div class="classroom-stage-loading">Getting the count ready…</div>';

    const prefs = cbPrefs(room);
    const [pos, birds] = await Promise.all([cbFeederPosition(room.home_feeder_id), cbLikelyBirds(room)]);
    const school = typeof cmHistoryCommunityName === 'function' ? cmHistoryCommunityName() : '';
    cbCount = {
        room, birds: birds.map(b => ({ ...b, n: 0 })), timer: null,
        setup: {
            minutes: prefs.minutes || 10,
            observers: prefs.observers || '',
            location: prefs.location || `${school || room.name} bird feeder`.trim(),
            state: prefs.state || '',
            lat: pos ? pos.lat : '', lng: pos ? pos.lng : '',
        },
    };
    cbRenderSetup();
}

function cbRenderSetup() {
    const stage = document.getElementById('classroom-stage');
    const c = cbCount;
    if (!stage || !c) return;
    const s = c.setup;
    const k2 = c.room.grade_band === 'k-2';
    stage.innerHTML = `
      <div class="cb-wrap">
        <h2>🔭 Class bird count</h2>
        <p class="cb-lead">${k2
            ? 'We are going to be real bird scientists! We watch the feeder out of the window and count the birds we see with our own eyes.'
            : 'Watch the feeder through the window for a set time and count every bird you see with your own eyes. At the end your teacher can send the count to eBird, where scientists around the world use it.'}</p>
        <div class="cb-rule">👀 Count only what you SEE out of the window, not what the camera saw.
            <span>eBird does not accept sightings from feeder cameras, so this count is the class’s own.</span></div>
        <div class="cb-form">
            <label>How long <select id="cb-min">${[5, 10, 15, 20, 30].map(m =>
                `<option value="${m}"${m === s.minutes ? ' selected' : ''}>${m} minutes</option>`).join('')}</select></label>
            <label>How many people watching <input id="cb-obs" type="number" min="1" max="60" value="${esc(String(s.observers))}" placeholder="e.g. 24"></label>
            <label>Place name for eBird <input id="cb-loc" type="text" maxlength="60" value="${esc(s.location)}"></label>
            <label>State <select id="cb-state"><option value="">pick one</option>${CB_STATES.map(st =>
                `<option${st === s.state ? ' selected' : ''}>${st}</option>`).join('')}</select></label>
            <label>Latitude <input id="cb-lat" type="text" value="${esc(s.lat)}" placeholder="optional"></label>
            <label>Longitude <input id="cb-lng" type="text" value="${esc(s.lng)}" placeholder="optional"></label>
        </div>
        <p class="classroom-muted">Latitude and longitude come from the feeder when it reports them. eBird uses them to place the
            count on its map; leave them blank and eBird asks you to pick the spot when you upload.</p>
        <div class="cb-actions">
            <button class="classroom-btn-primary big" onclick="cbStart()">▶ Start counting</button>
            <button class="classroom-btn" onclick="cbClose()">Cancel</button>
        </div>
      </div>`;
}

function cbReadSetup() {
    const c = cbCount, v = id => (document.getElementById(id) || {}).value;
    if (!c || !document.getElementById('cb-min')) return;
    c.setup.minutes = Number(v('cb-min')) || 10;
    c.setup.observers = Math.max(1, Math.min(60, Number(v('cb-obs')) || 0)) || '';
    c.setup.location = String(v('cb-loc') || '').trim();
    c.setup.state = v('cb-state') || '';
    c.setup.lat = String(v('cb-lat') || '').trim();
    c.setup.lng = String(v('cb-lng') || '').trim();
    cbSavePrefs(c.room, { minutes: c.setup.minutes, observers: c.setup.observers,
                          location: c.setup.location, state: c.setup.state });
}

// ── Counting ─────────────────────────────────────────────

function cbStart() {
    const c = cbCount;
    if (!c) return;
    cbReadSetup();
    c.startedAt = new Date();
    c.endsAt = c.startedAt.getTime() + c.setup.minutes * 60000;
    clearInterval(c.timer);
    c.timer = setInterval(() => {
        const el = document.getElementById('cb-clock');
        const left = Math.max(0, Math.ceil((c.endsAt - Date.now()) / 1000));
        if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (left <= 0) { clearInterval(c.timer); c.timer = null; cbTimeUp(); }
    }, 500);
    cbRenderCount();
}

function cbRenderCount() {
    const stage = document.getElementById('classroom-stage');
    const c = cbCount;
    if (!stage || !c) return;
    const left = Math.max(0, Math.ceil((c.endsAt - Date.now()) / 1000));
    const done = !c.timer;
    const k2 = c.room.grade_band === 'k-2';
    stage.innerHTML = `
      <div class="cb-wrap">
        <div class="cb-top">
            <h2>🔭 ${done ? 'Time’s up!' : 'Counting'}</h2>
            <span class="cb-clock" id="cb-clock">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span>
        </div>
        <p class="cb-lead">${k2
            ? 'How many can you see AT THE SAME TIME? Tap + when you see more of that bird at once.'
            : 'Each number is the MOST of that bird seen at the same moment, not every visit: eight trips to the feeder might be the same three birds.'}</p>
        <div class="cb-tiles">
            ${c.birds.map((b, i) => `
            <div class="cb-tile${b.n ? ' on' : ''}">
                ${b.photo && !(typeof isPrivateMedia === 'function' && isPrivateMedia(b.photo))
                    ? `<div class="ck-photo cb-photo"><img src="${esc(b.photo)}" alt="" onerror="this.parentNode.remove()"></div>` : ''}
                <div class="cb-name">${esc(b.name)}</div>
                <div class="cb-ctl">
                    <button class="classroom-btn" onclick="cbBump(${i}, -1)" aria-label="One fewer ${esc(b.name)}">−</button>
                    <span class="cb-n">${b.n}</span>
                    <button class="classroom-btn-primary" onclick="cbBump(${i}, 1)" aria-label="One more ${esc(b.name)}">+</button>
                </div>
            </div>`).join('')}
            <div class="cb-tile cb-add">
                <div class="cb-name">Another bird?</div>
                <input id="cb-new" type="text" maxlength="50" placeholder="Its name" onkeydown="if (event.key === 'Enter') cbAdd()">
                <button class="classroom-btn" onclick="cbAdd()">Add</button>
            </div>
        </div>
        <div class="cb-actions">
            ${done ? '' : '<button class="classroom-btn" onclick="cbTimeUp()">Stop early</button>'}
            <button class="classroom-btn-primary big" onclick="cbFinish()"${done ? '' : ' disabled title="When the time is up"'}>Finish →</button>
            <button class="classroom-btn" onclick="cbClose()">Cancel</button>
        </div>
      </div>`;
}

function cbBump(i, d) {
    const b = cbCount && cbCount.birds[i];
    if (!b) return;
    b.n = Math.max(0, Math.min(999, b.n + d));
    cbRenderCount();
}

function cbAdd() {
    const el = document.getElementById('cb-new');
    const name = String((el && el.value) || '').replace(/[",\r\n]+/g, ' ').trim();
    if (!name || !cbCount) return;
    if (!cbCount.birds.some(b => b.name.toLowerCase() === name.toLowerCase())) cbCount.birds.push({ name, photo: null, n: 1 });
    cbRenderCount();
}

function cbTimeUp() {
    const c = cbCount;
    if (!c) return;
    clearInterval(c.timer); c.timer = null;
    // A count stopped early is the time actually watched.
    c.endsAt = Math.min(c.endsAt, Date.now());
    cbRenderCount();
}

// ── The result, and the file ─────────────────────────────

function cbFinish() {
    const stage = document.getElementById('classroom-stage');
    const c = cbCount;
    if (!stage || !c) return;
    const seen = c.birds.filter(b => b.n > 0);
    const minutes = Math.max(1, Math.round((c.endsAt - c.startedAt.getTime()) / 60000));
    c.minutesWatched = minutes;
    const total = seen.reduce((a, b) => a + b.n, 0);
    const missing = [!c.setup.state && 'a state', !c.setup.observers && 'how many people watched']
        .filter(Boolean);
    stage.innerHTML = `
      <div class="cb-wrap">
        <h2>🔭 Our count</h2>
        <p class="cb-lead">${seen.length
            ? `In ${minutes} minute${minutes === 1 ? '' : 's'} the class counted <strong>${total}</strong> bird${total === 1 ? '' : 's'} of <strong>${seen.length}</strong> kind${seen.length === 1 ? '' : 's'}.`
            : 'No birds this time. That is a real result too, and eBird wants it: a count of zero tells scientists something.'}</p>
        ${seen.length ? `<table class="ck-jtable cb-table"><tbody>${seen.map(b =>
            `<tr><th>${esc(b.name)}</th><td>${b.n}</td></tr>`).join('')}</tbody></table>` : ''}
        <label class="cb-all"><input type="checkbox" id="cb-all" checked>
            We reported every kind of bird we could identify (eBird calls this a complete checklist)</label>
        ${missing.length ? `<p class="classroom-warn">Before eBird will take it, add ${missing.join(' and ')}:
            <button class="classroom-btn" onclick="cbRenderSetupAfter()">Fix</button></p>` : ''}
        <div class="cb-actions">
            <button class="classroom-btn-primary big" onclick="cbDownload()"${seen.length && !missing.length ? '' : ' disabled'}>⬇ Download the eBird file</button>
            <button class="classroom-btn" onclick="cbClose()">Done</button>
        </div>
        <details class="cb-how"><summary>How to send it to eBird</summary>
            <ol>
                <li>Sign in at <strong>ebird.org</strong> with the school’s or your own eBird account.</li>
                <li>Go to <strong>Submit</strong>, then <strong>Import data</strong>.</li>
                <li>Choose the format <strong>eBird Record Format (Extended)</strong> and upload the file.</li>
                <li>eBird checks the place and the bird names. Confirm them, and the count becomes a checklist.</li>
            </ol>
            <p class="classroom-muted">The file follows eBird’s import rules: no header row, the 19 columns in eBird’s order,
               Stationary protocol, and the minutes you actually watched.</p>
        </details>
      </div>`;
}

/** Back to the setup form after the count, keeping the counts. */
function cbRenderSetupAfter() {
    const c = cbCount;
    if (!c) return;
    const stage = document.getElementById('classroom-stage');
    cbRenderSetup();
    const act = stage.querySelector('.cb-actions');
    if (act) act.innerHTML = '<button class="classroom-btn-primary big" onclick="cbReadSetup(); cbFinish()">Save and go back</button>';
}

/** eBird forbids quotation marks and line breaks; commas would split a column. */
function cbField(v) {
    return String(v == null ? '' : v).replace(/["\r\n]+/g, ' ').replace(/,/g, ';').replace(/\s+/g, ' ').trim();
}

/** The rows, exactly as eBird's Record Format wants them. Exported for the tests. */
function cbRecordRows(c) {
    const d = c.startedAt;
    const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const all = c.allReported === false ? 'N' : 'Y';
    const comments = `Class bird count by ${c.room.name}`
        + `${c.school ? ' at ' + c.school : ''}: counted in person through a window at the school bird feeder. `
        + 'Numbers are the most of each species seen at one time. Submitted with BirdWatchAI Classroom.';
    return c.birds.filter(b => b.n > 0).map(b => [
        b.name, '', '', b.n, '',
        c.setup.location, c.setup.lat, c.setup.lng, date, time,
        c.setup.state, 'US', 'Stationary', c.setup.observers, c.minutesWatched,
        all, '', '', comments,
    ].map(cbField));
}

function cbDownload() {
    const c = cbCount;
    if (!c) return;
    c.allReported = !!(document.getElementById('cb-all') || {}).checked;
    c.school = typeof cmHistoryCommunityName === 'function' ? cmHistoryCommunityName() : '';
    const rows = cbRecordRows(c);
    if (!rows.length) return;
    const csv = rows.map(r => r.join(',')).join('\r\n') + '\r\n';
    const d = c.startedAt;
    const name = `${cbField(c.room.name).replace(/[\\/:*?<>|;]+/g, ' ')} bird count ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Downloaded. Upload it at ebird.org under Submit, then Import data.');
}

function cbClose() {
    if (cbCount) { clearInterval(cbCount.timer); cbCount = null; }
    const stage = document.getElementById('classroom-stage');
    if (stage) { stage.style.display = 'none'; stage.innerHTML = ''; }
}
