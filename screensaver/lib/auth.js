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
//   1. POST /auth/v1/otp    { email }      -> Supabase emails the user
//   2. POST /auth/v1/verify { token_hash } -> access + refresh tokens
//
// Step 2 accepts either the 6-digit code from the email or the sign-in link
// pasted whole, because whether the email shows a code depends on the
// project's email template. Handling both means this works without anyone
// having to touch the Supabase dashboard first. See parseSignInUrl for why
// those two inputs do not go into the same field.
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

// Mail systems rewrite links before they reach the reader. Unwrap the common
// scanners so the real URL is what gets parsed, rather than the wrapper's own
// query string — which has no token in it and would look like garbage input.
function unwrap(text) {
    let s = String(text || '').trim()
        .replace(/^[<("']+/, '')
        .replace(/[>)"'.,]+$/, '');
    for (let i = 0; i < 3; i++) {
        let url;
        try { url = new URL(s); } catch { return s; }
        const host  = url.hostname.toLowerCase();
        const inner =
            host.endsWith('safelinks.protection.outlook.com') ? url.searchParams.get('url')  :
            host.endsWith('urldefense.com')                   ? null                         :
            host === 'www.google.com' && url.pathname === '/url' ? url.searchParams.get('q') :
            null;
        if (!inner) return s;
        s = inner;
    }
    return s;
}

// Pull whatever GoTrue material is hiding in a pasted sign-in link.
//
// The important subtlety is the `token` query parameter. GoTrue's
// {{ .ConfirmationURL }} renders as
//
//     /auth/v1/verify?token={{ .TokenHash }}&type=magiclink&redirect_to=...
//
// so despite the name, the value in the link is the *hash* (sha224 hex, 56
// chars) — never the raw one-time code. GET /verify looks a hash up directly;
// POST /verify hashes whatever arrives in its `token` field before looking it
// up. Forwarding a link's `token` as POST `token` therefore hashes an already
// hashed value and the lookup misses, which GoTrue reports as "Token has
// expired or is invalid" — indistinguishable from a genuinely dead link.
// Anything lifted out of a URL is a hash and goes in `token_hash`. Only a code
// the user typed from the email body belongs in `token`.
function parseSignInUrl(text) {
    let url;
    try { url = new URL(text); } catch { return null; }

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
    const hv   = q.get('token_hash') || q.get('token');
    if (hv) return { kind: 'token_hash', token_hash: hv, type };
    return null;
}

// Finish sign-in with either the emailed code or the emailed link.
async function verify(email, input) {
    const text = unwrap(input);
    if (!text) throw new Error('Enter the code or paste the link from the email.');

    const parsed = text.includes('://') ? parseSignInUrl(text) : null;

    // A landing URL already carries a live session — nothing left to redeem.
    if (parsed && parsed.kind === 'session') {
        const s = adopt(parsed.data, email);
        if (!s) throw new Error('That link did not contain a usable session.');
        write(s);
        return status();
    }

    let body, typed = false;
    if (parsed) {
        body = { type: parsed.type, token_hash: parsed.token_hash };
    } else if (/^[0-9a-f]{56}$/i.test(text)) {
        // Just the token lifted out of a link, without the rest of the URL.
        body = { type: 'magiclink', token_hash: text };
    } else if (/^\d{6,8}$/.test(text)) {
        // A code typed from the email body. This one really is a raw token, so
        // it needs the address alongside it: GoTrue hashes the pair.
        if (!email) throw new Error('Enter the email address you requested the code for.');
        body = { type: 'email', token: text, email };
        typed = true;
    } else if (text.includes('://')) {
        throw new Error('That link has no sign-in token in it. Copy the address of the ' +
            'button or link in the email itself, not the one in the address bar.');
    } else {
        throw new Error('That does not look like a sign-in code or link.');
    }

    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.msg || err.error_description || '';
        // GoTrue says the same thing for spent, mistyped and timed-out links, so
        // point at the one remedy that covers all three rather than repeating it.
        if (!msg || /expired|invalid/i.test(msg)) {
            throw new Error(typed
                ? 'That code was not accepted. Check it against the email, or send a ' +
                  'new one — codes are good for an hour and only once.'
                : 'That link is no longer good — it may have been opened already, or it ' +
                  'timed out. Send a new one and paste it without clicking.');
        }
        throw new Error(msg);
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
    _internal: { unwrap, parseSignInUrl },
};
