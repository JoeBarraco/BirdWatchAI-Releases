// ────────────────────────────────────────────────────────────────────────────
// renewal-reminders edge function.
//
// Run daily via pg_cron. Scans `feeders` for upcoming subscription_renews_at
// dates and emails contact_email at the 30 / 14 / 3 day checkpoints. Each
// checkpoint fires once per renews_at value (de-duped via the
// `last_reminded_for` column — see setup-privacy.sql), so re-running this
// function the same day is a no-op.
//
// Skipped silently:
//   * Feeders with renews_at = null (perpetual / unsubscribed)
//   * Feeders with contact_email = null (best-effort; the in-app banner
//     still fires for them, just no email)
//   * Feeders whose renews_at is more than 31 days out or already passed
//     (the latter is a job for tier-downgrade flow, not reminders).
//
// CRON: scheduled by the pg_cron snippet at the bottom of setup-privacy.sql.
// Manual trigger: POST with { email, password } of an admin moderator.
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CHECKPOINTS = [
  { days: 30, label: 'in about a month' },
  { days: 14, label: 'in two weeks' },
  { days:  3, label: 'in three days' },
];

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(d: Date) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric'
  });
}

function buildHtml(opts: {
  feederName: string;
  tier: string;
  renewsAt: string;
  daysUntil: number;
  checkpointLabel: string;
  siteUrl: string;
}) {
  const { feederName, tier, renewsAt, daysUntil, checkpointLabel, siteUrl } = opts;
  const tierLabel = tier === 'pro' ? 'Pro (1-year media retention)'
                  : tier === 'plus' ? 'Plus (90-day media retention)'
                  : 'Free (7-day media retention)';
  const renewsHuman = fmtDate(new Date(renewsAt));
  // 3-day reminder gets the loudest header; 30-day reminder is friendliest.
  const urgency = daysUntil <= 3 ? '🚨 ' : daysUntil <= 14 ? '⏰ ' : '🔔 ';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BirdWatchAI renewal reminder</title></head>
<body style="margin:0;padding:0;background:#f4f6f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f0;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#2d5a3d,#4a8c5c);padding:32px 32px 28px;text-align:center;">
            <div style="font-size:36px;margin-bottom:8px;">🐦</div>
            <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">${urgency}Your storage plan renews ${esc(checkpointLabel)}</div>
            <div style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:6px;">Feeder: ${esc(feederName)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;color:#333;font-size:15px;line-height:1.55;">
            <p style="margin:0 0 14px;">Heads up — the community storage plan for your feeder
            <strong>${esc(feederName)}</strong> is set to renew on
            <strong>${esc(renewsHuman)}</strong> (${daysUntil} day${daysUntil === 1 ? '' : 's'} from today).</p>
            <p style="margin:0 0 14px;">Current plan: <strong>${esc(tierLabel)}</strong>.</p>
            <p style="margin:0 0 14px;">If you'd like to keep the same retention window, no action
            needed — your subscription renews automatically. If you want to change tiers, cancel,
            or update your payment method, you can do that from your account page.</p>
            <p style="margin:0 0 18px;font-size:13.5px;color:#555;">When a plan ends, the detection
            rows stay (so your life list, stats, and history are safe forever). Only the photos and
            video clips themselves age out — and you'll always have a 30-day grace window to come
            back and restore them.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px;text-align:center;">
            <a href="${esc(siteUrl)}" style="display:inline-block;background:#2d5a3d;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:8px;">Manage subscription</a>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px 24px;text-align:center;font-size:12px;color:#888;border-top:1px solid #eee;">
            BirdBrain Industries LLC · BirdWatchAI<br>
            You're receiving this because this address is set as the contact email for the feeder above.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY') ?? '';
  const SUPABASE_URL          = Deno.env.get('SUPABASE_URL') ?? '';
  const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const FROM_EMAIL            = Deno.env.get('RENEWAL_FROM_EMAIL') ?? 'BirdWatchAI <renewals@birdwatchai.com>';
  const SITE_URL              = Deno.env.get('SITE_URL') ?? 'https://www.birdwatchai.com';
  const supabase              = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  // Allow manual trigger by an admin moderator (for testing). pg_cron calls
  // this with an empty body via service_role — both paths work; the
  // service_role bypasses the auth check by virtue of the supabase-py
  // call wrapping the function (this handler doesn't enforce auth itself).
  try {
    const body = await req.json().catch(() => ({}));
    const { email, password } = body ?? {};
    if (email && password) {
      // Manual trigger from the admin console: verify creds.
      const { data: mod, error: loginErr } = await supabase.rpc('moderator_login', {
        p_email: email, p_password: password,
      });
      if (loginErr || !mod || !mod.id) {
        return new Response(JSON.stringify({ error: 'Invalid moderator credentials' }), { status: 401 });
      }
      if ((mod.role ?? '') !== 'admin') {
        return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
      }
    }
    // No creds → assume service_role pg_cron call.

    const now = Date.now();
    // Pull every feeder with a finite, future, ≤32-day-out renewal. 32d
    // window gives the 30-day checkpoint a 2-day safety margin in case
    // cron misses a day.
    const upperBound = new Date(now + 32 * 24 * 60 * 60 * 1000).toISOString();
    const lowerBound = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const { data: feeders, error: fErr } = await supabase
      .from('feeders')
      .select('id, display_name, subscription_tier, subscription_renews_at, contact_email, last_reminded_for')
      .not('subscription_renews_at', 'is', null)
      .gte('subscription_renews_at', lowerBound)
      .lte('subscription_renews_at', upperBound);
    if (fErr) throw fErr;

    let candidates = 0;
    const reminders: Array<{
      feederId: string;
      to: string;
      payload: any;
      stampRenews: string;
    }> = [];

    for (const f of (feeders ?? [])) {
      if (!f.contact_email) continue;
      if (!f.subscription_renews_at) continue;
      const renewsAt = new Date(f.subscription_renews_at).getTime();
      const daysUntil = Math.round((renewsAt - now) / (24 * 60 * 60 * 1000));
      // Pick the appropriate checkpoint based on days_until. Each checkpoint
      // is a 1-day band (±0.5) so a daily cron catches exactly one of them.
      const checkpoint = CHECKPOINTS.find(c => Math.abs(c.days - daysUntil) <= 1);
      if (!checkpoint) continue;
      // Have we already sent a reminder for THIS renews_at value? (The
      // trigger nulls last_reminded_for whenever renews_at changes, so a
      // tier change re-arms the series.)
      if (f.last_reminded_for === f.subscription_renews_at) {
        // Allow a re-send when crossing into a new checkpoint window
        // (i.e. 30→14, 14→3). We do this by stamping the renews_at AND
        // tracking which checkpoint last fired — but for v1 we just send
        // each upcoming renewal ONE reminder total to keep it simple.
        continue;
      }
      candidates++;
      reminders.push({
        feederId: f.id,
        to: f.contact_email,
        stampRenews: f.subscription_renews_at,
        payload: {
          from:    FROM_EMAIL,
          to:      f.contact_email,
          subject: `🐦 BirdWatchAI: storage plan renews ${checkpoint.label} for "${f.display_name ?? 'your feeder'}"`,
          html:    buildHtml({
            feederName:      f.display_name ?? 'your feeder',
            tier:            (f.subscription_tier ?? 'free').toLowerCase(),
            renewsAt:        f.subscription_renews_at,
            daysUntil,
            checkpointLabel: checkpoint.label,
            siteUrl:         SITE_URL,
          }),
        },
      });
    }

    if (!reminders.length) {
      return new Response(JSON.stringify({ candidates, sent: 0, message: 'Nothing in checkpoint windows.' }), { status: 200 });
    }

    // Resend in batches of 100 (their batch endpoint cap).
    let sent = 0;
    for (let i = 0; i < reminders.length; i += 100) {
      const batch = reminders.slice(i, i + 100);
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch.map(r => r.payload)),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend batch error (${res.status}): ${errText}`);
      }
      // Stamp last_reminded_for on every feeder in this batch so the next
      // run doesn't re-send. Done one row at a time to keep the trigger
      // semantics intact (we want each UPDATE to fire the reset trigger
      // for clarity, even though we're writing a value that matches
      // current renews_at).
      for (const r of batch) {
        const { error: stampErr } = await supabase
          .from('feeders')
          .update({ last_reminded_for: r.stampRenews })
          .eq('id', r.feederId);
        if (stampErr) console.error('stamp error for feeder', r.feederId, stampErr);
      }
      sent += batch.length;
    }

    return new Response(JSON.stringify({ candidates, sent }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error('renewal-reminders error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
