-- ════════════════════════════════════════════════════════════════════
--  Photos and clips for the teacher's question writer, from any span
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--  Asked for: "why can't the teacher choose older data when writing
--  questions? currently it only shows clips/photos from today."
--
--  It was never today. loadClassroomOwnPhotos called loadClassroomData,
--  which is pinned to CLASSROOM_WINDOW_DAYS = 14, so the picker showed a
--  fortnight. But it kept ONE shot per species and drew no date on any
--  thumbnail, so what reached the teacher was a dozen pictures with
--  nothing on screen to say when any of them was taken — which is the
--  same thing from their side, and a fair complaint either way.
--
--  ⚠ WHY A FUNCTION AND NOT A WIDER REST READ
--  Because of the arithmetic. On the test community a school year is
--  ~6,600 detections and essentially every one of them has both a photo
--  and a clip. Paging all of that into a modal to show forty thumbnails
--  is the same waste classroom_year_months was written to avoid, and it
--  would be worse here: private-feeder media arrives as private://
--  markers and every row fetched must then be signed. This returns the
--  few per species the picker can actually show — about 80 rows for a
--  whole year — and the client signs those.
--
--  ⚠ SECURITY INVOKER, NOT DEFINER, for exactly the reason given at
--  length in setup-classroom-year.sql: community_detections has RLS, the
--  client already reads these very rows over PostgREST, and running as
--  the caller means this returns what that read would return and not one
--  row more. It is a shortcut, not a new door. A definer here would hand
--  anon the pick of every photo in the table.
--
--  ⚠ THE EXCLUSION LIST IS A PARAMETER, same as the year function.
--  CM_NOT_BIRDS lives in community-classroom.js and is edited there.
--  A second copy in SQL would be a second thing to keep in step, and the
--  day they disagreed a teacher would be offered a photo of a squirrel
--  to build a bird question on.
--
--  ⚠ CONFIDENCE IS NORMALISED BEFORE IT IS SORTED ON. The feed has
--  shipped confidence on two scales — 0-1 and 0-100 — which is why the
--  client sorts through cmConfPct rather than the raw column. Sorting
--  the raw column here would put every 0-1 row below every 0-100 one, so
--  "the clearest photo of this bird" would quietly become "any photo
--  from the other firmware". Same guard, same reason.
--
--  PHOTOS AND CLIPS ARE RANKED SEPARATELY, not filtered out of one list.
--  A species' clearest still and its clearest clip are usually different
--  rows, and the picker offers them on two tabs.
-- ════════════════════════════════════════════════════════════════════

begin;

create or replace function classroom_media_picks(
    p_feeder_ids  uuid[],
    p_from        timestamptz,
    p_to          timestamptz,
    p_per_species integer default 4,
    p_exclude     text[]  default '{}'::text[]
)
returns json
language sql
security invoker
stable
set search_path to 'public'
as $function$
    with lim as (
        -- Clamped rather than trusted. The caller is the page, but a
        -- per_species of 500 would turn a cheap call into the full-table
        -- read this function exists to replace.
        select greatest(1, least(coalesce(p_per_species, 4), 12)) as n
    ),
    clean as (
        select id, feeder_id, species, detected_at, image_url, video_url,
               -- See the header: 0-1 and 0-100 both occur in the wild.
               case when confidence is null then -1
                    when confidence <= 1    then confidence * 100
                    else confidence end as conf
          from community_detections
         where feeder_id = any(p_feeder_ids)
           and detected_at >= p_from
           and detected_at <  p_to
           and coalesce(btrim(species), '') <> ''
           and lower(btrim(species)) <> all (coalesce(p_exclude, '{}'::text[]))
    ),
    shots as (
        select id, feeder_id, species, detected_at, image_url,
               row_number() over (partition by species
                                  order by conf desc, detected_at desc) as rn
          from clean
         where coalesce(image_url, '') <> ''
    ),
    reels as (
        select id, feeder_id, species, detected_at, video_url, image_url,
               row_number() over (partition by species
                                  order by conf desc, detected_at desc) as rn
          from clean
         where coalesce(video_url, '') <> ''
    )
    select json_build_object(
        'photos', coalesce((
            select json_agg(json_build_object(
                       'id',          s.id,
                       'feeder_id',   s.feeder_id,
                       'species',     s.species,
                       'detected_at', s.detected_at,
                       'image_url',   s.image_url)
                   order by s.species, s.rn)
              from shots s, lim where s.rn <= lim.n), '[]'::json),
        'clips', coalesce((
            select json_agg(json_build_object(
                       'id',          r.id,
                       'feeder_id',   r.feeder_id,
                       'species',     r.species,
                       'detected_at', r.detected_at,
                       'video_url',   r.video_url,
                       'image_url',   r.image_url)
                   order by r.species, r.rn)
              from reels r, lim where r.rn <= lim.n), '[]'::json)
    );
$function$;

-- Mirrors the table: both roles may call it, and RLS decides what comes
-- back. A revoke from public would mean nothing here — the function
-- grants nothing the caller does not already have.
grant execute on function
      classroom_media_picks(uuid[], timestamptz, timestamptz, integer, text[])
      to anon, authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select jsonb_pretty(classroom_media_picks(
--             array['<feeder id>']::uuid[],
--             '2026-08-01', '2027-08-01', 4,
--             array['deer','squirrel','human','unknown'])::jsonb);
--
--  No species may appear more than p_per_species times in 'photos', and
--  the same again in 'clips'. Every row must carry a non-empty url of
--  its own kind.
--
--  And as anon it must return only what the feed shows anonymously: run
--  it with `set local role anon;` and compare the species it offers
--  against
--    select distinct species from community_detections where feeder_id = ...;
--  run under the same role.
-- ════════════════════════════════════════════════════════════════════
