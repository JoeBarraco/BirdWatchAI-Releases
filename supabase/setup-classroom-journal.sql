-- ============================================================
-- BirdWatchAI Classroom — the class journal and the end-of-term certificate
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql, setup-classroom-year.sql and
-- setup-classroom-score-polls.sql. Purely additive: two new functions.
--
-- WHY THE SERVER AND NOT classroom_session_history
-- The history is capped at 50 lessons, which is right for a list a teacher
-- scrolls and wrong for a whole year. A class that teaches daily passes 50
-- by November, and a certificate that says "50 lessons" in June is a
-- certificate that is wrong. So the year totals are counted here, over every
-- lesson in the window, and only the totals and the predictions come back.
--
-- WHY FIRST SIGHTINGS ARE THEIR OWN CALL
-- classroom_year_months says which MONTH a species first turned up in. A
-- journal wants the day ("the first junco came on 3 November"), and a photo
-- of it. Reading every detection of the year to the browser to find that
-- out is the 13,500-row read setup-classroom-year.sql exists to avoid; this
-- is one row per species. Security invoker, like classroom_year_months, so
-- RLS decides which feeders a caller can see and nothing here widens it.
-- ============================================================

begin;

-- ── 1. First sighting of each species ─────────────────────────────
--
-- Raw species names, not folded: the client folds scientific names onto
-- common ones (cmSpeciesName) and takes the earliest of each fold, so there
-- is one list of names and it lives in one place.
--
-- photo: a favourite photo of that species if anyone starred one, else the
-- most confident one; not the first. The first visit is often the worst
-- picture of the year, and confidence alone is not enough either: on the
-- day this was written the most confident "Northern Cardinal" at the test
-- feeder was a squirrel. A starred photo is one a person looked at.
create or replace function classroom_year_firsts(
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
        select species, detected_at, image_url, confidence, is_favorite
          from community_detections
         where feeder_id = any(p_feeder_ids)
           and detected_at >= p_from
           and detected_at <  p_to
           and coalesce(btrim(species), '') <> ''
           and lower(btrim(species)) <> all (coalesce(p_exclude, '{}'::text[]))
    ),
    firsts as (
        select species, min(detected_at) as first_at, count(*) as n
          from clean group by species
    ),
    photos as (
        select distinct on (species) species, image_url
          from clean
         where coalesce(image_url, '') <> ''
         order by species, coalesce(is_favorite, false) desc, confidence desc nulls last, detected_at
    )
    select coalesce(json_agg(json_build_object(
               'sp',       f.species,
               'first_at', f.first_at,
               'n',        f.n,
               'photo',    p.image_url)
             order by f.first_at), '[]'::json)
      from firsts f
      left join photos p on p.species = f.species;
$function$;

revoke execute on function classroom_year_firsts(uuid[], timestamptz, timestamptz, text[]) from public;
grant  execute on function classroom_year_firsts(uuid[], timestamptz, timestamptz, text[])
       to anon, authenticated;


-- ── 2. The class's own year ───────────────────────────────────────
--
-- Counted with the same rule as asked_count since
-- setup-classroom-score-polls.sql: a question counts once it has a right
-- answer. A poll never does; an unsettled prediction does not yet.
--
-- best_run is the longest unbroken run of right answers, in the order they
-- were asked, across lessons. Across rather than within, because a run that
-- ends with the bell and carries on next morning is still a run to a class,
-- and within-lesson runs top out at the lesson's length, which says more
-- about the settings than the children.
create or replace function classroom_journal(
    p_classroom_id uuid,
    p_from         timestamptz,
    p_to           timestamptz
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  with sess as (
    select s.id, s.started_at
      from classroom_sessions s
     where s.classroom_id = p_classroom_id
       and s.started_at >= p_from
       and s.started_at <  p_to
       and exists (select 1 from classroom_session_answers a where a.session_id = s.id)
  ),
  ans as (
    select a.*, s.started_at,
           (a.correct_index is not null
            and (a.class_index is not null or a.vote_counts is not null)) as counted
      from classroom_session_answers a
      join sess s on s.id = a.session_id
  ),
  scored as (
    select asked_at, coalesce(is_correct, false) as ok,
           row_number() over (order by asked_at)
         - row_number() over (partition by coalesce(is_correct, false) order by asked_at) as grp
      from ans where counted
  ),
  runs as (
    select count(*) as len from scored where ok group by grp
  )
  select json_build_object(
    'lessons',         (select count(*) from sess),
    'first_lesson_at', (select min(started_at) from sess),
    'last_lesson_at',  (select max(started_at) from sess),
    'asked',           (select count(*) from ans where counted),
    'correct',         (select count(*) from ans where counted and is_correct),
    'polls',           (select count(*) from ans where correct_index is null and pending_check is null),
    'best_run',        coalesce((select max(len) from runs), 0),
    'by_month', coalesce((
        select json_agg(row_to_json(bm) order by bm.m)
          from (select to_char(date_trunc('month', s.started_at), 'YYYY-MM') as m,
                       count(distinct s.id)                                 as lessons,
                       count(a.id) filter (where a.counted)                 as asked,
                       count(a.id) filter (where a.counted and a.is_correct) as correct
                  from sess s
                  left join ans a on a.session_id = s.id
                 group by 1) bm), '[]'::json),
    -- Every prediction, settled or not. The journal's best page is "what we
    -- thought would happen, and what did", and that is these rows.
    'predictions', coalesce((
        select json_agg(json_build_object(
                 'asked_at',        a.asked_at,
                 'prompt',          a.prompt,
                 'choices',         a.choices,
                 'class_index',     a.class_index,
                 'correct_index',   a.correct_index,
                 'is_correct',      a.is_correct,
                 'pending',         (a.resolved_at is null),
                 'resolved_actual', a.resolved_actual)
               order by a.asked_at)
          from ans a
         where a.pending_check is not null), '[]'::json)
  ) into result;

  return result;
end;
$$;

revoke execute on function classroom_journal(uuid, timestamptz, timestamptz) from public;
revoke execute on function classroom_journal(uuid, timestamptz, timestamptz) from anon;
grant  execute on function classroom_journal(uuid, timestamptz, timestamptz) to authenticated;

commit;
