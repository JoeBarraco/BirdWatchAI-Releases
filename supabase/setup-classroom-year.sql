-- ════════════════════════════════════════════════════════════════════
--  A school year, rolled up by month, for the "this year" questions
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS AT ALL
--  The month questions (f3f2840) left "this year" out on purpose, and its
--  own comment said why: "Ten months of raw detections for every lesson is
--  a lot of rows to page through to draw two or three bars; that wants a
--  monthly count computed on the server, which is its own change." This is
--  that change. On the test community a school year is ~13,500 detections;
--  this returns about 130 rows instead, which is the whole point.
--
--  ⚠ WHY IT DOES NOT RETURN A SPECIES COUNT
--  Because it would be wrong. The client maps latin names onto common ones
--  (CM_LATIN_COMMON), so "Cardinalis cardinalis" and "Northern Cardinal"
--  are ONE species to a class and two rows to Postgres. Counting distinct
--  species here would quietly report a feeder as richer than it is. So this
--  returns per-month, per-species tallies and the client folds the names
--  together itself, the same way it already does for the week and the
--  month. One source of truth for what a species is, and it is in the JS.
--
--  ⚠ WHY THE EXCLUSION LIST IS A PARAMETER
--  Same reason. CM_NOT_BIRDS — deer, squirrels, people, the detector's own
--  "unknown" — lives in community-classroom.js and is edited there. Copying
--  those ~98 strings into SQL would create a second list to keep in step,
--  and the day they disagreed a deer would become a bird in the year
--  questions and not in the weekly ones. The caller passes its own list.
--
--  ⚠ SECURITY INVOKER, NOT DEFINER, AND THIS IS DELIBERATE
--  Every other function in this folder is definer because it is granting
--  access that RLS alone would not. This one must not: community_detections
--  has RLS with two policies, and the client already reads the very same
--  rows over PostgREST. Running as the caller means this function returns
--  exactly what that read would return and not one row more — it is an
--  aggregate shortcut, not a new door. A definer here would quietly hand
--  anon the whole table, grouped.
--
--  ⚠ GROUPED BY FEEDER TOO, so the caller can narrow to whichever feeder
--  the lesson settled on. cmPickSource may fall back from a quiet home
--  feeder to a busy partner, and the month questions already follow it --
--  "this year at the courtyard" beside "this week at the library" would be
--  two feeders on one slide. Returning the breakdown costs a few dozen more
--  rows and lets the client match.
--
--  THE SCHOOL YEAR, not the calendar year: the caller passes the dates.
--  A calendar year collapses every January — one month of data in January,
--  two in February — so the questions would be dead or thin through a whole
--  term. August to July never drops below about four months once term is
--  underway. The function itself takes any span and does not care.
-- ════════════════════════════════════════════════════════════════════

begin;

create or replace function classroom_year_months(
    p_feeder_ids uuid[],
    p_from       timestamptz,
    p_to         timestamptz,
    p_exclude    text[] default '{}'::text[]
)
returns json
language sql
security invoker
stable
set search_path to 'public'
as $function$
    with clean as (
        select feeder_id,
               date_trunc('month', detected_at) as m,
               (detected_at)::date              as d,
               species
          from community_detections
         where feeder_id = any(p_feeder_ids)
           and detected_at >= p_from
           and detected_at <  p_to
           -- Same cleaning the client does, driven by the client's own list.
           and coalesce(btrim(species), '') <> ''
           and lower(btrim(species)) <> all (coalesce(p_exclude, '{}'::text[]))
    )
    select json_build_object(
        'months', coalesce((
            select json_agg(row_to_json(x) order by x.m)
              from (select feeder_id,
                           to_char(m, 'YYYY-MM') as m,
                           count(*)              as visits,
                           count(distinct d)     as days
                      from clean group by feeder_id, m) x), '[]'::json),
        'species', coalesce((
            select json_agg(row_to_json(y) order by y.m, y.n desc)
              from (select feeder_id,
                           to_char(m, 'YYYY-MM') as m,
                           species               as sp,
                           count(*)              as n
                      from clean group by feeder_id, m, species) y), '[]'::json)
    );
$function$;

-- Mirrors the table: both roles may call it, and RLS decides what comes
-- back. No revoke from public here would be meaningful — the function
-- grants nothing the caller does not already have.
grant execute on function classroom_year_months(uuid[], timestamptz, timestamptz, text[])
      to anon, authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select jsonb_pretty(classroom_year_months(
--             array['<feeder id>']::uuid[],
--             '2026-08-01', '2027-08-01',
--             array['deer','squirrel','human','unknown'])::jsonb);
--
--  'months' should hold one row per month that had a detection, with
--  days <= the length of that month. Summing 'species'.n for a month must
--  equal that month's 'visits' — if it does not, the group-bys disagree.
--
--  And as anon it must return only what the feed shows anonymously: run it
--  with `set local role anon;` and compare against
--    select count(*) from community_detections where feeder_id = ...;
--  run under the same role.
-- ════════════════════════════════════════════════════════════════════
