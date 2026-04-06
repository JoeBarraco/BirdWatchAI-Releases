import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// All env vars and the supabase client are initialised inside the handler
// so that Deno.env is fully populated before they are read.

// ── Helpers ──────────────────────────────────────────────────────────────────

function etDate(d: Date, opts: Intl.DateTimeFormatOptions) {
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', ...opts });
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Email template ────────────────────────────────────────────────────────────

function buildHtml(opts: {
  weekLabel: string;
  totalDetections: number;
  topSpecies: [string, number][];
  rarestSighting: { species: string; feeder: string | null; detected_at: string; image_url: string | null } | null;
  firstOfSeason: { species: string; feeder: string | null; detected_at: string } | null;
  unsubscribeUrl: string;
}) {
  const { weekLabel, totalDetections, topSpecies, rarestSighting, firstOfSeason, unsubscribeUrl } = opts;
  const maxCount = topSpecies[0]?.[1] ?? 1;

  const topSpeciesRows = topSpecies.map(([species, count], i) => {
    const pct = Math.round((count / maxCount) * 100);
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `
      <tr>
        <td style="padding:6px 0;white-space:nowrap;font-size:14px;width:28px;">${medal}</td>
        <td style="padding:6px 8px 6px 0;font-size:14px;white-space:nowrap;">${esc(species)}</td>
        <td style="padding:6px 0;width:100%;">
          <div style="background:#e8f5e9;border-radius:4px;height:12px;position:relative;">
            <div style="background:#2d5a3d;border-radius:4px;height:12px;width:${pct}%;"></div>
          </div>
        </td>
        <td style="padding:6px 0 6px 8px;font-size:13px;color:#555;white-space:nowrap;">${count}x</td>
      </tr>`;
  }).join('');

  const rarestBlock = rarestSighting ? `
    <div style="background:#fff8e1;border-left:4px solid #f9a825;border-radius:0 8px 8px 0;padding:16px 20px;margin:24px 0;">
      <div style="font-size:12px;font-weight:700;color:#f9a825;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">⭐ Rare Sighting This Week</div>
      ${rarestSighting.image_url ? `<img src="${esc(rarestSighting.image_url)}" alt="${esc(rarestSighting.species)}" style="width:100%;max-width:320px;border-radius:8px;margin-bottom:10px;display:block;">` : ''}
      <div style="font-size:18px;font-weight:700;color:#333;">${esc(rarestSighting.species)}</div>
      ${rarestSighting.feeder ? `<div style="font-size:13px;color:#666;margin-top:2px;">at ${esc(rarestSighting.feeder)}</div>` : ''}
      <div style="font-size:12px;color:#888;margin-top:4px;">${etDate(new Date(rarestSighting.detected_at), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</div>
    </div>` : '';

  const firstBlock = firstOfSeason ? `
    <div style="background:#e8f5e9;border-left:4px solid #2d5a3d;border-radius:0 8px 8px 0;padding:14px 20px;margin:24px 0;">
      <div style="font-size:12px;font-weight:700;color:#2d5a3d;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">🌱 First of the Season</div>
      <div style="font-size:16px;font-weight:700;color:#333;">${esc(firstOfSeason.species)}</div>
      ${firstOfSeason.feeder ? `<div style="font-size:13px;color:#666;">${esc(firstOfSeason.feeder)}</div>` : ''}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BirdWatchAI Weekly Digest</title></head>
<body style="margin:0;padding:0;background:#f4f6f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f0;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2d5a3d,#4a8c5c);padding:32px 32px 28px;text-align:center;">
            <div style="font-size:36px;margin-bottom:8px;">🐦</div>
            <div style="color:#fff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">BirdWatchAI</div>
            <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:4px;">Weekly Digest · ${esc(weekLabel)}</div>
          </td>
        </tr>

        <!-- Total count banner -->
        <tr>
          <td style="background:#e8f5e9;padding:16px 32px;text-align:center;border-bottom:1px solid #dcedc8;">
            <span style="font-size:28px;font-weight:800;color:#2d5a3d;">${totalDetections.toLocaleString()}</span>
            <span style="font-size:15px;color:#555;margin-left:6px;">bird detections this week across all feeders</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:28px 32px;">

            ${rarestBlock}
            ${firstBlock}

            <!-- Top Species -->
            <h2 style="font-size:17px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">🏆 Most-Seen Species This Week</h2>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${topSpeciesRows}
            </table>

            <!-- CTA -->
            <div style="text-align:center;margin:32px 0 8px;">
              <a href="${SITE_URL}/docs/community.html"
                 style="display:inline-block;background:#2d5a3d;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;letter-spacing:0.3px;">
                View Live Community Feed →
              </a>
            </div>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9f9f9;padding:20px 32px;border-top:1px solid #eee;text-align:center;">
            <p style="font-size:12px;color:#999;margin:0 0 6px;">You're receiving this because you subscribed to BirdWatchAI weekly digests.</p>
            <p style="font-size:12px;margin:0;">
              <a href="${esc(unsubscribeUrl)}" style="color:#888;text-decoration:underline;">Unsubscribe</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Initialise inside handler so Deno.env is ready
  const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY') ?? '';
  const SUPABASE_URL          = Deno.env.get('SUPABASE_URL') ?? '';
  const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const FROM_EMAIL            = Deno.env.get('DIGEST_FROM_EMAIL') ?? 'BirdWatchAI Weekly <digest@birdwatchai.com>';
  const SITE_URL              = Deno.env.get('SITE_URL') ?? 'https://joebarraco.github.io/birdwatchai-releases';
  const supabase              = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  // Only allow POST; cron invocations from Supabase pass the service role key
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const now     = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // ── Fetch past week's detections ─────────────────────────────────────────
    const { data: detections, error: dErr } = await supabase
      .from('community_detections')
      .select('species, rarity, detected_at, image_url, feeders(display_name)')
      .gte('detected_at', weekAgo.toISOString())
      .order('detected_at', { ascending: false })
      .limit(2000);

    if (dErr) throw dErr;
    if (!detections?.length) {
      return new Response(JSON.stringify({ message: 'No detections this week, skipping.' }), { status: 200 });
    }

    // ── Compute stats ────────────────────────────────────────────────────────
    const counts: Record<string, number> = {};
    let rarestSighting: typeof detections[0] | null = null;

    for (const d of detections) {
      counts[d.species] = (counts[d.species] ?? 0) + 1;
      if (d.rarity === 'Rare') {
        if (!rarestSighting) rarestSighting = d;
      }
    }

    const topSpecies = (Object.entries(counts) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    // First-of-season: species appearing for the first time (no prior detections before weekAgo)
    let firstOfSeason: typeof detections[0] | null = null;
    const uniqueThisWeek = [...new Set(detections.map(d => d.species))].slice(0, 20);
    for (const sp of uniqueThisWeek) {
      const { count } = await supabase
        .from('community_detections')
        .select('id', { count: 'exact', head: true })
        .eq('species', sp)
        .lt('detected_at', weekAgo.toISOString());
      if (count === 0) {
        firstOfSeason = detections.find(d => d.species === sp) ?? null;
        break;
      }
    }

    // ── Fetch subscribers ────────────────────────────────────────────────────
    const { data: subscribers, error: sErr } = await supabase
      .from('newsletter_signups')
      .select('email, unsubscribe_token');

    if (sErr) throw sErr;
    if (!subscribers?.length) {
      return new Response(JSON.stringify({ message: 'No subscribers.' }), { status: 200 });
    }

    // ── Build week label ─────────────────────────────────────────────────────
    const fmtShort = (d: Date) => etDate(d, { month: 'short', day: 'numeric' });
    const weekLabel = `${fmtShort(weekAgo)} – ${fmtShort(now)}`;

    // ── Send emails in batches of 100 ────────────────────────────────────────
    const SUPABASE_FUNCTIONS_URL = SUPABASE_URL.replace('.supabase.co', '.supabase.co/functions/v1');
    let sent = 0;

    for (let i = 0; i < subscribers.length; i += 100) {
      const batch = subscribers.slice(i, i + 100).map(sub => {
        const unsubUrl = `${SUPABASE_FUNCTIONS_URL}/unsubscribe?token=${sub.unsubscribe_token}`;
        const html = buildHtml({
          weekLabel,
          totalDetections: detections.length,
          topSpecies,
          rarestSighting: rarestSighting
            ? { ...rarestSighting, feeder: (rarestSighting.feeders as any)?.display_name ?? null }
            : null,
          firstOfSeason: firstOfSeason
            ? { ...firstOfSeason, feeder: (firstOfSeason.feeders as any)?.display_name ?? null }
            : null,
          unsubscribeUrl: unsubUrl,
        });

        return {
          from: FROM_EMAIL,
          to: sub.email,
          subject: `🐦 Your Weekly BirdWatch Report — ${weekLabel}`,
          html,
        };
      });

      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend batch error (${res.status}): ${errText}`);
      }

      sent += batch.length;
    }

    console.log(`Weekly digest sent to ${sent} subscribers.`);
    return new Response(JSON.stringify({ sent, detections: detections.length, weekLabel }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (err) {
    console.error('weekly-digest error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
