// Edge function: gumroad-license-webhook
//
// Turns a Gumroad sale into a BirdWatch AI license key. Gumroad is the
// storefront and merchant of record; the license itself is still minted here
// with OUR RSA private key, in the exact format the desktop
// LicenseGeneratorTool has always produced:
//
//     BASE64(JSON) | BASE64(RSA-SHA256-PKCS1 signature)
//
// Consequences worth being explicit about, because they are the reason this
// design was chosen over using Gumroad's native license keys:
//
//   * Every license ever issued keeps working. Validation is an offline
//     signature check against the public key embedded in the apps
//     (BirdWatchAI.Licensing.LicenseManager and BirdWatch.Core LicenseService).
//     Nothing in this function can invalidate an existing key.
//   * Hand-minting keeps working. The desktop LicenseGeneratorTool signs with
//     the same private key, so keys from either path are indistinguishable to
//     the apps. Gumroad is an ADDITIONAL minting path, not a replacement.
//   * No app release is needed to turn this on.
//
// Flow:
//   1. Authenticate the request (see "Authenticity" below — Gumroad pings are
//      not HMAC-signed the way Stripe's are, so this takes three cheap
//      precautions instead of one strong one).
//   2. Pull buyer email + name + sale id out of the form-encoded ping.
//   3. Route refunds/disputes to the revoke path.
//   4. Mint the signed key and insert into `licenses`, idempotent on
//      gumroad_sale_id (Gumroad retries pings on non-2xx).
//   5. Email the key via Resend.
//
// ── Authenticity ────────────────────────────────────────────────────────────
// Gumroad does not sign ping payloads. Three defences, in order of strength:
//   a) Shared secret in the endpoint URL (?token=…), compared in constant
//      time. Required — the function refuses to run without it configured.
//   b) Call Gumroad back to confirm the sale actually exists. Either
//      /v2/licenses/verify (when the product has Gumroad license keys
//      enabled, no auth needed) or /v2/sales/:id (needs
//      GUMROAD_ACCESS_TOKEN). Set GUMROAD_REQUIRE_CALLBACK=1 to hard-fail
//      when neither is possible.
//   c) Product allowlist — a ping for some other product (or a $1 product)
//      cannot mint a license.
//
// ── Required function secrets ───────────────────────────────────────────────
//   GUMROAD_PING_TOKEN        - long random string; also appended to the ping
//                               URL you paste into Gumroad as ?token=…
//   LICENSE_PRIVATE_KEY_PEM   - PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----…").
//                               Convert the desktop tool's existing
//                               Keys/private_key.xml with
//                               tools/BirdWatch.LicenseKeyTool in the
//                               birdwatchai-server repo:
//                                 dotnet run --project tools/BirdWatch.LicenseKeyTool -- pem <path>
//                               It refuses to emit a key that doesn't match
//                               the public key shipped in the apps.
//   GUMROAD_PRODUCT_ID        - product id (or comma-separated ids) allowed to
//                               mint. Also accepts permalinks.
//
// ── Optional function secrets ───────────────────────────────────────────────
//   GUMROAD_ACCESS_TOKEN      - enables /v2/sales/:id callback verification.
//                               Needed only if Gumroad license keys are OFF
//                               for the product (the recommended setup).
//   GUMROAD_REQUIRE_CALLBACK  - "1" to reject pings that cannot be verified
//                               against Gumroad's API.
//   RESEND_API_KEY            - delivery email. Without it the key is still
//                               stored, just not emailed.
//   LICENSE_FROM_EMAIL        - From: address.
//   LICENSE_TERM_DAYS         - set to e.g. "365" to issue time-limited keys.
//                               Unset/0 = perpetual (the current product).
//   LICENSE_PRODUCT_VERSION   - stamped into the payload's productVersion.
//
// Setup in Gumroad: see README.md next to this file.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL            = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PING_TOKEN              = Deno.env.get('GUMROAD_PING_TOKEN') ?? '';
const PRODUCT_IDS             = (Deno.env.get('GUMROAD_PRODUCT_ID') ?? '')
                                  .split(',').map(s => s.trim()).filter(Boolean);
const GUMROAD_ACCESS_TOKEN    = Deno.env.get('GUMROAD_ACCESS_TOKEN') ?? '';
const REQUIRE_CALLBACK        = (Deno.env.get('GUMROAD_REQUIRE_CALLBACK') ?? '') === '1';
const LICENSE_PRIVATE_KEY_PEM = Deno.env.get('LICENSE_PRIVATE_KEY_PEM') ?? '';
const RESEND_API_KEY          = Deno.env.get('RESEND_API_KEY') ?? '';
const LICENSE_FROM_EMAIL      = Deno.env.get('LICENSE_FROM_EMAIL') ?? 'licenses@birdwatchai.com';
const LICENSE_TERM_DAYS       = parseInt(Deno.env.get('LICENSE_TERM_DAYS') ?? '0', 10) || 0;
const LICENSE_PRODUCT_VERSION = Deno.env.get('LICENSE_PRODUCT_VERSION') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ── Small helpers ───────────────────────────────────────────────────────────

/** Constant-time string compare, so the ping token can't be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** btoa() in chunks — spreading a big Uint8Array into String.fromCharCode blows the stack. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function isTruthy(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Gumroad posts pings as application/x-www-form-urlencoded. Resource
 * subscriptions do too, but be liberal: accept JSON as well so a future
 * format change doesn't silently drop sales on the floor.
 */
async function parseBody(req: Request): Promise<Record<string, string>> {
  const raw = await req.text();
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const obj = JSON.parse(raw);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        flat[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      return flat;
    } catch {
      // fall through to form parsing
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// ── License key minting ─────────────────────────────────────────────────────
// Mirrors LicenseKeyGenerator.GenerateLicense in the desktop tool. The payload
// is camelCase because the generator serializes with
// JsonNamingPolicy.CamelCase; both verifiers read it with
// PropertyNameCaseInsensitive = true, so casing is belt-and-braces and field
// ORDER is irrelevant (the signature covers the exact bytes we emit here).
// What does matter is the field SET — keep it in sync with LicenseInfo.

const SEGMENT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars

function generateSegment(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => SEGMENT_CHARS[b % SEGMENT_CHARS.length]).join('');
}

/**
 * "BWG-" (Gumroad) rather than the desktop tool's "BWA-", so the two minting
 * paths can never collide on an id and provenance is readable at a glance.
 * Nothing validates the prefix — the apps treat licenseId as an opaque string
 * and HMAC it into the community feeder id — so this is purely for humans.
 */
function newLicenseId(): string {
  return `BWG-${generateSegment()}-${generateSegment()}-${generateSegment()}`;
}

function pemToBinary(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function loadPrivateKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'pkcs8', pemToBinary(LICENSE_PRIVATE_KEY_PEM),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

interface LicensePayload {
  licenseId:      string;
  customerName:   string;
  phone:          string;
  address:        string;
  email:          string;
  issueDate:      string;        // ISO 8601 — System.Text.Json parses this into DateTime
  expirationDate: string | null; // null = perpetual
  productVersion: string;
  orderReference: string;
}

async function mintLicense(payload: LicensePayload): Promise<string> {
  const jsonBuf = new TextEncoder().encode(JSON.stringify(payload));
  const key     = await loadPrivateKey();
  const sigBuf  = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, jsonBuf);
  return `${toBase64(jsonBuf)}|${toBase64(new Uint8Array(sigBuf))}`;
}

// ── Gumroad callback verification ───────────────────────────────────────────

interface CallbackResult {
  verified: boolean;
  /** True when we had no way to check at all (no license key, no access token). */
  unchecked: boolean;
  detail: string;
}

/**
 * Confirm with Gumroad that this sale is real. Two routes, picked by what the
 * ping and the configured secrets make available.
 */
async function verifyWithGumroad(
  saleId: string,
  productId: string,
  gumroadLicenseKey: string,
): Promise<CallbackResult> {
  // Route 1 — /v2/licenses/verify. Public endpoint (no access token), but only
  // usable when the product has Gumroad license keys enabled so the ping
  // carries one.
  if (gumroadLicenseKey && productId) {
    try {
      const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          product_id:           productId,
          license_key:          gumroadLicenseKey,
          increment_uses_count: 'false',
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success === true) {
        return { verified: true, unchecked: false, detail: 'licenses/verify ok' };
      }
      return {
        verified: false, unchecked: false,
        detail: `licenses/verify rejected (${res.status}) ${JSON.stringify(json).slice(0, 200)}`,
      };
    } catch (e) {
      return { verified: false, unchecked: false, detail: `licenses/verify threw: ${e}` };
    }
  }

  // Route 2 — /v2/sales/:id with an access token. This is the route to use when
  // Gumroad's own license keys are OFF (recommended: the buyer then receives
  // exactly one key, ours).
  if (GUMROAD_ACCESS_TOKEN && saleId) {
    try {
      const url = `https://api.gumroad.com/v2/sales/${encodeURIComponent(saleId)}` +
                  `?access_token=${encodeURIComponent(GUMROAD_ACCESS_TOKEN)}`;
      const res  = await fetch(url);
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success === true && json?.sale) {
        return { verified: true, unchecked: false, detail: 'sales/:id ok' };
      }
      return {
        verified: false, unchecked: false,
        detail: `sales/:id rejected (${res.status}) ${JSON.stringify(json).slice(0, 200)}`,
      };
    } catch (e) {
      return { verified: false, unchecked: false, detail: `sales/:id threw: ${e}` };
    }
  }

  return {
    verified: false, unchecked: true,
    detail: 'no callback route available (no Gumroad license key in ping, no access token)',
  };
}

// ── Email delivery via Resend ───────────────────────────────────────────────

async function emailLicense(
  to: string, customerName: string, licenseId: string, licenseKey: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY unset — skipping license email; key is stored in the DB');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    LICENSE_FROM_EMAIL,
      to:      [to],
      subject: 'Your BirdWatch AI license key',
      text:
`Hi ${customerName || 'there'},

Thank you for purchasing BirdWatch AI!

Your license ID: ${licenseId}

License key (copy the entire block, including the | separator):

${licenseKey}

To activate the Windows app: open BirdWatch AI, go to Help -> Enter License
Key, and paste the key above.

To activate the server edition: open the dashboard, go to Settings -> License,
and paste the key there.

You can re-download your key any time from https://birdwatchai.com/account
using this email address.

-- Joe Barraco, BirdBrain Industries LLC
`,
    }),
  });
  if (!res.ok) {
    console.error('Resend delivery failed:', res.status, await res.text());
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // (a) Shared secret. Refuse to run at all if it isn't configured — an
  // unauthenticated mint endpoint is a licence printing press.
  if (!PING_TOKEN) {
    console.error('GUMROAD_PING_TOKEN is not set; refusing every request');
    return new Response('Not configured', { status: 503 });
  }
  const url      = new URL(req.url);
  const supplied = url.searchParams.get('token')
                ?? req.headers.get('x-gumroad-ping-token')
                ?? '';
  if (!timingSafeEqual(supplied, PING_TOKEN)) {
    console.warn('Rejected ping with bad/missing token');
    return new Response('Forbidden', { status: 403 });
  }

  const p = await parseBody(req);

  const saleId       = p['sale_id'] ?? '';
  const productId    = p['product_id'] ?? '';
  const permalink    = p['product_permalink'] ?? p['permalink'] ?? '';
  const email        = (p['email'] ?? '').trim();
  const name         = (p['full_name'] ?? p['custom_fields[Name]'] ?? '').trim();
  const gumroadKey   = p['license_key'] ?? '';
  const isTest       = isTruthy(p['test']);
  const isRefund     = isTruthy(p['refunded']);
  // dispute_won means the SELLER won the chargeback — the sale stands, so this
  // is the opposite of a revoke trigger. Only an open/lost dispute revokes.
  const disputeWon   = isTruthy(p['dispute_won']);
  const isDispute    = isTruthy(p['dispute']) && !disputeWon;
  const orderNumber  = p['order_number'] ?? '';

  if (!saleId) {
    console.error('ping without sale_id; ignoring');
    return new Response(JSON.stringify({ error: 'no sale_id' }), { status: 400 });
  }

  // (c) Product allowlist. Gumroad sends `product_id` for products created
  // after Jan 2023 and permalinks for older ones — accept a match on either.
  if (PRODUCT_IDS.length > 0) {
    const matches = PRODUCT_IDS.includes(productId)
                 || PRODUCT_IDS.includes(permalink)
                 || PRODUCT_IDS.includes(p['permalink'] ?? '');
    if (!matches) {
      console.log(`ignoring ping for unrelated product (product_id=${productId} permalink=${permalink})`);
      return new Response(JSON.stringify({ ignored: 'product not allowlisted' }), { status: 200 });
    }
  } else {
    console.warn('GUMROAD_PRODUCT_ID unset — every product on the account can mint licenses');
  }

  // ── dispute_won: the seller won, so un-revoke ─────────────────────────────
  // Reached from the `dispute_won` resource subscription. The sale stands, so
  // undo the revocation the earlier `dispute` ping wrote. Checked before the
  // revoke branch below, since a dispute_won payload also carries dispute=true.
  if (disputeWon) {
    const { data, error } = await supabase
      .from('licenses')
      .update({ revoked_at: null, revoked_reason: null })
      .eq('gumroad_sale_id', saleId)
      .eq('revoked_reason', 'gumroad dispute')
      .select('license_id');
    if (error) {
      console.error('un-revoke failed:', error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    console.log(`dispute won for sale ${saleId}: restored ${data?.length ?? 0} key(s)`);
    return new Response(JSON.stringify({ success: true, restored: data?.length ?? 0 }), { status: 200 });
  }

  // ── Refund / lost dispute: revoke rather than mint ────────────────────────
  // Reached when Gumroad's `refund` or `dispute` resource subscription points
  // at this same URL. Revocation is bookkeeping — an already-activated install
  // keeps working because validation is offline (see setup-licenses.sql).
  if (isRefund || isDispute) {
    const reason = isDispute ? 'gumroad dispute' : 'gumroad refund';
    const { data, error } = await supabase
      .from('licenses')
      .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
      .eq('gumroad_sale_id', saleId)
      .is('revoked_at', null)
      .select('license_id');
    if (error) {
      console.error('revoke failed:', error.message);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    console.log(`${reason} for sale ${saleId}: revoked ${data?.length ?? 0} key(s)`);
    return new Response(JSON.stringify({ success: true, revoked: data?.length ?? 0 }), { status: 200 });
  }

  if (!email) {
    console.error('sale ping without an email:', saleId);
    return new Response(JSON.stringify({ error: 'no email' }), { status: 400 });
  }

  // (b) Callback verification.
  const callback = await verifyWithGumroad(saleId, productId, gumroadKey);
  if (!callback.verified) {
    if (!callback.unchecked) {
      // Gumroad actively said no — this is a forged or stale ping.
      console.warn(`rejecting sale ${saleId}: ${callback.detail}`);
      return new Response(JSON.stringify({ error: 'gumroad verification failed' }), { status: 403 });
    }
    if (REQUIRE_CALLBACK) {
      console.error(`rejecting sale ${saleId}: ${callback.detail} (GUMROAD_REQUIRE_CALLBACK=1)`);
      return new Response(JSON.stringify({ error: 'unverifiable ping' }), { status: 403 });
    }
    console.warn(`sale ${saleId} accepted on shared secret alone: ${callback.detail}`);
  }

  // Idempotency: Gumroad retries pings on any non-2xx response, so a repeat of
  // a sale we've already served must return the existing key, not mint a
  // second one. The unique index on gumroad_sale_id is the real backstop.
  const { data: existing } = await supabase
    .from('licenses')
    .select('license_id')
    .eq('gumroad_sale_id', saleId)
    .maybeSingle();
  if (existing) {
    console.log(`sale ${saleId} already issued ${existing.license_id}; no-op`);
    return new Response(
      JSON.stringify({ success: true, license_id: existing.license_id, duplicate: true }),
      { status: 200 },
    );
  }

  const licenseId = newLicenseId();
  const issuedAt  = new Date();
  const expiresAt = LICENSE_TERM_DAYS > 0
    ? new Date(issuedAt.getTime() + LICENSE_TERM_DAYS * 86_400_000)
    : null;

  const payload: LicensePayload = {
    licenseId,
    customerName:   name,
    phone:          '',
    address:        '',
    email,
    issueDate:      issuedAt.toISOString(),
    expirationDate: expiresAt ? expiresAt.toISOString() : null,
    productVersion: LICENSE_PRODUCT_VERSION,
    orderReference: orderNumber ? `gumroad:${orderNumber}` : `gumroad:${saleId}`,
  };

  let licenseKey: string;
  try {
    licenseKey = await mintLicense(payload);
  } catch (e) {
    // Almost always a malformed LICENSE_PRIVATE_KEY_PEM. Return 500 so Gumroad
    // retries — once the secret is fixed, the retry succeeds on its own.
    console.error('mint failed:', e);
    return new Response(JSON.stringify({ error: 'mint failed' }), { status: 500 });
  }

  const { error: insErr } = await supabase.from('licenses').insert({
    license_id:           licenseId,
    license_key:          licenseKey,
    customer_email:       email,
    customer_name:        name || null,
    source:               'gumroad',
    gumroad_sale_id:      saleId,
    gumroad_product_id:   productId || permalink || null,
    gumroad_license_key:  gumroadKey || null,
    is_test:              isTest,
    order_reference:      payload.orderReference,
    expires_at:           expiresAt ? expiresAt.toISOString() : null,
  });
  if (insErr) {
    // Unique-violation on gumroad_sale_id means two pings raced; the other one
    // won and the buyer has their key. Treat as success so Gumroad stops.
    if ((insErr as { code?: string }).code === '23505') {
      console.log(`sale ${saleId} raced with a concurrent ping; treating as duplicate`);
      return new Response(JSON.stringify({ success: true, duplicate: true }), { status: 200 });
    }
    console.error('licenses insert failed:', insErr.message);
    return new Response(JSON.stringify({ error: insErr.message }), { status: 500 });
  }

  await emailLicense(email, name, licenseId, licenseKey);

  console.log(`issued ${licenseId} for sale ${saleId}${isTest ? ' (TEST)' : ''}`);
  return new Response(
    JSON.stringify({ success: true, license_id: licenseId, test: isTest }),
    { status: 200 },
  );
});
