-- ════════════════════════════════════════════════════════════════════
-- Patch a detection by (feeder, local_id) — the last write that had no
-- proof of ownership.
--
-- Additive and safe to run at any time. Run it BEFORE
-- close-anon-detection-writes.sql, which is what actually shuts the
-- direct path.
--
-- WHY THIS EXISTS SEPARATELY FROM community_detection_patch
--
-- ShareClipAsync attaches a recorded clip to a sighting that was shared
-- moments earlier. It does not have the community row's id — it never
-- looked one up — so it patches by (feeder_id, local_id) instead. That
-- left it as the only detection write still going direct and unscoped
-- after the rest moved onto community_detection_patch. Rather than make
-- the caller do a lookup round trip on every clip, this resolves the row
-- the same way it always did, server-side, with ownership checked.
--
-- Scope is the caller's OWN feeder only, deliberately not widened by
-- display_name the way patch/delete are: local_id is unique per feeder,
-- and a stale same-named identity would otherwise collide. Same
-- reasoning as the insert path.
-- ════════════════════════════════════════════════════════════════════

create or replace function community_detection_patch_by_local_id(
  p_device_key  text,
  p_local_id    text,
  p_patch       jsonb,
  p_write_token text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  n   integer;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_patch_by_local_id: device_key is required';
  end if;
  if p_local_id is null or length(trim(p_local_id)) = 0 then
    return 0;
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'community_detection_patch_by_local_id: patch must be a json object';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) as k
    where k not in ('species', 'rarity', 'image_url', 'video_url')
  ) then
    raise exception 'community_detection_patch_by_local_id: unsupported key in patch';
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return 0;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_detection_patch_by_local_id: write token required or incorrect';
  end if;

  update community_detections d
     set species   = case when p_patch ? 'species'   then p_patch->>'species'   else d.species   end,
         rarity    = case when p_patch ? 'rarity'    then p_patch->>'rarity'    else d.rarity    end,
         image_url = case when p_patch ? 'image_url' then p_patch->>'image_url' else d.image_url end,
         video_url = case when p_patch ? 'video_url' then p_patch->>'video_url' else d.video_url end
   where d.feeder_id = fid
     and d.local_id  = p_local_id;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function community_detection_patch_by_local_id(text, text, jsonb, text) from public;
grant  execute on function community_detection_patch_by_local_id(text, text, jsonb, text) to anon, authenticated;
