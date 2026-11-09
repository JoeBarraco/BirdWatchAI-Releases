// BirdWatchAI Community Feed — Electron main process
// Handles Windows screensaver protocols: /s (run), /c (configure), /p (preview)
// Spawns one fullscreen window per monitor for multi-display support.
//
// The feed itself lives in the main process (lib/feed.js). Renderers used to
// fetch for themselves, which meant a three-monitor setup made three of every
// request; now one fetch is broadcast to every window, and the access token
// and the image cache have exactly one home.

const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

const auth    = require('./lib/auth');
const feed    = require('./lib/feed');
const cache   = require('./lib/imagecache');
const updates = require('./lib/update');
const winpreview = require('./lib/winpreview');

const APP_VERSION = require('./package.json').version;

// ── Parse screensaver command-line args ────────────────────
// Windows passes: /s (show), /c:<hwnd> (configure), /p:<hwnd> (preview)
// The :HWND suffix is a parent window handle — we match with startsWith.
// We also accept bare flags for development: --screensaver, --config, --preview
// Returns { mode, hwnd }. Windows writes the preview host handle either as
// /p:1234 or as /p 1234 depending on the shell path taken, so both are read.
function parseMode() {
    const args = process.argv.slice(1).map(a => a.toLowerCase());
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('/s') || arg === '--screensaver') return { mode: 'screensaver' };
        if (arg.startsWith('/c') || arg === '--config')      return { mode: 'config' };
        // --preview is the development flag and opens a real window. Windows'
        // own /p:<hwnd> is a different thing entirely — see launchPreview().
        if (arg === '--preview') return { mode: 'dev-preview' };
        if (arg.startsWith('/p')) {
            const inline = arg.slice(2).replace(/^[:=]/, '');
            const raw = inline || args[i + 1] || '';
            const hwnd = /^\d+$/.test(raw) ? BigInt(raw) : null;
            return { mode: 'preview', hwnd };
        }
    }
    // Default to config mode when launched without args (matches Windows convention
    // for double-clicking a .scr file)
    return { mode: 'config' };
}

// ── Settings persistence ───────────────────────────────────
let SETTINGS_PATH = null;

const DEFAULT_SETTINGS = {
    transition: 'random',   // fade | slide | kenburns | blur | random
    interval:   6000,       // ms per photo
    sortMode:   'random',   // random | recent | count | alpha
    photoAge:   'all',      // all | today | week | month | year
    feeders:    [],         // [] = all feeders; otherwise array of feeder display names
    showCaption: true,
    showProgress: true,
    cacheMB:     512,       // on-disk photo cache budget
    refreshMinutes: 5,      // how often to look for new detections
    showClock:   true,      // clock corner (lower right)
    playClips:   true,      // mix video clips in with the stills
    clipEvery:   5,         // play a clip after every N photos (0 = never)
    clipSeconds: 12,        // give up on a clip after this long
    checkUpdates: true,     // look for a newer release once a day
};

function loadSettings() {
    try {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ── IPC handlers ───────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, settings) => {
    saveSettings(settings);
    cache.setBudget(settings.cacheMB);
    return true;
});

// Account. Signing in is what makes private-community feeders visible: the
// same queries, carrying the member's JWT, pass RLS for every feeder they
// belong to.
ipcMain.handle('auth-status',  () => auth.status());
ipcMain.handle('auth-request', async (_e, email) => {
    await auth.requestCode(email);
    return true;
});
ipcMain.handle('auth-verify',  (_e, email, code) => auth.verify(email, code));
ipcMain.handle('auth-signout', async () => {
    const res = await auth.signOut();
    // Private photos were cached to disk while signed in. On a shared machine,
    // leaving them readable after sign-out is exactly what private communities
    // exist to prevent.
    await cache.clear();
    return res;
});

// Feeders that currently have photos, as this account sees them.
ipcMain.handle('list-feeders', async () => {
    const { SUPABASE_URL } = require('./lib/supabase');
    const url = `${SUPABASE_URL}/rest/v1/community_detections` +
        `?select=feeders(display_name)&image_url=not.is.null` +
        `&order=detected_at.desc&limit=2000`;
    const res = await fetch(url, { headers: await auth.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    return [...new Set(rows.map(r => r.feeders && r.feeders.display_name).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
});

ipcMain.handle('cache-stats', () => cache.stats());
ipcMain.handle('cache-clear', () => cache.clear());

ipcMain.handle('check-update', (_e, force) => updates.check(force));
ipcMain.handle('app-version', () => APP_VERSION);

// Only ever used for the releases page. Anything else arriving here would be a
// renderer handing the OS a URL of its choosing, so the scheme is checked.
ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
});

// ── Screensaver mode ───────────────────────────────────────
function launchScreensaver() {
    const displays = screen.getAllDisplays();
    const settings = loadSettings();
    const windows  = [];
    let   armed    = false; // Don't react to input until the grace period ends
    let   refreshTimer = null;

    // webContents.send before a window has finished loading goes nowhere, and
    // the first feed load races window startup. Track which windows are ready
    // and hand a late-loading one the result it missed.
    const ready = new WeakSet();
    let latestResult = null;

    for (const display of displays) {
        const win = new BrowserWindow({
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
            fullscreen: true,
            frame: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            backgroundColor: '#000000',
            show: false,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
        });

        win.loadFile('slideshow.html');

        // Stagger each monitor with a random delay (0–40% of the interval)
        // so transitions don't fire in lockstep across displays.
        const staggerDelay = displays.length > 1
            ? Math.floor(Math.random() * settings.interval * 0.4)
            : 0;

        win.webContents.on('did-finish-load', () => {
            win.webContents.send('init-settings', { ...settings, staggerDelay });
            ready.add(win);
            if (latestResult) win.webContents.send('feed-update', latestResult);
        });

        win.once('ready-to-show', () => {
            win.show();
            win.setFullScreen(true);
        });

        // Keyboard input exits the screensaver (only after grace period)
        win.webContents.on('before-input-event', () => {
            if (armed) quitAll();
        });

        windows.push(win);
    }

    // One fetch for every monitor. Each window shuffles its own copy, so they
    // still show different photos at any given moment.
    function broadcast(result) {
        latestResult = result;
        for (const w of windows) {
            if (!w.isDestroyed() && ready.has(w)) {
                w.webContents.send('feed-update', result);
            }
        }
    }

    async function refreshFeed(initial) {
        try {
            const result = await feed.load(loadSettings());
            result.initial = !!initial;
            broadcast(result);
            // Warm the cache behind the slideshow so the next launch — or the
            // next time the network is down — has these photos on disk.
            feed.warmCache(result.photos, 120).catch(() => {});
        } catch (err) {
            console.error('[feed] load failed:', err.message);
        }
    }

    refreshFeed(true);
    const everyMs = Math.max(1, settings.refreshMinutes || 5) * 60 * 1000;
    refreshTimer = setInterval(() => refreshFeed(false), everyMs);

    // A screensaver's settings dialog is rarely opened, so the only place an
    // update notice will actually be seen is on the slideshow itself.
    if (settings.checkUpdates !== false) {
        updates.check().then(info => {
            if (!info.available) return;
            for (const w of windows) {
                if (!w.isDestroyed() && ready.has(w)) {
                    w.webContents.send('update-info', info);
                }
            }
        }).catch(() => {});
    }

    // Grace period: ignore all input for the first 2 seconds while windows
    // are being created and fullscreened. Mouse jitter and OS-generated
    // events during this phase would otherwise exit immediately.
    setTimeout(() => {
        armed = true;
        // Capture mouse position AFTER windows are up, not before
        const initialMouse = screen.getCursorScreenPoint();
        const MOUSE_THRESHOLD = 15; // px — ignore jitter

        const mousePoller = setInterval(() => {
            if (!armed) return;
            const pos = screen.getCursorScreenPoint();
            const dx = Math.abs(pos.x - initialMouse.x);
            const dy = Math.abs(pos.y - initialMouse.y);
            if (dx > MOUSE_THRESHOLD || dy > MOUSE_THRESHOLD) {
                clearInterval(mousePoller);
                quitAll();
            }
        }, 200);
    }, 2000);

    function quitAll() {
        armed = false;
        clearInterval(refreshTimer);
        for (const w of windows) {
            if (!w.isDestroyed()) w.close();
        }
        app.quit();
    }

    // Also listen for mouse clicks relayed from the renderer
    ipcMain.on('user-activity', () => {
        if (armed) quitAll();
    });
}

// ── Configuration mode ─────────────────────────────────────
function launchConfig() {
    const win = new BrowserWindow({
        width: 520,
        height: 820,
        resizable: true,
        frame: true,
        title: 'BirdWatchAI Community Feed Settings',
        backgroundColor: '#1a1a2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.setMenuBarVisibility(false);
    win.loadFile('config.html');

    win.on('closed', () => app.quit());
}

// ── Preview mode ───────────────────────────────────────────
// Windows passes /p:<hwnd> to embed a preview in the tiny monitor
// graphic in the Screen Saver Settings dialog. True embedding requires
// Win32 SetParent which isn't available in Electron. We simply exit
// cleanly so we don't open a confusing standalone window.
function launchPreview(parentHwnd) {
    if (parentHwnd === null || parentHwnd === undefined || !winpreview.available()) {
        app.quit();
        return;
    }

    const size = winpreview.clientSize(parentHwnd);
    if (!size) { app.quit(); return; }

    const settings = loadSettings();

    const win = new BrowserWindow({
        width: size.width,
        height: size.height,
        frame: false,
        show: false,
        resizable: false,
        skipTaskbar: true,
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile('slideshow.html');

    win.webContents.on('did-finish-load', async () => {
        // The host thumbnail is around 150×110. Captions, the progress bar and
        // the clock are illegible at that size, and clips would have the
        // settings dialog decoding video for as long as it is open.
        win.webContents.send('init-settings', {
            ...settings,
            compact: true,
            showCaption: false,
            showProgress: false,
            showClock: false,
            playClips: false,
            interval: Math.max(settings.interval || 6000, 4000),
        });

        try {
            const result = await feed.load({ ...settings, playClips: false });
            win.webContents.send('feed-update', { ...result, initial: true });
        } catch { /* the preview simply stays black */ }
    });

    win.once('ready-to-show', () => {
        const handle = win.getNativeWindowHandle();
        if (!winpreview.embed(handle, parentHwnd, size)) {
            // Reparenting failed. Showing the window now would drop a black
            // rectangle on top of the settings dialog, so bow out instead.
            app.quit();
            return;
        }
        win.showInactive();
    });

    // The dialog never says "stop" — it just destroys the host window.
    winpreview.watchParent(parentHwnd, () => app.quit());
}

// ── Developer preview ──────────────────────────────────────
// The real slideshow in an ordinary window, so a change can be checked without
// blacking out every monitor and quitting on the first mouse twitch. Reachable
// only via `npm run start:preview`; Windows never passes this flag.
function launchDevPreview() {
    const settings = loadSettings();

    const win = new BrowserWindow({
        width: 1100,
        height: 700,
        title: 'BirdWatchAI Community Feed — Preview',
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.setMenuBarVisibility(false);
    win.loadFile('slideshow.html');

    // Surface renderer logs on the terminal — the whole point of this mode is
    // watching what the slideshow does.
    win.webContents.on('console-message', (_e, _level, message) => {
        console.log(`[renderer] ${message}`);
    });

    win.webContents.on('did-finish-load', async () => {
        win.webContents.send('init-settings', settings);
        const result = await feed.load(settings);
        console.log(`[preview] ${result.photos.length} photos` +
            (result.fallback ? ` (fell back to ${result.fallback.label})` : '') +
            (result.offline ? ' [offline — from cache]' : ''));
        win.webContents.send('feed-update', { ...result, initial: true });
        feed.warmCache(result.photos, 40).catch(() => {});
    });

    win.on('closed', () => app.quit());
}

// ── App lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
    const userData = app.getPath('userData');
    SETTINGS_PATH = path.join(userData, 'screensaver-settings.json');

    const settings = loadSettings();
    auth.init(userData);
    feed.init(userData);
    cache.init(userData, settings.cacheMB);
    updates.init(userData, APP_VERSION);

    const { mode, hwnd } = parseMode();

    switch (mode) {
        case 'config':
            launchConfig();
            break;
        case 'preview':
            launchPreview(hwnd);
            break;
        case 'dev-preview':
            launchDevPreview();
            break;
        case 'screensaver':
        default:
            launchScreensaver();
            break;
    }
});

app.on('window-all-closed', () => app.quit());
