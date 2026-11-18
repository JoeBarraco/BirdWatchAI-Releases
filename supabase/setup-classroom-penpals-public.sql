-- ============================================================
-- BirdWatchAI Classroom — pen-pals without a feeder of your own
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classroom-penpals.sql (and setup-classroom-logos.sql is
-- unrelated). Replaces three of its functions and adds one.
--
-- WHY (2026-11-18)
-- A class, or a Home Classroom child, can now learn from public feeders
-- with no feeder of its own. Pen-pals used the class's HOME feeder for
-- everything, so such a class could not pair at all. Now a class's side of
-- a pen-pal is:
--   * its own feeder, when it has one (unchanged), or
--   * the feeders it learns from (its partner feeders) when it has none.
-- Same aggregates as before, summed across those feeders: visits per day
-- and per species, average temperature, latitude to the whole degree.
-- ============================================================

begin;

create or replace function classroom_penpal_feeders(p_classroom_id uuid)
returns uuid[]
language sql stable security definer set search_path = public as $$
  select case
    when c.home_feeder_id is not null then array[c.home_feeder_id]
    else coalesce((select array_agg(pf.feeder_id order by pf.feeder_id)
                     from classroom_partner_feeders pf
                    where pf.classroom_id = c.id), '{}'::uuid[])
  end
  from classrooms c where c.id = p_classroom_id
$$;
revoke execute on function classroom_penpal_feeders(uuid) from public, anon, authenticated;

create or replace function classroom_penpal_invite(p_classroom_id uuid)
returns json
language plpgsql security definer set search_path = public as $$
declare
  room  classrooms%rowtype;
  p     classroom_penpals%rowtype;
  code  text;
  alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- no 0/O, 1/I/L
  i     int;
begin
  room := classroom_require_manage(p_classroom_id);
  if cardinality(classroom_penpal_feeders(room.id)) = 0 then
    raise exception 'Pick a feeder for this class first (its own, or public feeders to learn from): a pen-pal compares two feeders';
  end if;
  perform 1 from classrooms where id = p_classroom_id for update;   -- one at a time per class

  p := classroom_penpal_row(p_classroom_id);
  if p.id is not null and p.accepted_at is not null then
    raise exception 'This class already has a pen-pal class. End that pairing first';
  end if;
  if p.id is not null then
    return json_build_object('state', 'invited', 'code', p.invite_code,
                             'expires_at', p.created_at + classroom_penpal_invite_ttl());
  end if;

  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alpha, 1 + floor(random() * length(alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from classroom_penpals where invite_code = code);
  end loop;

  insert into classroom_penpals (classroom_a, invite_code, created_by)
  values (p_classroom_id, code, auth.uid())
  returning * into p;
  return json_build_object('state', 'invited', 'code', p.invite_code,
                           'expires_at', p.created_at + classroom_penpal_invite_ttl());
end;
$$;


create or replace function classroom_penpal_accept(p_classroom_id uuid, p_code text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  room   classrooms%rowtype;
  them   classrooms%rowtype;
  p      classroom_penpals%rowtype;
  mine   classroom_penpals%rowtype;
  normal text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  room := classroom_require_manage(p_classroom_id);
  if cardinality(classroom_penpal_feeders(room.id)) = 0 then
    raise exception 'Pick a feeder for this class first (its own, or public feeders to learn from): a pen-pal compares two feeders';
  end if;

  select * into p from classroom_penpals
   where invite_code = normal and ended_at is null and accepted_at is null
     and created_at > now() - classroom_penpal_invite_ttl()
   for update;
  if p.id is null then
    raise exception 'That code is not one we recognise, or it has expired';
  end if;
  select * into them from classrooms where id = p.classroom_a;
  if them.id is null or them.id = room.id or them.community_id = room.community_id then
    -- Same school: the classes can already share a feeder by being in one
    -- community, and a pen-pal is for a school somewhere else.
    raise exception 'That code is not one we recognise, or it has expired';
  end if;

  -- Both classes free. Lock this class so two codes typed at once cannot
  -- both land.
  perform 1 from classrooms where id in (room.id, them.id) for update;
  mine := classroom_penpal_row(room.id);
  if mine.id is not null and mine.accepted_at is not null then
    raise exception 'This class already has a pen-pal class. End that pairing first';
  end if;
  if exists (select 1 from classroom_penpals
              where ended_at is null and accepted_at is not null
                and (classroom_a = them.id or classroom_b = them.id)) then
    raise exception 'That code is not one we recognise, or it has expired';
  end if;
  -- This class's own unused invite goes: it is about to have a pen-pal.
  update classroom_penpals set ended_at = now()
   where classroom_a = room.id and accepted_at is null and ended_at is null;

  update classroom_penpals
     set classroom_b = room.id, accepted_by = auth.uid(), accepted_at = now(),
         invite_code = null      -- spent; the column is unique, so it is freed
   where id = p.id;

  return classroom_penpal_status(room.id);
end;
$$;


create or replace function classroom_penpal_week(
  p_classroom_id uuid,
  p_from         timestamptz,
  p_to           timestamptz,
  p_exclude      text[] default '{}'::text[],
  p_tz           text   default 'America/New_York'
)
returns json
language plpgsql security definer set search_path = public as $$
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
$$;


commit;
