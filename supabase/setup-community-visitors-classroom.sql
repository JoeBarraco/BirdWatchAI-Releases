-- ════════════════════════════════════════════════════════════════════════
--  Classroom: birds only, now that feeders can record non-bird visitors
-- ════════════════════════════════════════════════════════════════════════
--
--  Follows setup-community-visitors.sql, which added community_detections.is_bird.
--  These three classroom functions count species straight from
--  community_detections, so without this a squirrel would turn up in a pen-pal
--  class's species list, in "first visits of the year" and in the monthly
--  species chart. Every lesson is about birds.
--
--  Each body is the live definition (read with pg_get_functiondef on
--  2026-11-27) with one line added to its detection filter: "and is_bird".
--  CREATE OR REPLACE with an unchanged signature keeps each function's
--  existing grants exactly as they are.
--
--  Idempotent.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.classroom_penpal_week(p_classroom_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_exclude text[] DEFAULT '{}'::text[], p_tz text DEFAULT 'America/New_York'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  room  classrooms%rowtype;
  them  classrooms%rowtype;
  p     classroom_penpals%rowtype;
  tz    text;
  side  json;
  ours  json;
  their json;
  r     classrooms%rowtype;
begin
  room := classroom_require_manage(p_classroom_id);
  p := classroom_penpal_row(p_classroom_id);
  if p.id is null or p.accepted_at is null then
    return null;
  end if;
  if p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'A pen-pal window is at most 31 days';
  end if;
  tz := case when exists (select 1 from pg_timezone_names where name = p_tz)
             then p_tz else 'America/New_York' end;
  select * into them from classrooms
   where id = case when p.classroom_a = room.id then p.classroom_b else p.classroom_a end;

  foreach r in array array[room, them] loop
    with clean as (
      select (d.detected_at at time zone tz)::date as day, d.species, d.temperature, d.latitude
        from community_detections d
       where d.feeder_id = any(classroom_penpal_feeders(r.id))
         and d.detected_at >= p_from and d.detected_at < p_to
         and d.is_bird
         and coalesce(btrim(d.species), '') <> ''
         and lower(btrim(d.species)) <> all (coalesce(p_exclude, '{}'::text[]))
    )
    select json_build_object(
      'name',   r.name,
      'school', (select name from communities where id = r.community_id),
      'grade_band', r.grade_band,
      'total',  (select count(*) from clean),
      'days',   coalesce((select json_agg(json_build_object('d', day, 'n', n) order by day)
                            from (select day, count(*) n from clean group by day) x), '[]'::json),
      'species', coalesce((select json_agg(json_build_object('sp', species, 'n', n) order by n desc)
                             from (select species, count(*) n from clean group by species) y), '[]'::json),
      'avg_temp', (select round(avg(temperature)::numeric, 1) from clean where temperature is not null),
      'lat',      (select round(avg(latitude))::int from clean where latitude is not null)
    ) into side;
    if r.id = room.id then ours := side; else their := side; end if;
  end loop;

  return json_build_object('ours', ours, 'theirs', their, 'since', p.accepted_at);
end;
$function$;

CREATE OR REPLACE FUNCTION public.classroom_year_firsts(p_feeder_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone, p_exclude text[] DEFAULT '{}'::text[])
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    with clean as (
        select species, detected_at, image_url, confidence, is_favorite
          from community_detections
         where feeder_id = any(p_feeder_ids)
           and detected_at >= p_from
           and detected_at <  p_to
           and is_bird
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

CREATE OR REPLACE FUNCTION public.classroom_year_months(p_feeder_ids uuid[], p_from timestamp with time zone, p_to timestamp with time zone, p_exclude text[] DEFAULT '{}'::text[])
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
    with clean as (
        select feeder_id,
               date_trunc('month', detected_at) as m,
               (detected_at)::date              as d,
               species
          from community_detections
         where feeder_id = any(p_feeder_ids)
           and detected_at >= p_from
           and detected_at <  p_to
           and is_bird
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
