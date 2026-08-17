// Edge function: stripe-license-webhook
//
// Handles Stripe `checkout.session.completed` events for software-license
// purchases. The flow:
//
//   1. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET
//      (rejects replay / forged calls).
//   2. Pull customer email + name out of the session (Stripe fills these in
//      from the buyer's checkout form).
//   3. Mint a signed license key matching the desktop app's format:
//          BASE64(JSON) | BASE64(RSA-SHA256-PKCS1 signature)
//      using the private key in LICENSE_PRIVATE_KEY_PEM (PKCS#8 PEM). The
//      desktop app's embedded public key verifies it unchanged.
//   4. Insert into `licenses` (idempotent on stripe_session_id — Stripe
//      retries webhooks, so a duplicate session is a no-op).
//   5. Email the key via Resend (RESEND_API_KEY + LICENSE_FROM_EMAIL).
//
// Required function secrets:
//   STRIPE_WEBHOOK_SECRET     - whsec_... from the Stripe dashboard
//   LICENSE_PRIVATE_KEY_PEM   - PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----…")
//                               Convert the existing XML key once with the
//                               provided one-shot script (see README), or
//                               generate a new 2048-bit RSA pair and re-ship
//                               the public_key.xml inside the desktop app.
//   RESEND_API_KEY            - for delivery email (optional — without it
//                               the key is still stored, just not emailed)
//   LICENSE_FROM_EMAIL        - From: address (e.g. "BirdWatch AI <licenses@…>")
//
// Setup in Stripe:
//   * Enable Checkout for the BirdWatch AI product.
//   * Add a webhook endpoint:
//       https://<project>.functions.supabase.co/stripe-license-webhook
//     subscribed to `checkout.session.completed`.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL             = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET    = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const LICENSE_PRIVATE_KEY_PEM  = Deno.env.get('LICENSE_PRIVATE_KEY_PEM') ?? '';
const RESEND_API_KEY           = Deno.env.get('RESEND_API_KEY') ?? '';
const LICENSE_FROM_EMAIL       = Deno.env.get('LICENSE_FROM_EMAIL') ?? 'licenses@birdwatchai.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ── Stripe signature verification ────────────────────────────────────────────
// Stripe signs the payload with HMAC-SHA256 over `${timestamp}.${body}`.
// We verify manually rather than pull in the Stripe SDK (Deno-friendly,
// avoids a 1MB+ dependency for what is ~30 lines of crypto).
async function verifyStripeSignature(body: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const timestamp = parts['t'];
  const expected  = parts['v1'];
  if (!timestamp || !expected) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === expected;
}

// ── License key minting ──────────────────────────────────────────────────────
// Mirrors LicenseKeyGenerator.GenerateLicense in the desktop tool. The
// payload field names and order must match LicenseInfo on the verifying
// side — System.Text.Json doesn't care about order but DOES care about
// camelCase + the exact set of fields, so keep them in sync.
const SEGMENT_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateSegment(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => SEGMENT_CHARS[b % SEGMENT_CHARS.length]).join('');
}
function newLicenseId(): string {
  return `BWA-${generateSegment()}-${generateSegment()}-${generateSegment()}`;
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
    false, ['sign']
  );
}

interface LicensePayload {
  licenseId:       string;
  customerName:    string;
  phone:           string;
  address:         string;
  email:           string;
  issueDate:       string;          // ISO 8601, matches DateTime serialization
  expirationDate:  string | null;
  productVersion:  string;
  orderReference:  string;
}

async function mintLicense(payload: LicensePayload): Promise<string> {
  const json     = JSON.stringify(payload);
  const jsonBuf  = new TextEncoder().encode(json);
  const key      = await loadPrivateKey();
  const sigBuf   = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, jsonBuf);
  const b64Json  = btoa(String.fromCharCode(...jsonBuf));
  const b64Sig   = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${b64Json}|${b64Sig}`;
}

// ── Email delivery via Resend ────────────────────────────────────────────────
async function emailLicense(to: string, customerName: string, licenseId: string, licenseKey: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY unset — skipping license email; key is stored in DB');
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

License key (copy the entire block including the | separator):

${licenseKey}

To activate: open BirdWatch AI, go to Help → Enter License Key, and paste
the key above. You can re-download your key any time from your account
page at https://birdwatchai.com/account.

— Joe Barraco, BirdBrain Industries LLC
`,
    }),
  });
  if (!res.ok) {
    console.error('Resend delivery failed:', res.status, await res.text());
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const body = await req.text();
  const sig  = req.headers.get('Stripe-Signature') ?? '';
  if (!STRIPE_WEBHOOK_SECRET || !(await verifyStripeSignature(body, sig, STRIPE_WEBHOOK_SECRET))) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(body); }
  catch { return new Response('Bad JSON', { status: 400 }); }

  if (event.type !== 'checkout.session.completed') {
    // Other event types — acknowledge so Stripe stops retrying.
    return new Response(JSON.stringify({ ignored: event.type }), { status: 200 });
  }

  const session = event.data?.object ?? {};
  const sessionId  = session.id;
  const email      = session.customer_details?.email ?? session.customer_email;
  const name       = session.customer_details?.name  ?? '';
  const stripeCust = session.customer ?? null;

  if (!email) {
    console.error('checkout.session.completed without an email:', sessionId);
    return new Response(JSON.stringify({ error: 'no email' }), { status: 400 });
  }

  // Idempotency: Stripe retries on any non-2xx. If we already issued a key
  // for this session, return the existing one rather than minting a second.
  const { data: existing } = await supabase
    .from('licenses')
    .select('license_id, license_key')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();
  if (existing) {
    return new Response(JSON.stringify({ success: true, license_id: existing.license_id, duplicate: true }), { status: 200 });
  }

  const licenseId = newLicenseId();
  const payload: LicensePayload = {
    licenseId,
    customerName:   name,
    phone:          '',
    address:        '',
    email,
    issueDate:      new Date().toISOString(),
    expirationDate: null,
    productVersion: session.metadata?.product_version ?? '',
    orderReference: sessionId,
  };

  let licenseKey: string;
  try { licenseKey = await mintLicense(payload); }
  catch (e) {
    console.error('mint failed:', e);
    return new Response(JSON.stringify({ error: 'mint failed' }), { status: 500 });
  }

  const { error: insErr } = await supabase.from('licenses').insert({
    license_id:         licenseId,
    license_key:        licenseKey,
    customer_email:     email,
    customer_name:      name,
    source:             'stripe',
    stripe_session_id:  sessionId,
    stripe_customer_id: stripeCust,
    order_reference:    sessionId,
  });
  if (insErr) {
    console.error('licenses insert failed:', insErr.message);
    return new Response(JSON.stringify({ error: insErr.message }), { status: 500 });
  }

  await emailLicense(email, name, licenseId, licenseKey);

  return new Response(JSON.stringify({ success: true, license_id: licenseId }), { status: 200 });
});
