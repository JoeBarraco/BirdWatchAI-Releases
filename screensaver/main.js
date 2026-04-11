// BirdWatchAI Screensaver — Electron main process
// Handles Windows screensaver protocols: /s (run), /c (configure), /p (preview)
// Spawns one fullscreen window per monitor for multi-display support.

const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require('electron');
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

    // Track initial mouse position to detect intentional movement
    const initialMouse = screen.getCursorScreenPoint();
    const MOUSE_THRESHOLD = 10; // px — ignore jitter

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

        // Send settings once the page is ready
        win.webContents.on('did-finish-load', () => {
            win.webContents.send('init-settings', settings);
        });

        win.once('ready-to-show', () => {
            win.show();
            win.setFullScreen(true);
        });

        // Any keyboard input exits the screensaver
        win.webContents.on('before-input-event', () => {
            quitAll();
        });

        windows.push(win);
    }

    // Poll mouse position — exit if it moves beyond threshold
    const mousePoller = setInterval(() => {
        const pos = screen.getCursorScreenPoint();
        const dx = Math.abs(pos.x - initialMouse.x);
        const dy = Math.abs(pos.y - initialMouse.y);
        if (dx > MOUSE_THRESHOLD || dy > MOUSE_THRESHOLD) {
            quitAll();
        }
    }, 200);

    function quitAll() {
        clearInterval(mousePoller);
        for (const w of windows) {
            if (!w.isDestroyed()) w.close();
        }
        app.quit();
    }

    // Also listen for mouse clicks relayed from the renderer
    ipcMain.on('user-activity', () => quitAll());
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
// Windows passes /p:<hwnd> to embed in the tiny Settings preview.
// Full native embedding requires Win32 SetParent — for now we open
// a small standalone preview window.
function launchPreview() {
    const settings = loadSettings();

    const win = new BrowserWindow({
        width: 320,
        height: 240,
        frame: false,
        resizable: false,
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile('slideshow.html');
    win.webContents.on('did-finish-load', () => {
        win.webContents.send('init-settings', { ...settings, showCaption: false, showProgress: false });
    });

    // Close on any input
    win.webContents.on('before-input-event', () => {
        win.close();
        app.quit();
    });

    win.on('closed', () => app.quit());
}

// ── App lifecycle ──────────────────────────────────────────
// Prevent multiple instances (Windows can try to launch multiple)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
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
}

app.on('window-all-closed', () => app.quit());
