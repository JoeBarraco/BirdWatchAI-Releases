// BirdWatchAI Community Feed — update check
//
// The published build went stale for seven months without anything surfacing
// it, which is the problem this closes. The screensaver asks GitHub for the
// newest *-screensaver release and, when that is newer than the running build,
// says so quietly on screen and offers a download link in Settings.
//
// The GitHub API allows 60 unauthenticated requests an hour per IP, and a
// screensaver can start many times a day, so the answer is cached on disk and
// only re-checked once a day.

const fs   = require('fs');
const path = require('path');

const RELEASES_URL = 'https://api.github.com/repos/JoeBarraco/BirdWatchAI-Releases/releases?per_page=30';
const RELEASES_PAGE = 'https://github.com/JoeBarraco/BirdWatchAI-Releases/releases/latest';
const TAG_SUFFIX   = '-screensaver';
const CHECK_EVERY  = 24 * 60 * 60 * 1000;

let CACHE_PATH = null;
let currentVersion = '0.0.0';

function init(userDataDir, version) {
    CACHE_PATH = path.join(userDataDir, 'update-check.json');
    if (version) currentVersion = version;
}

// "v1.2.0-screensaver" -> [1, 2, 0]. Returns null for anything else, which is
// how non-screensaver releases in this repo (the server app, the Finder) are
// filtered out — they share the repo but not the version line.
function parseTag(tag) {
    if (typeof tag !== 'string' || !tag.endsWith(TAG_SUFFIX)) return null;
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag.slice(0, -TAG_SUFFIX.length));
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function isNewer(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
    }
    return false;
}

function readCache() {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        if (c && typeof c.checkedAt === 'number') return c;
    } catch { /* never checked */ }
    return null;
}

function writeCache(c) {
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); }
    catch { /* the cache is an optimisation */ }
}

// { available, version, url, current }. Never throws — an update check is the
// least important thing the screensaver does, and a rate-limited or offline
// GitHub must not stop the slideshow.
async function check(force) {
    const cached = readCache();
    if (!force && cached && Date.now() - cached.checkedAt < CHECK_EVERY) {
        return { ...cached.result, current: currentVersion };
    }

    const none = { available: false, version: null, url: RELEASES_PAGE };

    try {
        const res = await fetch(RELEASES_URL, {
            headers: {
                Accept: 'application/vnd.github+json',
                // GitHub asks API clients to identify themselves. This names
                // the app, not the person running it.
                'User-Agent': 'BirdWatchAI-Community-Feed',
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const releases = await res.json();
        if (!Array.isArray(releases)) throw new Error('unexpected response');

        let best = null;
        for (const r of releases) {
            if (r.draft) continue;
            const v = parseTag(r.tag_name);
            if (!v) continue;
            if (!best || isNewer(v, best.v)) {
                best = { v, tag: r.tag_name, url: r.html_url };
            }
        }

        const result = best && isNewer(best.v, parseVersion(currentVersion))
            ? { available: true, version: best.v.join('.'), url: best.url }
            : none;

        writeCache({ checkedAt: Date.now(), result });
        return { ...result, current: currentVersion };

    } catch {
        // Keep whatever we last knew rather than claiming "up to date" on a
        // failed check, but do not keep retrying on every launch either.
        writeCache({ checkedAt: Date.now(), result: cached ? cached.result : none });
        return { ...(cached ? cached.result : none), current: currentVersion };
    }
}

module.exports = { init, check, parseTag, isNewer, parseVersion, RELEASES_PAGE };
