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

// Private feeders' media has no readable URL, so the server stores a marker —
// private://bucket/path — rather than a storage URL. parseStorageUrl can't see
// those, which meant private media was previously skipped by cleanup and left
// behind as orphaned blobs. Resolve both shapes in one place.
const PRIVATE_MARKER_PREFIX = 'private://';

function resolveStorageRef(url: string): { bucket: string; path: string } | null {
  if (url.startsWith(PRIVATE_MARKER_PREFIX)) {
    const rest  = url.slice(PRIVATE_MARKER_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    return { bucket: rest.substring(0, slash), path: rest.substring(slash + 1) };
  }
  return parseStorageUrl(url);
}

// Render a freshly uploaded object back into the shape the row already used, so
// nothing downstream has to learn a new convention: a public URL for a public
// bucket, a private:// marker for a private one (the browser exchanges the
// marker for a short-lived signed URL, and that signing is the access check).
function storedUrlFor(bucket: string, path: string): string {
  if (bucket.endsWith('-private')) {
    return `${PRIVATE_MARKER_PREFIX}${bucket}/${path}`;
  }
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

async function removeStorageFile(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const parsed = resolveStorageRef(url);
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

// ── Caption re-burn ───────────────────────────────────────────────────────────
//
// A detection photo carries its caption as burned-in pixels (species,
// confidence, time, rarity), written by the feeder at detection time — so a
// moderator correcting the species leaves the image contradicting the row. The
// browser redraws the strip on a canvas, mirroring the geometry the server
// build's SnapshotRewriteService uses, and posts the re-encoded JPEG here:
// storage RLS is insert-only for the anon key and image_url isn't anon-writable
// either, so only the service role can land the new object and repoint the row.

const MAX_REBURN_BYTES = 12 * 1024 * 1024;

function decodeBase64(b64: string): Uint8Array {
  // Tolerate a data: prefix in case a future caller sends canvas.toDataURL().
  const comma = b64.indexOf(',');
  const raw = b64.startsWith('data:') && comma > 0 ? b64.slice(comma + 1) : b64;
  const bin = atob(raw.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Sibling path with a version tag: re-uploading over the original key would
// 4xx against insert-only RLS, and a new key also sidesteps CDN and
// service-worker caching of the old bytes. Any previous -mod tag is stripped so
// a tenth correction doesn't accumulate a tenth suffix.
function reburnPath(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir   = slash >= 0 ? path.slice(0, slash + 1) : '';
  const file  = slash >= 0 ? path.slice(slash + 1) : path;
  const dot   = file.lastIndexOf('.');
  const ext   = dot > 0 ? file.slice(dot) : '.jpg';
  const base  = (dot > 0 ? file.slice(0, dot) : file).replace(/-mod\d+$/, '');
  return `${dir}${base}-mod${Date.now()}${ext}`;
}

// Returns what to store in image_url, or null when the re-burn couldn't be
// landed. Never throws: a failed re-caption must not cost the moderator their
// species correction.
async function uploadReburn(
  currentUrl: string | null | undefined,
  imageB64: string,
): Promise<{ stored: string; bucket: string; path: string } | null> {
  if (!currentUrl) return null;

  const ref = resolveStorageRef(currentUrl);
  if (!ref) {
    console.warn(`Re-burn skipped: image_url is not Supabase storage (${currentUrl})`);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageB64);
  } catch (err) {
    console.error('Re-burn skipped: base64 decode failed:', String(err));
    return null;
  }

  if (!bytes.length || bytes.length > MAX_REBURN_BYTES) {
    console.error(`Re-burn skipped: payload of ${bytes.length} bytes is out of range.`);
    return null;
  }
  // A moderator session is the only gate here, so require the payload to
  // actually be a JPEG rather than letting this double as a way to park
  // arbitrary files in a media bucket.
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    console.error('Re-burn skipped: payload is not a JPEG.');
    return null;
  }

  const newPath = reburnPath(ref.path);
  const { error } = await supabase.storage
    .from(ref.bucket)
    .upload(newPath, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) {
    console.error(`Re-burn upload to ${ref.bucket}/${newPath} failed:`, error.message);
    return null;
  }

  return { stored: storedUrlFor(ref.bucket, newPath), bucket: ref.bucket, path: newPath };
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
    const { action, token, detection_id, feeder_id,
            source_feeder_id, target_feeder_id } = body;

    // Per-action required-field validation — feeder-level actions use
    // feeder_id (delete) or source/target ids (merge), detection actions
    // use detection_id, but all need an action + a session token.
    if (!action || !token) {
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
    } else if (action === 'merge_feeder') {
      if (!source_feeder_id || !target_feeder_id) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields' }),
          { status: 400, headers: corsHeaders }
        );
      }
      if (source_feeder_id === target_feeder_id) {
        return new Response(
          JSON.stringify({ error: 'Source and target must be different feeders' }),
          { status: 400, headers: corsHeaders }
        );
      }
    } else if (!detection_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Resolve the moderator session token. A moderator's password never reaches
    // this function — moderator_login is the only thing that ever sees it — so
    // the worst a captured request can replay is a short-lived, revocable
    // session rather than a reusable admin credential.
    const { data: modData, error: sessionErr } = await supabase.rpc('moderator_session_lookup', {
      p_token: token,
    });
    if (sessionErr || !modData || !modData.id) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired moderator session' }),
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
        p_token:     token,
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

    // ── ACTION: merge_feeder ─────────────────────────────────────────────────
    // Consolidate two feeder rows that represent the same physical feeder
    // (different activation keys, same display name, etc.) by reassigning the
    // source's community detections to the target and deleting the now-empty
    // source row. Storage is intentionally NOT touched — every detection's
    // image_url/video_url already points at the correct blob; only the
    // feeder_id foreign key changes.
    if (action === 'merge_feeder') {
      const { data: result, error: rpcErr } = await supabase.rpc('moderator_merge_feeder', {
        p_token:     token,
        p_source_id: source_feeder_id,
        p_target_id: target_feeder_id,
      });
      if (rpcErr) {
        return new Response(
          JSON.stringify({ error: rpcErr.message }),
          { status: 400, headers: corsHeaders }
        );
      }
      return new Response(
        JSON.stringify({
          success:          true,
          source_deleted:   result?.source_deleted ?? false,
          detections_moved: result?.detections_moved ?? 0,
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
      const { species, rarity, delete_image, delete_video, image_b64 } = body;

      if (delete_image) await removeStorageFile(detection.image_url);
      if (delete_video) await removeStorageFile(detection.video_url);

      // Upload the re-captioned photo BEFORE the row edit, so a storage failure
      // is just "no re-burn" rather than a row whose image_url points at
      // something that doesn't exist. Deleting the photo wins over re-burning
      // it, and a caller asking for both is confused rather than malicious.
      const reburn = (image_b64 && !delete_image)
        ? await uploadReburn(detection.image_url, image_b64)
        : null;

      const { error } = await supabase.rpc('moderator_update_detection', {
        p_token:         token,
        p_detection_id:  detection_id,
        p_species:       species ?? null,
        p_rarity:        rarity ?? null,
        p_delete_image:  !!delete_image,
        p_delete_video:  !!delete_video,
      });

      if (error) {
        // The species edit is the point of the call; if it failed, the object we
        // just uploaded is an orphan nothing will ever reference.
        if (reburn) await removeStorageFile(storedUrlFor(reburn.bucket, reburn.path));
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 400, headers: corsHeaders }
        );
      }

      // image_url isn't part of the RPC's contract, so repoint it directly. The
      // session token was already validated above, which is the same gate the
      // RPC applies.
      let imageUpdated = false;
      if (reburn) {
        const { error: urlErr } = await supabase
          .from('community_detections')
          .update({ image_url: reburn.stored })
          .eq('id', detection_id);
        if (urlErr) {
          console.error('Re-burn: image_url update failed:', urlErr.message);
          await removeStorageFile(storedUrlFor(reburn.bucket, reburn.path));
        } else {
          imageUpdated = true;
          // Only now is the old blob unreferenced.
          await removeStorageFile(detection.image_url);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          ...(image_b64 && !delete_image
            ? { image_updated: imageUpdated, image_url: imageUpdated ? reburn!.stored : null }
            : {}),
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    // ── ACTION: delete (remove whole detection + its media files) ─────────────
    if (action === 'delete') {
      await removeStorageFile(detection.image_url);
      await removeStorageFile(detection.video_url);

      const { error } = await supabase.rpc('moderator_delete_detection', {
        p_token:        token,
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
      JSON.stringify({ error: 'Invalid action. Use "update", "delete", "delete_feeder", or "merge_feeder".' }),
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
