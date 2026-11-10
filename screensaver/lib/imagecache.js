// BirdWatchAI Community Feed — on-disk media cache
//
// Before this, every slide set img.src to a Supabase Storage URL, so the same
// photos were re-fetched on every launch, and once per monitor. Chromium's own
// HTTP cache absorbed some of that, but nothing survived deliberately and a
// screensaver on a flaky connection just showed black.
//
// Media is downloaded once into userData and served to the renderer as file://
// URLs. The cache is keyed on the *stable* identity of the item, not on the URL
// actually fetched — private media is reached through a signed URL whose token
// changes every couple of hours, so keying on that would re-download the same
// bird every refresh and never hit.
//
// Eviction is least-recently-used against a byte budget.
//
// Stills and clips get SEPARATE caches with separate budgets, which is the
// whole reason this file grew a factory. They used to share one 512 MB LRU,
// and that is why clips were streamed rather than cached: a few seconds of
// 1080p dwarfs a still, so a dozen clips would evict every photo on the next
// prune. Two budgets means a clip can never cost a photo its place, and a
// ~1.75 MB clip replayed all night is downloaded once instead of ~50 times
// an hour.

const fs     = require('fs');
const fsp    = require('fs/promises');
const path   = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// Guess an extension so the cached files stay recognisable on disk. The
// extension is cosmetic — nothing reads it back.
function imageExt(key) {
    const m = /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.exec(key || '');
    return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

function clipExt(key) {
    const m = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.exec(key || '');
    return m ? `.${m[1].toLowerCase()}` : '.mp4';
}

// One cache: a directory, a byte budget, and an LRU prune. `subdir` is created
// under userData; `extFor` only decides how the file is named on disk.
function createCache(subdir, defaultBudgetMB, extFor) {
    let CACHE_DIR = null;
    let maxBytes  = defaultBudgetMB * 1024 * 1024;
    let disabled  = false;
    const inflight = new Map();          // key -> Promise<string|null>

    // A budget of 0 means "do not cache this at all" — the clip cache can be
    // switched off from Settings. It is distinct from "no budget given", which
    // means "keep the default", so the falsy guard alone will not do.
    function applyBudget(budgetMB) {
        if (budgetMB === 0) { disabled = true; return; }
        if (budgetMB) { disabled = false; maxBytes = budgetMB * 1024 * 1024; }
    }

    function init(userDataDir, budgetMB) {
        CACHE_DIR = path.join(userDataDir, subdir);
        applyBudget(budgetMB);
        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* best effort */ }
    }

    function setBudget(budgetMB) {
        applyBudget(budgetMB);
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

    // Local file:// URL for an item, downloading it first if we do not have it.
    // `key` identifies it across signed-URL rotations; `remoteUrl` is what to
    // actually fetch. Returns null if it could not be cached, and the caller
    // falls back to the remote URL.
    async function fetchLocalUrl(key, remoteUrl, headers) {
        if (disabled || !CACHE_DIR || !key || !remoteUrl) return null;

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

    // Is this item already on disk? Lets the renderer start instantly on
    // cached media instead of waiting for a network round trip.
    function cachedUrl(key) {
        if (disabled || !CACHE_DIR || !key) return null;
        const file = fileFor(key);
        try {
            if (fs.statSync(file).size > 0) {
                touch(file);
                return pathToFileURL(file).href;
            }
        } catch { /* not cached */ }
        return null;
    }

    // ── Housekeeping ───────────────────────────────────────

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
        if (disabled) { await clear(); return; }
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

    return { init, setBudget, fetchLocalUrl, cachedUrl, stats, prune, clear };
}

// Stills keep the directory they have always used, so an upgrade inherits
// every photo already on disk rather than starting cold.
const images = createCache('image-cache', 512, imageExt);
const clips  = createCache('clip-cache', 2048, clipExt);

// The stills API stays at the top level: `cache.cachedUrl(key)` still means
// "is this photo on disk", which is what every existing call site asks.
module.exports = {
    init(userDataDir, imageBudgetMB, clipBudgetMB) {
        images.init(userDataDir, imageBudgetMB);
        clips.init(userDataDir, clipBudgetMB);
    },
    setBudget(imageBudgetMB, clipBudgetMB) {
        images.setBudget(imageBudgetMB);
        clips.setBudget(clipBudgetMB);
    },

    fetchLocalUrl: images.fetchLocalUrl,
    cachedUrl:     images.cachedUrl,
    prune:         images.prune,

    // Combined figures for the settings dialog, with the split available for
    // anything that wants to report the two budgets separately.
    async stats() {
        const [photos, video] = await Promise.all([images.stats(), clips.stats()]);
        return {
            files: photos.files + video.files,
            bytes: photos.bytes + video.bytes,
            photos,
            clips: video,
        };
    },

    async clear() {
        await images.clear();
        await clips.clear();
    },

    // The clip cache in full, for the handful of places that care.
    clips,
    images,
};
