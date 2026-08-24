-- ============================================================================
--  setup-detection-map-points.sql
--  A pre-aggregated feed for the community map.
-- ============================================================================
--
--  STATUS: BUILT AND TESTED, NOT WIRED UP. Nothing loads this view yet.
--
--  It was written to fix the 60-marker map, but the real cause turned out to be
--  a one-word omission -- 'map' was missing from the `needsAll` list in
--  community-core.js, the list that already named stats, gallery and clips --
--  and the map now loads the full set exactly as those three always have. That
--  fix shipped separately and needs no SQL.
--
--  What survives is the measurement below: every full-set view on this site
--  pulls ~1.46 MB to render, and this view answers the map's share of that in
--  76 KB. That makes it an ingredient for a SITE-WIDE payload reduction rather
--  than a map fix -- wiring it up for the map alone would add a second data
--  path while stats, gallery and clips kept paying full price. Kept here so the
--  analysis isn't lost when that question is picked up properly.
--
--  THE PROBLEM IT WAS WRITTEN FOR
--
--  renderMap() plots `allDetections` -- the feed's currently loaded page. That
--  page is PAGE_SIZE = 60 rows, so the map drew 60 of 10,011 detections and
--  every marker's count was wrong by three orders of magnitude. Nothing in the
--  UI said so; the map simply looked sparse, and grew if you happened to click
--  "Load more" first.
--
--  Fetching all 10,011 rows instead does work -- measured at 11 requests,
--  1.46 MB and 681 ms -- but it is a poor trade, because the map collapses
--  those 10,011 rows into just 33 markers. That is 1.46 MB downloaded to draw
--  33 dots, on a phone, growing linearly forever. PostgREST's own aggregate
--  support would have solved it without any SQL, but it is disabled on this
--  project (PGRST123: "Use of aggregate functions is not allowed").
--
--  THE SHAPE
--
--  Group server-side to (location, species, rarity, day) and let the browser
--  fetch the summary instead of the rows. Measured on today's data:
--
--      raw rows            10,011   1,461 KB   11 requests
--      grouped by day         971      76 KB    1 request
--
--  Day granularity is the smallest grouping that still answers every period
--  button (Today / Week / Month / Year / All) from one cached fetch, so
--  switching periods costs nothing after the first load. It also scales on
--  distinct combinations rather than on detection count: a feeder recording ten
--  times as often adds no rows at all, only larger counts.
--
--  WHAT IT DELIBERATELY DOES NOT COVER
--
--  Two of the map's filters cannot be expressed on grouped data, and the client
--  falls back to fetching raw rows when either is active:
--    * favourites-only -- keyed on per-detection reaction ids.
--    * free-text search -- searches `notes`, which is per detection.
--  Everything else (species, rarity, feeder, community scope, radius, zip,
--  period) is answerable from the columns below.
--
--  ON TIMEZONE
--
--  `day` is bucketed in America/New_York, matching feeder_badge_stats. The
--  period buttons compute their bounds in the VIEWER's local timezone, so for a
--  viewer outside ET a period edge can land a few hours off. On a map of counts
--  by location that is invisible, and the alternative -- a per-viewer grouping
--  -- cannot be precomputed at all.
--
--  ON SECURITY
--
--  `security_invoker = true` is load-bearing. Without it the view executes as
--  its owner and returns every feeder's detections to anyone who selects from
--  it, silently bypassing the RLS on community_detections -- including private
--  communities. With it, the caller's own policies apply exactly as they do on
--  the underlying table, so this view can show nobody anything they could not
--  already read row by row.
--
--  Idempotent -- safe to run more than once.
-- ============================================================================


create or replace view community_detection_map_points
with (security_invoker = true) as
select
    d.feeder_id,
    d.species,
    d.rarity,
    -- 3 decimal places ~= 110 m, the same key renderMap() already used to
    -- collapse nearby detections into one marker.
    round(d.latitude::numeric,  3)::float8                  as lat,
    round(d.longitude::numeric, 3)::float8                  as lng,
    min(d.zip_code)                                         as zip_code,
    (d.detected_at at time zone 'America/New_York')::date    as day,
    count(*)::int                                           as detections,
    max(d.detected_at)                                      as last_at,
    -- Newest six, for the popup's thumbnail strip. Private feeders' media
    -- arrives as a private:// marker; the browser exchanges those for signed
    -- URLs through the same signPrivateMedia() pass the feed uses, so storage
    -- RLS still decides who can actually see the image.
    (array_agg(d.image_url order by d.detected_at desc)
        filter (where d.image_url is not null))[1:6]         as sample_images
from community_detections d
where d.latitude  is not null
  and d.longitude is not null
group by
    d.feeder_id,
    d.species,
    d.rarity,
    round(d.latitude::numeric,  3),
    round(d.longitude::numeric, 3),
    (d.detected_at at time zone 'America/New_York')::date;

comment on view community_detection_map_points is
    'Pre-aggregated map markers: one row per (feeder, species, rarity, ~110m location, ET day). '
    'security_invoker = true, so the caller''s RLS on community_detections applies unchanged.';

grant select on community_detection_map_points to anon, authenticated;


-- ----------------------------------------------------------------------------
--  Verify
-- ----------------------------------------------------------------------------

-- Expect the grouped count to be a small fraction of the raw count.
select (select count(*) from community_detections)            as raw_rows,
       (select count(*) from community_detection_map_points)  as grouped_rows,
       (select count(*) from community_detections
         where latitude is null)                              as rows_without_location;

-- Distinct markers actually drawn on an unfiltered map (location + species).
select count(*) as markers
  from (select distinct lat, lng, species from community_detection_map_points) t;

-- Confirm invoker semantics survived the create. Expect security_invoker=true.
select c.relname,
       coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'false') as security_invoker
  from pg_class c
 where c.relname = 'community_detection_map_points';
