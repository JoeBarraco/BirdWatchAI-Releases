// BirdWatchAI Screensaver — Electron main process
// Handles Windows screensaver protocols: /s (run), /c (configure), /p (preview)
// Spawns one fullscreen window per monitor for multi-display support.

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Parse screensaver command-line args ────────────────────
// Windows passes: /s (show), /c:<hwnd> (configure), /p:<hwnd> (preview)
// The :HWND suffix is a parent window handle — we match with startsWith.
// We also accept bare flags for development: --screensaver, --config, --preview
function parseMode() {
    const args = process.argv.slice(1).map(a => a.toLowerCase());
    for (const arg of args) {
        if (arg.startsWith('/s') || arg === '--screensaver') return 'screensaver';
        if (arg.startsWith('/c') || arg === '--config')      return 'config';
        if (arg.startsWith('/p') || arg === '--preview')     return 'preview';
    }
    // Default to config mode when launched without args (matches Windows convention
    // for double-clicking a .scr file)
    return 'config';
}

// ── Settings persistence ───────────────────────────────────
const SETTINGS_PATH = path.join(app.getPath('userData'), 'screensaver-settings.json');

const DEFAULT_SETTINGS = {
    transition: 'random',   // fade | slide | kenburns | blur | random
    interval:   6000,       // ms per photo
    sortMode:   'random',   // random | recent | count | alpha
    showCaption: true,
    showProgress: true,
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
    return true;
});

// ── Screensaver mode ───────────────────────────────────────
function launchScreensaver() {
    const displays = screen.getAllDisplays();
    const settings = loadSettings();
    const windows  = [];
    let   armed    = false; // Don't react to input until the grace period ends

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
        width: 480,
        height: 520,
        resizable: false,
        frame: true,
        title: 'BirdWatchAI Screensaver Settings',
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
function launchPreview() {
    app.quit();
}

// ── App lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
    const mode = parseMode();

    switch (mode) {
        case 'config':
            launchConfig();
            break;
        case 'preview':
            launchPreview();
            break;
        case 'screensaver':
        default:
            launchScreensaver();
            break;
    }
});

app.on('window-all-closed', () => app.quit());
