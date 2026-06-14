import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Parse a Supabase Storage URL into { bucket, path }. Returns null for URLs
// that do not look like Supabase storage (e.g. detections hosted elsewhere).
// Handles public, signed, and authenticated object URLs as well as the
// render/image transform endpoint.
function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(
      /\/storage\/v1\/(?:object|render\/image)\/(?:public|sign|authenticated)\/(.+)$/
    );
    if (!m) return null;
    const rest = m[1]; // "{bucket}/{...path}"
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return null;
    const bucket = rest.substring(0, slashIdx);
    const path   = decodeURIComponent(rest.substring(slashIdx + 1));
    return { bucket, path };
  } catch {
    return null;
  }
}

async function removeStorageFile(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const parsed = parseStorageUrl(url);
  if (!parsed) {
    console.warn(`Skipping storage cleanup for non-Supabase URL: ${url}`);
    return;
  }
  const { error } = await supabase.storage
    .from(parsed.bucket)
    .remove([parsed.path]);
  if (error) {
    console.error(`Failed to remove ${parsed.bucket}/${parsed.path}:`, error.message);
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

  try {
    const body = await req.json();
    const { action, email, password, detection_id, feeder_id } = body;

    // Per-action required-field validation — feeder-delete uses feeder_id, the
    // detection actions use detection_id, but all three need an action + creds.
    if (!action || !email || !password) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: corsHeaders }
      );
    }
    if (action === 'delete_feeder') {
      if (!feeder_id) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields' }),
          { status: 400, headers: corsHeaders }
        );
      }
    } else if (!detection_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate moderator credentials via the existing login RPC
    const { data: modData, error: loginErr } = await supabase.rpc('moderator_login', {
      p_email: email,
      p_password: password,
    });
    if (loginErr || !modData || !modData.id) {
      return new Response(
        JSON.stringify({ error: 'Invalid moderator credentials' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // ── ACTION: delete_feeder ────────────────────────────────────────────────
    // Cleanup path for the duplicate-feeder problem (a config reset on the
    // server used to spawn a fresh device_key and leave the old row stranded
    // under the same display_name). The accompanying RPC
    // moderator_delete_feeder does the DB side; we clear the storage files
    // here first so they don't become orphaned blobs.
    if (action === 'delete_feeder') {
      const { data: detections, error: listErr } = await supabase
        .from('community_detections')
        .select('image_url, video_url')
        .eq('feeder_id', feeder_id);
      if (listErr) {
        return new Response(
          JSON.stringify({ error: 'Failed to list feeder detections: ' + listErr.message }),
          { status: 500, headers: corsHeaders }
        );
      }
      for (const d of (detections ?? [])) {
        await removeStorageFile(d.image_url);
        await removeStorageFile(d.video_url);
      }

      const { data: result, error: rpcErr } = await supabase.rpc('moderator_delete_feeder', {
        p_email:     email,
        p_password:  password,
        p_feeder_id: feeder_id,
      });
      if (rpcErr) {
        return new Response(
          JSON.stringify({ error: rpcErr.message }),
          { status: 400, headers: corsHeaders }
        );
      }
      return new Response(
        JSON.stringify({
          success:            true,
          feeder_deleted:     result?.feeder_deleted ?? false,
          detections_deleted: result?.detections_deleted ?? 0,
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // Fetch the detection's current media URLs so we know what to remove
    const { data: detection, error: fetchErr } = await supabase
      .from('community_detections')
      .select('id, image_url, video_url')
      .eq('id', detection_id)
      .maybeSingle();

    if (fetchErr) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch detection: ' + fetchErr.message }),
        { status: 500, headers: corsHeaders }
      );
    }
    if (!detection) {
      return new Response(
        JSON.stringify({ error: 'Detection not found' }),
        { status: 404, headers: corsHeaders }
      );
    }

    // ── ACTION: update (edit detection, optionally clearing photo/video) ──────
    if (action === 'update') {
      const { species, rarity, delete_image, delete_video } = body;

      if (delete_image) await removeStorageFile(detection.image_url);
      if (delete_video) await removeStorageFile(detection.video_url);

      const { error } = await supabase.rpc('moderator_update_detection', {
        p_email:         email,
        p_password:      password,
        p_detection_id:  detection_id,
        p_species:       species ?? null,
        p_rarity:        rarity ?? null,
        p_delete_image:  !!delete_image,
        p_delete_video:  !!delete_video,
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 400, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: corsHeaders }
      );
    }

    // ── ACTION: delete (remove whole detection + its media files) ─────────────
    if (action === 'delete') {
      await removeStorageFile(detection.image_url);
      await removeStorageFile(detection.video_url);

      const { error } = await supabase.rpc('moderator_delete_detection', {
        p_email:        email,
        p_password:     password,
        p_detection_id: detection_id,
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 400, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action. Use "update", "delete", or "delete_feeder".' }),
      { status: 400, headers: corsHeaders }
    );

  } catch (err) {
    console.error('moderator-delete-media error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
