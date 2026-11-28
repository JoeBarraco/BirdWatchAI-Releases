-- ════════════════════════════════════════════════════════════════════════
--  Non-bird visitors on the community feed
-- ════════════════════════════════════════════════════════════════════════
--
--  Feeders on BirdWatchAI Server 0.5.468+ can identify non-bird visitors
--  (squirrels, raccoons, deer, cats...) when the owner turns on
--  Settings → Identification → "Also identify non-bird visitors". Those rows
--  must be told apart from birds here, or the site would count a squirrel as a
--  bird species in every total, leaderboard and life list.
--
--  1. community_detections.is_bird, default true. Every row already here is a
--     bird (or an owner's hand-correction, which this does not touch), and a
--     feeder that never sends the flag keeps writing birds.
--  2. community_detection_insert gains p_is_bird (default true). The feeder only
--     sends it for visitors, so a bird's call is unchanged. And a feeder that
--     sends it to a backend WITHOUT this migration gets "function not found"
--     (PostgREST matches by parameter names) and deliberately does not share the
--     visitor, rather than posting it as a bird.
--
--  Why DROP + CREATE rather than CREATE OR REPLACE: adding a parameter is a new
--  signature, so OR REPLACE would leave the old function alongside the new one.
--  Two overloads that both accept the old argument list make every existing
--  feeder's call ambiguous ("could not choose the best candidate function").
--
--  Grants: same as before (anon, authenticated, service_role), and PUBLIC
--  revoked explicitly. Postgres grants EXECUTE to PUBLIC on every new function,
--  and a revoke that names only anon/authenticated would not remove it.
--
--  Idempotent: safe to run twice.
-- ════════════════════════════════════════════════════════════════════════

alter table community_detections
  add column if not exists is_bird boolean not null default true;

comment on column community_detections.is_bird is
  'False for a non-bird visitor (squirrel, raccoon, deer, cat...) identified by a feeder with "identify non-bird visitors" on. Site totals, species counts and life lists use birds only.';

drop function if exists community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text, text);

create function community_detection_insert(
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
  p_zip_code    text             default null,
  p_write_token text             default null,
  p_is_bird     boolean          default true
) returns uuid
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
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_detection_insert: write token required or incorrect';
  end if;

  insert into community_detections
    (feeder_id, species, confidence, detected_at, local_id, rarity,
     temperature, image_url, video_url, latitude, longitude, zip_code, is_bird)
  values
    (fid, p_species, p_confidence, p_detected_at, p_local_id, p_rarity,
     p_temperature, p_image_url, p_video_url, p_latitude, p_longitude, p_zip_code,
     coalesce(p_is_bird, true))
  returning id into rid;

  return rid;
end;
$$;

revoke execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text, text, boolean) from public;
grant execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text, text, boolean) to anon, authenticated, service_role;
