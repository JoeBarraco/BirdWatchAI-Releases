-- ============================================================================
--  setup-detection-location.sql
--  Pin every sighting to the place it happened.
-- ============================================================================
--
--  THE PROBLEM
--
--  community_detections has latitude/longitude/zip_code columns, but the server
--  stopped populating them on 2026-06-18. Only 395 legacy rows carry their own
--  coordinates; the other ~9,599 are null, and the dashboard resolves those
--  through the feeder (see detectionMapPoint in docs/js/community-views.js and
--  foldFeederZip in docs/js/community-core.js).
--
--  That means location is currently a property of the FEEDER, not of the
--  sighting. Move a feeder and update its coordinates, and every past detection
--  silently moves with it — last winter's birds get mapped to the new address.
--  Worse, it would only move the null ones: the 395 stamped rows would stay put,
--  splitting one feeder's history across two map clusters with no explanation.
--
--  THE FIX (this file, plus the server-side stamp shipped alongside it)
--
--  A sighting belongs to the place it happened. Stamp the location onto the row
--  at write time and never recompute it.
--
--    1. Backfill the null rows from their feeder's current position. This is
--       sound precisely because no feeder has moved yet — the current position
--       IS where those sightings happened. It is only true once, which is why
--       this runs now rather than later.
--    2. Stamp on insert for any client that doesn't send coordinates. The
--       server now sends them, but older builds in the wild (0.3.x/0.4.x) do
--       not, and without this they would keep writing rows that drift.
--
--  Both are hole-filling only: a row that already carries coordinates is never
--  overwritten. That is what keeps a moved feeder's history where it belongs.
--
--  Idempotent — safe to run more than once.
--
--  NOTE ON communities.suppress_location: that flag is stored but not currently
--  enforced anywhere. It is NOT weakened by this change — RLS already scopes
--  community_detections and feeders to the same audience, so these coordinates
--  are visible to exactly the people who could already read the feeder's. When
--  suppression IS implemented, it must mask community_detections.latitude/
--  longitude/zip_code as well as the feeders join, or it will leak around it.
-- ============================================================================


-- ----------------------------------------------------------------------------
--  1. Backfill: existing rows inherit their feeder's current position, once.
-- ----------------------------------------------------------------------------

update community_detections d
   set latitude  = f.latitude,
       longitude = f.longitude,
       zip_code  = coalesce(d.zip_code, f.zip_code)
  from feeders f
 where d.feeder_id = f.id
   and f.latitude is not null
   and f.longitude is not null
   and (d.latitude is null or d.longitude is null);


-- ----------------------------------------------------------------------------
--  2. Stamp on insert, for clients that don't send a location themselves.
-- ----------------------------------------------------------------------------
--  security definer so the lookup can read the feeder row regardless of the
--  caller's RLS scope — a detection for a private feeder must still get stamped.
--  search_path is pinned so the function can't be redirected via a shadowing
--  schema. It only ever reads feeders and fills nulls on the row being written.

create or replace function community_detection_stamp_location()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- The client's own value always wins: it knows where the feeder stood when
    -- the bird was actually seen, which after a move is not where it stands now.
    if new.latitude is null or new.longitude is null then
        select f.latitude, f.longitude
          into new.latitude, new.longitude
          from feeders f
         where f.id = new.feeder_id;
    end if;

    if new.zip_code is null then
        select f.zip_code
          into new.zip_code
          from feeders f
         where f.id = new.feeder_id;
    end if;

    return new;
end;
$$;

drop trigger if exists trg_community_detection_stamp_location on community_detections;
create trigger trg_community_detection_stamp_location
    before insert on community_detections
    for each row execute function community_detection_stamp_location();

-- Postgres grants EXECUTE to PUBLIC on every new function, and every role is a
-- member of PUBLIC — so revoking from anon/authenticated alone leaves a
-- security definer function callable through PostgREST with the published anon
-- key. Revoke from public FIRST; the rest are belt-and-braces. (This one is a
-- trigger function and takes no arguments, so a direct call is inert either
-- way, but the habit is what keeps the next one safe.)
revoke execute on function community_detection_stamp_location() from public;
revoke execute on function community_detection_stamp_location() from anon;
revoke execute on function community_detection_stamp_location() from authenticated;


-- ----------------------------------------------------------------------------
--  3. Verify. Expect: still_missing = 0, and no feeder split across locations.
-- ----------------------------------------------------------------------------

select count(*) filter (where latitude is null)     as still_missing,
       count(*) filter (where latitude is not null) as located,
       count(*)                                     as total
  from community_detections;

-- One row per feeder per distinct location it has recorded from. Today every
-- feeder should show exactly one row. After a genuine move a feeder will show
-- two — and that is correct, not a bug: the history stayed where it happened.
select feeder_id,
       round(latitude::numeric, 4)  as lat,
       round(longitude::numeric, 4) as lon,
       count(*)                     as detections,
       min(detected_at)::date       as first_seen,
       max(detected_at)::date       as last_seen
  from community_detections
 where latitude is not null
 group by feeder_id, round(latitude::numeric, 4), round(longitude::numeric, 4)
 order by feeder_id, first_seen;
