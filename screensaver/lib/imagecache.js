// BirdWatchAI Community Feed — on-disk image cache
//
// Before this, every slide set img.src to a Supabase Storage URL, so the same
// photos were re-fetched on every launch, and once per monitor. Chromium's own
// HTTP cache absorbed some of that, but nothing survived deliberately and a
// screensaver on a flaky connection just showed black.
//
// Photos are downloaded once into userData/image-cache and served to the
// renderer as file:// URLs. The cache is keyed on the *stable* identity of the
// photo, not on the URL actually fetched — private media is reached through a
// signed URL whose token changes every couple of hours, so keying on that would
// re-download the same bird every refresh and never hit.
//
// Eviction is least-recently-used against a byte budget.

const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

let CACHE_DIR = null;
let maxBytes  = 512 * 1024 * 1024;   // 512 MB default
const inflight = new Map();          // key -> Promise<string|null>

function init(userDataDir, budgetMB) {
    CACHE_DIR = path.join(userDataDir, 'image-cache');
    if (budgetMB) maxBytes = budgetMB * 1024 * 1024;
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* best effort */ }
}

function setBudget(budgetMB) {
    if (budgetMB) maxBytes = budgetMB * 1024 * 1024;
}

// Guess an extension so the cached files stay recognisable on disk. The
// extension is cosmetic — nothing reads it back.
function extFor(key) {
    const m = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(key || '');
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

function fileFor(key) {
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(CACHE_DIR, hash + extFor(key));
}

// Mark a cached file as freshly used so LRU eviction keeps it around.
function touch(file) {
    const now = new Date();
    fsp.utimes(file, now, now).catch(() => {});
}

// Local file:// URL for a photo, downloading it first if we do not have it.
// `key` identifies the photo across signed-URL rotations; `remoteUrl` is what
// to actually fetch. Returns null if it could not be cached, and the caller
// falls back to the remote URL.
async function fetchLocalUrl(key, remoteUrl, headers) {
    if (!CACHE_DIR || !key || !remoteUrl) return null;

    const file = fileFor(key);

    try {
        const st = await fsp.stat(file);
        if (st.size > 0) {
            touch(file);
            return pathToFileURL(file).href;
        }
    } catch { /* not cached yet */ }

    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
        const tmp = `${file}.${process.pid}.part`;
        try {
            const res = await fetch(remoteUrl, { headers: headers || {} });
            if (!res.ok) return null;
            const buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length) return null;
            await fsp.writeFile(tmp, buf);
            await fsp.rename(tmp, file);
            return pathToFileURL(file).href;
        } catch {
            await fsp.rm(tmp, { force: true }).catch(() => {});
            return null;
        } finally {
            inflight.delete(key);
        }
    })();

    inflight.set(key, job);
    return job;
}

// Is this photo already on disk? Lets the renderer start instantly on cached
// photos instead of waiting for a network round trip.
function cachedUrl(key) {
    if (!CACHE_DIR || !key) return null;
    const file = fileFor(key);
    try {
        if (fs.statSync(file).size > 0) {
            touch(file);
            return pathToFileURL(file).href;
        }
    } catch { /* not cached */ }
    return null;
}

// ── Housekeeping ───────────────────────────────────────────

async function stats() {
    if (!CACHE_DIR) return { files: 0, bytes: 0 };
    try {
        const names = await fsp.readdir(CACHE_DIR);
        let bytes = 0, files = 0;
        for (const n of names) {
            try {
                const st = await fsp.stat(path.join(CACHE_DIR, n));
                if (st.isFile()) { bytes += st.size; files++; }
            } catch { /* vanished mid-scan */ }
        }
        return { files, bytes };
    } catch {
        return { files: 0, bytes: 0 };
    }
}

// Drop the least recently used files until the cache fits its budget.
async function prune() {
    if (!CACHE_DIR) return;
    try {
        const names = await fsp.readdir(CACHE_DIR);
        const entries = [];
        let total = 0;
        for (const n of names) {
            const p = path.join(CACHE_DIR, n);
            try {
                const st = await fsp.stat(p);
                if (!st.isFile()) continue;
                entries.push({ p, size: st.size, used: st.mtimeMs });
                total += st.size;
            } catch { /* vanished mid-scan */ }
        }
        if (total <= maxBytes) return;

        entries.sort((a, b) => a.used - b.used);   // oldest first
        for (const e of entries) {
            if (total <= maxBytes) break;
            try {
                await fsp.rm(e.p, { force: true });
                total -= e.size;
            } catch { /* keep going */ }
        }
    } catch { /* cache directory unreadable; nothing to prune */ }
}

async function clear() {
    if (!CACHE_DIR) return;
    try {
        await fsp.rm(CACHE_DIR, { recursive: true, force: true });
        await fsp.mkdir(CACHE_DIR, { recursive: true });
    } catch { /* best effort */ }
}

module.exports = { init, setBudget, fetchLocalUrl, cachedUrl, stats, prune, clear };
