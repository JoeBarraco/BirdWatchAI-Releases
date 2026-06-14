// Edge function: purge-expired-media
//
// Sweeps community_detections for rows whose media is past its feeder's
// subscription-tier retention window (free=7d, plus=90d, pro=365d), then
// removes the corresponding objects from Supabase Storage. The DB row stays
// (so stats / life-list continuity is preserved) but image_url and video_url
// get nulled out and media_purged_at gets stamped — the community feed
// renders a "📷 photo expired — upgrade to keep future photos" placeholder
// for those rows.
//
// Two ways to invoke:
//   * Admin-triggered (POST { email, password }) — manual cleanup from the
//     mod console; validates that the caller is an admin moderator.
//   * Scheduled (Authorization: Bearer <CRON_SECRET>) — when wired up via
//     pg_cron or a scheduled invoke, the function lets the request through
//     without admin creds. Set CRON_SECRET as a function secret.
//
// Safe to re-run: the underlying RPC selects only rows whose media is still
// present (image_url or video_url not null), so a second invocation in
// quick succession is a no-op.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET           = Deno.env.get('CRON_SECRET') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Reuse the parser pattern from moderator-delete-media so a Supabase Storage
// URL (public, signed, authenticated, or transform endpoint) round-trips to
// the { bucket, path } pair the storage API expects.
function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(
      /\/storage\/v1\/(?:object|render\/image)\/(?:public|sign|authenticated)\/(.+)$/
    );
    if (!m) return null;
    const rest = m[1];
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return null;
    return {
      bucket: rest.substring(0, slashIdx),
      path:   decodeURIComponent(rest.substring(slashIdx + 1)),
    };
  } catch {
    return null;
  }
}

async function removeStorageFile(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const parsed = parseStorageUrl(url);
  if (!parsed) return; // detection hosted elsewhere — nothing to remove
  const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.path]);
  if (error) {
    console.warn(`purge: failed to remove ${parsed.bucket}/${parsed.path}:`, error.message);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Auth: either a scheduled cron call with the shared secret, or an admin
  // moderator with email+password. Reject everything else.
  const authHeader = req.headers.get('Authorization') ?? '';
  const isCron = CRON_SECRET.length > 0 && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isCron) {
    let email = '', password = '';
    try {
      const body = await req.json();
      email    = body?.email    ?? '';
      password = body?.password ?? '';
    } catch {
      return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: corsHeaders });
    }
    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'Admin credentials required' }), { status: 401, headers: corsHeaders });
    }
    const { data: modData, error: loginErr } = await supabase.rpc('moderator_login', { p_email: email, p_password: password });
    if (loginErr || !modData || !modData.id) {
      return new Response(JSON.stringify({ error: 'Invalid moderator credentials' }), { status: 401, headers: corsHeaders });
    }
    if (modData.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: corsHeaders });
    }
  }

  try {
    // Mark + return expired rows in one shot via the RPC, then walk them to
    // remove the storage objects. The RPC is the one place the retention
    // policy is encoded (free/plus/pro intervals) so it stays in sync with
    // the schema migration.
    const { data: rows, error: rpcErr } = await supabase.rpc('purge_expired_feeder_media');
    if (rpcErr) {
      return new Response(JSON.stringify({ error: rpcErr.message }), { status: 500, headers: corsHeaders });
    }

    let imagesRemoved = 0;
    let videosRemoved = 0;
    for (const r of (rows ?? [])) {
      if (r.image_url) { await removeStorageFile(r.image_url); imagesRemoved++; }
      if (r.video_url) { await removeStorageFile(r.video_url); videosRemoved++; }
    }

    return new Response(
      JSON.stringify({
        success:        true,
        rows_purged:    rows?.length ?? 0,
        images_removed: imagesRemoved,
        videos_removed: videosRemoved,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error('purge-expired-media error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
