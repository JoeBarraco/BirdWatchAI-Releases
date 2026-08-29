-- ════════════════════════════════════════════════════════════════════
-- Detection-write RPCs (device_key authenticated)
--
-- Step 1 of closing the anon-write hole on community_detections. Run
-- this AFTER setup-communities.sql (it depends on community_feeder_scope
-- from that file's section 7).
--
-- ⚠ READ THIS BEFORE ASSUMING THIS FILE FIXES ANYTHING.
--
-- Today the write policies on community_detections are qual=true for
-- anon:
--
--     create policy "Anon can delete detections" on community_detections
--       for delete to anon, authenticated using (true);
--
-- so the publishable key in docs/js/community-core.js can insert, edit
-- and delete ANY row belonging to ANY feeder. That is not theoretical —
-- on 2026-08-29 a plain DELETE carrying only that key removed 73 rows
-- belonging to a feeder the caller did not own.
--
-- setup-communities.sql (§6) anticipated the fix as "route those writes
-- through the device_key RPCs and then narrow these". Its premise was
-- that "the server holds the device_key; it is the only proof of feeder
-- ownership available off-device". THAT PREMISE IS CURRENTLY FALSE:
-- device_key is a plain readable column on feeders, and the feeders
-- SELECT policy exposes every public feeder's row, so
--
--     GET /rest/v1/feeders?select=display_name,device_key
--
-- with the anon key returns every device key in the system. The key is
-- also embedded in every public storage URL
-- (detection-images/<device_key>/…), so it leaks twice over.
--
-- Consequence: adding these RPCs does NOT by itself close the hole. An
-- attacker can read a device key and call them. They are the
-- PREREQUISITE, not the fix. The sequence is:
--
--   1. (this file) add the write RPCs                    — additive, safe
--   2. ship a server that prefers them                   — additive, safe
--   3. stop exposing device_key to anon                  — needs every
--      client on a build that uses the RPCs, because the direct-SELECT
--      fallbacks filter on device_key and a column you cannot SELECT
--      cannot be used in a WHERE clause
--   4. wait out the upgrade window (WinForms installs included)
--   5. narrow the qual=true write policies to service_role only
--
-- Only after step 5 is the hole shut. Steps 3 and 5 have a
-- compatibility cliff; steps 1 and 2 do not.
--
-- Residual weakness to fix later, tracked here so it is not lost a
-- second time: the patch/delete RPCs scope by community_feeder_scope(…,
-- 'name'), i.e. every feeder sharing the caller's display_name. That
-- matches what the server does today (edit/delete propagation across
-- stale identities left behind by config resets), but it means two
-- feeders with the same display_name can edit each other's rows.
-- Narrowing it needs a real owner column on feeders first.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- Insert one sighting.
--
-- Scope is the caller's OWN feeder only — deliberately NOT widened by
-- display_name the way patch/delete are. local_id values are unique
-- per-feeder, and a previous install's stale rows sharing a display_name
-- would otherwise collide on every live share. This mirrors the
-- idempotency scope in ShareAsync.
--
-- Returns the new row's id, or null when the device_key matches no
-- feeder (caller should treat that as "not registered yet").
-- ────────────────────────────────────────────────────────────────────
create or replace function community_detection_insert(
  p_device_key  text,
  p_species     text,
  p_confidence  double precision,
  p_detected_at timestamptz,
  p_local_id    text,
  p_rarity      text             default null,
  p_temperature double precision default null,
  p_image_url   text             default null,
  p_video_url   text             default null,
  p_latitude    double precision default null,
  p_longitude   double precision default null,
  p_zip_code    text             default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  rid uuid;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_insert: device_key is required';
  end if;
  if p_species is null or p_detected_at is null then
    raise exception 'community_detection_insert: species and detected_at are required';
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return null;
  end if;

  insert into community_detections
    (feeder_id, species, confidence, detected_at, local_id, rarity,
     temperature, image_url, video_url, latitude, longitude, zip_code)
  values
    (fid, p_species, p_confidence, p_detected_at, p_local_id, p_rarity,
     p_temperature, p_image_url, p_video_url, p_latitude, p_longitude, p_zip_code)
  returning id into rid;

  return rid;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Patch existing rows the caller owns.
--
-- p_patch is a jsonb object; only these keys are accepted:
--   species, rarity, image_url, video_url
-- Anything else raises rather than being silently dropped, so a typo
-- surfaces instead of quietly not applying.
--
-- Uses `?` (key-present) rather than "is not null" so a caller can
-- deliberately CLEAR a column: {"rarity": null} sets rarity to null,
-- while omitting the key leaves it alone. UpdateRarityAsync relies on
-- that distinction — passing null there means "back to unknown".
--
-- Columns NOT patchable by design: feeder_id (would let a caller
-- reassign a row to another feeder), detected_at, confidence, local_id.
--
-- Returns the number of rows actually updated.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_detection_patch(
  p_device_key text,
  p_ids        uuid[],
  p_patch      jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_patch: device_key is required';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'community_detection_patch: patch must be a json object';
  end if;

  if exists (
    select 1 from jsonb_object_keys(p_patch) as k
    where k not in ('species', 'rarity', 'image_url', 'video_url')
  ) then
    raise exception 'community_detection_patch: unsupported key in patch';
  end if;

  update community_detections d
     set species   = case when p_patch ? 'species'   then p_patch->>'species'   else d.species   end,
         rarity    = case when p_patch ? 'rarity'    then p_patch->>'rarity'    else d.rarity    end,
         image_url = case when p_patch ? 'image_url' then p_patch->>'image_url' else d.image_url end,
         video_url = case when p_patch ? 'video_url' then p_patch->>'video_url' else d.video_url end
   where d.id = any(p_ids)
     and d.feeder_id in (select community_feeder_scope(p_device_key, 'name'));

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Delete rows the caller owns. Returns the number actually removed —
-- a caller passing ids it does not own gets a count lower than it asked
-- for rather than an error, which is what DeleteSharedAsync and the
-- reconcile sweep want (both are best-effort).
--
-- Note this does NOT remove the row's storage objects. Nothing does:
-- the buckets refuse DELETE to anon, so every deleted detection has
-- always orphaned its image and clip. Reclaiming that needs a
-- service-role sweep and is out of scope here.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_detection_delete(
  p_device_key text,
  p_ids        uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_delete: device_key is required';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  delete from community_detections d
   where d.id = any(p_ids)
     and d.feeder_id in (select community_feeder_scope(p_device_key, 'name'));

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Grants.
--
-- The revokes are the load-bearing half, not the grants. Postgres
-- grants EXECUTE to PUBLIC on every new function, and every role is a
-- member of PUBLIC — so a file that only says "grant to anon" leaves
-- the function callable by everyone whatever it revokes from anon
-- later. Three security-definer helpers shipped that way on this
-- database and were reachable through PostgREST for four months.
-- Revoke from PUBLIC first, then grant deliberately.
-- ────────────────────────────────────────────────────────────────────
revoke execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text) from public;
revoke execute on function community_detection_patch(text, uuid[], jsonb)  from public;
revoke execute on function community_detection_delete(text, uuid[])        from public;

grant execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function community_detection_patch(text, uuid[], jsonb)   to anon, authenticated;
grant execute on function community_detection_delete(text, uuid[])         to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- Verify. Expect exactly the three functions below, each with
-- has_function_privilege('public', …) = false.
--
--   select proname,
--          has_function_privilege('public', oid, 'EXECUTE') as public_can_execute,
--          has_function_privilege('anon',   oid, 'EXECUTE') as anon_can_execute
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname like 'community_detection_%';
--
-- And a live smoke test — a bogus device key must change nothing:
--
--   select community_detection_delete('00000000-0000-0000-0000-000000000000',
--                                     array['<some real row id>']::uuid[]);
--   -- expect: 0
-- ────────────────────────────────────────────────────────────────────
