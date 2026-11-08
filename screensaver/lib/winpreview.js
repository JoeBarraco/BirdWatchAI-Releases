// BirdWatchAI Community Feed — Windows preview-pane embedding
//
// Screen Saver Settings draws a little monitor graphic and runs the screensaver
// with /p:<hwnd>, expecting it to render *inside* that window. Doing so means
// making our window a Win32 child of a HWND we did not create: SetParent, then
// swapping WS_POPUP for WS_CHILD so it clips and moves with the host.
//
// Electron has no API for this — setParentWindow() only accepts another
// BrowserWindow — so it goes through koffi to user32. That is also why this is
// wrapped in so much defensiveness: if the FFI layer is unavailable or any call
// fails, the caller falls back to exiting cleanly, which is what the app did
// before. A dead preview thumbnail is a cosmetic disappointment; a stray
// fullscreen window over the settings dialog is a bug.

const WS_CHILD   = 0x40000000;
const WS_POPUP   = 0x80000000;
const WS_VISIBLE = 0x10000000;
const GWL_STYLE  = -16;

let api = null;

// Bind user32 once. Returns null when koffi is missing or the bindings fail.
function load() {
    if (api !== null) return api;
    try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');

        const RECT = koffi.struct('RECT', {
            left: 'long', top: 'long', right: 'long', bottom: 'long',
        });

        api = {
            RECT,
            SetParent: user32.func('__stdcall', 'SetParent', 'uintptr', ['uintptr', 'uintptr']),
            GetClientRect: user32.func('__stdcall', 'GetClientRect', 'bool',
                ['uintptr', koffi.out(koffi.pointer(RECT))]),
            GetWindowLongPtrW: user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr',
                ['uintptr', 'int']),
            SetWindowLongPtrW: user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr',
                ['uintptr', 'int', 'intptr']),
            MoveWindow: user32.func('__stdcall', 'MoveWindow', 'bool',
                ['uintptr', 'int', 'int', 'int', 'int', 'bool']),
            IsWindow: user32.func('__stdcall', 'IsWindow', 'bool', ['uintptr']),
        };
    } catch (err) {
        console.error('[preview] Win32 bindings unavailable:', err.message);
        api = null;
    }
    return api;
}

function available() {
    return !!load();
}

// Electron hands back the HWND as a raw buffer; x64 means 8 bytes LE.
function hwndFromBuffer(buf) {
    try {
        if (!buf || buf.length < 4) return null;
        return buf.length >= 8
            ? buf.readBigUInt64LE(0)
            : BigInt(buf.readUInt32LE(0));
    } catch {
        return null;
    }
}

// The host window's client area, which is the size our preview must be.
function clientSize(hwnd) {
    const a = load();
    if (!a) return null;
    try {
        const r = {};
        if (!a.GetClientRect(hwnd, r)) return null;
        const width  = r.right - r.left;
        const height = r.bottom - r.top;
        if (width <= 0 || height <= 0) return null;
        return { width, height };
    } catch {
        return null;
    }
}

// Reparent `childBuffer` (an Electron native window handle) into `parentHwnd`
// and fill it. Returns true only if every step succeeded.
function embed(childBuffer, parentHwnd, size) {
    const a = load();
    if (!a) return false;

    const child = hwndFromBuffer(childBuffer);
    if (child === null) return false;

    try {
        // WS_CHILD is what makes the window clip to, and move with, the host.
        // Leaving WS_POPUP set alongside it produces a window that is parented
        // but still painted as a top-level popup.
        const style = a.GetWindowLongPtrW(child, GWL_STYLE);
        const next  = (BigInt(style) & ~BigInt(WS_POPUP)) | BigInt(WS_CHILD) | BigInt(WS_VISIBLE);
        a.SetWindowLongPtrW(child, GWL_STYLE, next);

        if (!a.SetParent(child, parentHwnd)) return false;

        a.MoveWindow(child, 0, 0, size.width, size.height, true);
        return true;
    } catch (err) {
        console.error('[preview] embedding failed:', err.message);
        return false;
    }
}

// The settings dialog does not tell us when it is done; it just destroys the
// host window. Polling it is how a preview knows to exit instead of lingering.
function watchParent(parentHwnd, onGone) {
    const a = load();
    if (!a) return null;
    const timer = setInterval(() => {
        let alive = false;
        try { alive = a.IsWindow(parentHwnd); } catch { alive = false; }
        if (!alive) {
            clearInterval(timer);
            onGone();
        }
    }, 500);
    return timer;
}

module.exports = { available, clientSize, embed, watchParent };
