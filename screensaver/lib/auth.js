// BirdWatchAI Community Feed — community account sign-in
//
// Why this exists: private communities gate their detections behind RLS
// (`community_user_sees_feeder(feeder_id, auth.uid())`). Querying with the
// anon key returns only public feeders; querying with a signed-in member's
// JWT returns everything that member can see, with no change to the query
// itself. So "show me the feeders I have access to" is entirely a matter of
// holding a valid access token.
//
// Community accounts are magic-link only — there is no password to collect.
// A desktop settings dialog cannot receive a browser redirect, so sign-in
// here is the one-time-code half of the same GoTrue flow:
//
//   1. POST /auth/v1/otp    { email }           -> Supabase emails the user
//   2. POST /auth/v1/verify { email, token }    -> access + refresh tokens
//
// Step 2 accepts either the 6-digit code from the email or the sign-in link
// pasted whole, because whether the email shows a code depends on the
// project's email template. Handling both means this works without anyone
// having to touch the Supabase dashboard first.
//
// Tokens live in auth.json beside the settings file. A refresh token is a real
// credential and it is long-lived, so it is encrypted with Electron's
// safeStorage (DPAPI on Windows, tied to the logged-in account) rather than
// left as readable JSON. fs mode 0600 would not help here — Node's mode bits
// are essentially ignored on Windows.

const fs   = require('fs');
const path = require('path');
const { SUPABASE_URL, ANON_KEY } = require('./supabase');

// Optional: this module is also exercised by scripts outside Electron, where
// there is no safeStorage to reach for.
let safeStorage = null;
try {
    ({ safeStorage } = require('electron'));
} catch { /* running outside Electron */ }

function canEncrypt() {
    try { return !!safeStorage && safeStorage.isEncryptionAvailable(); }
    catch { return false; }
}

let AUTH_PATH  = null;
let session    = null;   // { access_token, refresh_token, expires_at, email }
let refreshing = null;   // in-flight refresh, so N callers share one request

function init(userDataDir) {
    AUTH_PATH = path.join(userDataDir, 'auth.json');
    session = read();
}

// On disk the file is either {"enc":"<base64>"} or, where encryption is not
// available, the plain session object. Reading handles both so a session
// survives moving between those states.
function read() {
    try {
        const raw = fs.readFileSync(AUTH_PATH, 'utf-8');
        let s = JSON.parse(raw);
        if (s && typeof s.enc === 'string') {
            if (!canEncrypt()) return null;   // encrypted, and we cannot decrypt
            s = JSON.parse(safeStorage.decryptString(Buffer.from(s.enc, 'base64')));
        }
        if (s && s.refresh_token) return s;
    } catch { /* no session yet, or it is unreadable */ }
    return null;
}

function write(s) {
    session = s;
    try {
        if (!s) {
            fs.rmSync(AUTH_PATH, { force: true });
            return;
        }
        const body = canEncrypt()
            ? JSON.stringify({
                enc: safeStorage.encryptString(JSON.stringify(s)).toString('base64'),
              })
            : JSON.stringify(s, null, 2);
        fs.writeFileSync(AUTH_PATH, body, { mode: 0o600 });
    } catch (err) {
        console.error('[auth] could not persist session:', err.message);
    }
}

// Shape a GoTrue token response into what we persist.
function adopt(data, emailFallback) {
    if (!data || !data.access_token) return null;
    const expiresAt = data.expires_at
        ? data.expires_at * 1000
        : Date.now() + (data.expires_in || 3600) * 1000;
    return {
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    expiresAt,
        email:         (data.user && data.user.email) || emailFallback ||
                       (session && session.email) || '',
    };
}

// ── Sign-in ────────────────────────────────────────────────

// Ask Supabase to email a sign-in code / link.
async function requestCode(email) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.msg || err.error_description ||
            `Sign-in email failed (HTTP ${res.status})`);
    }
    return true;
}

// Pull whatever GoTrue material is hiding in a pasted sign-in link. Three
// shapes exist in the wild, depending on template and GoTrue version:
//   ...#access_token=...&refresh_token=...   already-redeemed landing URL
//   ...?token_hash=...&type=magiclink        current templates
//   ...?token=...&type=magiclink             older templates
function parseSignInUrl(text) {
    let url;
    try { url = new URL(text.trim()); } catch { return null; }

    const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    if (hash.get('access_token')) {
        return {
            kind: 'session',
            data: {
                access_token:  hash.get('access_token'),
                refresh_token: hash.get('refresh_token'),
                expires_in:    parseInt(hash.get('expires_in') || '3600', 10),
            },
        };
    }

    const q    = url.searchParams;
    const type = q.get('type') || 'magiclink';
    if (q.get('token_hash')) return { kind: 'token_hash', token_hash: q.get('token_hash'), type };
    if (q.get('token'))      return { kind: 'token',      token: q.get('token'),           type };
    return null;
}

// Finish sign-in with either the emailed code or the emailed link.
async function verify(email, input) {
    const text = String(input || '').trim();
    if (!text) throw new Error('Enter the code or paste the link from the email.');

    const parsed = text.includes('://') ? parseSignInUrl(text) : null;

    // A landing URL already carries a live session — nothing left to redeem.
    if (parsed && parsed.kind === 'session') {
        const s = adopt(parsed.data, email);
        if (!s) throw new Error('That link did not contain a usable session.');
        write(s);
        return status();
    }

    let body;
    if (parsed && parsed.kind === 'token_hash') {
        body = { type: parsed.type, token_hash: parsed.token_hash };
    } else if (parsed && parsed.kind === 'token') {
        body = { type: parsed.type, token: parsed.token, email };
    } else if (/^\d{6,8}$/.test(text)) {
        // A bare numeric code from the email body.
        body = { type: 'email', token: text, email };
    } else {
        throw new Error('That does not look like a sign-in code or link.');
    }

    if (body.token && !body.email) {
        throw new Error('Enter the email address you requested the code for.');
    }

    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.msg || err.error_description ||
            'That code or link was not accepted. It may have expired.');
    }

    const s = adopt(await res.json(), email);
    if (!s) throw new Error('Sign-in did not return a session.');
    write(s);
    return status();
}

// ── Token upkeep ───────────────────────────────────────────

async function doRefresh() {
    if (!session || !session.refresh_token) return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!res.ok) {
            // 4xx means the refresh token is spent or revoked. Anything else is
            // most likely the network being down mid-screensaver, and dropping a
            // good session over that would silently lose the private feeders
            // until someone opened Settings again.
            if (res.status >= 400 && res.status < 500) write(null);
            return null;
        }
        const s = adopt(await res.json());
        if (s) write(s);
        return s;
    } catch {
        return null;   // offline: keep the session, try again next time
    }
}

// Current access token, refreshed when close to expiry. Null when signed out,
// which tells callers to fall back to the anon key.
async function getAccessToken() {
    if (!session) return null;
    if (session.expires_at && session.expires_at - Date.now() > 60000) {
        return session.access_token;
    }
    if (!refreshing) {
        refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    const s = await refreshing;
    return s ? s.access_token : null;
}

// Headers for a Supabase REST/Storage call: the user's JWT when signed in, the
// anon key otherwise. `apikey` is required either way.
async function headers(extra) {
    const token = await getAccessToken();
    return {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token || ANON_KEY}`,
        ...(extra || {}),
    };
}

async function signOut() {
    const token = session && session.access_token;
    write(null);
    if (token) {
        try {
            await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
                method: 'POST',
                headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
            });
        } catch { /* the local sign-out already happened */ }
    }
    return status();
}

function status() {
    return { signedIn: !!session, email: (session && session.email) || '' };
}

function isSignedIn() { return !!session; }

module.exports = {
    init, requestCode, verify, getAccessToken, headers,
    signOut, status, isSignedIn,
};
