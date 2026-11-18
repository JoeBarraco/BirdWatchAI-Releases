-- ============================================================
-- BirdWatchAI Classroom — pen-pal classes at two schools
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql. Purely additive: one table, five
-- functions. Client: docs/js/classroom-penpals.js.
--
-- WHAT A PEN-PAL IS
-- Two classes at two different schools, each with its own feeder, that
-- agree to compare weeks. One teacher makes an invite code; the other
-- types it in. From then on each class's lessons can ask "which feeder had
-- more birds this week, ours or theirs?", "which bird came to both?",
-- "which came to theirs but never to ours, and why might that be?". That
-- last one is SC.3.N.1.2 nearly word for word: compare the observations
-- made by different groups using the same tools, and seek reasons for the
-- differences.
--
-- WHAT CROSSES BETWEEN THE SCHOOLS, AND WHAT DOES NOT ⚠
-- Partner feeders (classroom_partner_feeders) have to be PUBLIC, because a
-- partner's detections are read through the normal feed and RLS. A school
-- feeder is often private, so a pen-pal cannot work that way. Instead
-- classroom_penpal_week is security definer and hands back AGGREGATES only:
--   * per-day visit totals, per-species counts, the average temperature;
--   * latitude to the WHOLE DEGREE (about 70 miles), for "whose feeder is
--     further north" and nothing finer;
--   * the other class's name and school name, which both teachers agreed
--     to show by pairing.
-- Never a photo, a clip, a coordinate, a zip code, a feeder name or a
-- person. The pairing is the consent, both teachers can end it, and an
-- ended pairing returns nothing.
--
-- ONE LIVE PAIRING PER CLASS. A class with three pen-pals has three sets
-- of comparisons competing for eight questions and learns nothing from any
-- of them. Held by the functions, under a row lock, rather than by an index,
-- because the class can be on either side of the row.
-- ============================================================

begin;

create table if not exists classroom_penpals (
  id           uuid primary key default gen_random_uuid(),
  classroom_a  uuid not null references classrooms(id) on delete cascade,   -- invited
  classroom_b  uuid          references classrooms(id) on delete cascade,   -- accepted
  invite_code  text unique,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  accepted_by  uuid,
  accepted_at  timestamptz,
  ended_at     timestamptz,
  check (classroom_b is null or classroom_b <> classroom_a)
);
create index if not exists classroom_penpals_a on classroom_penpals (classroom_a) where ended_at is null;
create index if not exists classroom_penpals_b on classroom_penpals (classroom_b) where ended_at is null;

-- No policies: nobody reads the table directly. Every way in is one of the
-- functions below, each of which checks the caller manages the class.
alter table classroom_penpals enable row level security;
revoke all on classroom_penpals from public, anon, authenticated;

-- How long an unused invite stays good.
create or replace function classroom_penpal_invite_ttl() returns interval
language sql immutable as $$ select interval '14 days' $$;


-- The live row for a class, on either side: paired, or an open invite.
create or replace function classroom_penpal_row(p_classroom_id uuid)
returns classroom_penpals
language sql stable security definer set search_path = public as $$
  select * from classroom_penpals
   where ended_at is null
     and (classroom_a = p_classroom_id or classroom_b = p_classroom_id)
     and (accepted_at is not null or created_at > now() - classroom_penpal_invite_ttl())
   order by accepted_at desc nulls last, created_at desc
   limit 1
$$;
revoke execute on function classroom_penpal_row(uuid) from public, anon, authenticated;


/**
 * Where this class stands: no pen-pal, an invite waiting, or paired.
 */
create or replace function classroom_penpal_status(p_classroom_id uuid)
returns json
language plpgsql security definer set search_path = public as $$
declare
  p     classroom_penpals%rowtype;
  other uuid;
  o     record;
begin
  perform classroom_require_manage(p_classroom_id);
  p := classroom_penpal_row(p_classroom_id);
  if p.id is null then
    return json_build_object('state', 'none');
  end if;
  if p.accepted_at is null then
    return json_build_object('state', 'invited', 'code', p.invite_code,
                             'expires_at', p.created_at + classroom_penpal_invite_ttl());
  end if;
  other := case when p.classroom_a = p_classroom_id then p.classroom_b else p.classroom_a end;
  select c.name, c.grade_band, co.name as school,
         (c.home_feeder_id is not null) as has_feeder
    into o
    from classrooms c join communities co on co.id = c.community_id
   where c.id = other;
  return json_build_object(
    'state', 'paired', 'since', p.accepted_at,
    'partner', json_build_object('name', o.name, 'school', o.school,
                                 'grade_band', o.grade_band, 'has_feeder', o.has_feeder));
end;
$$;


/**
 * Make an invite code, or hand back the one already open. Refuses a class
 * that is already paired: end that first.
 */
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
  if room.home_feeder_id is null then
    raise exception 'Set a home feeder for this class first: a pen-pal compares two feeders';
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


/**
 * Type in another class's code. One generic message for every way a code
 * can be wrong, so this cannot be used to probe which codes exist.
 */
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
  if room.home_feeder_id is null then
    raise exception 'Set a home feeder for this class first: a pen-pal compares two feeders';
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


/** End a pairing, or withdraw an invite. Either teacher may. */
create or replace function classroom_penpal_end(p_classroom_id uuid)
returns json
language plpgsql security definer set search_path = public as $$
begin
  perform classroom_require_manage(p_classroom_id);
  update classroom_penpals
     set ended_at = now(), invite_code = null
   where ended_at is null
     and (classroom_a = p_classroom_id or classroom_b = p_classroom_id);
  return json_build_object('state', 'none');
end;
$$;


/**
 * The two feeders over one window, side by side. Aggregates only (see the
 * header). p_exclude is the client's own list of not-birds, as for
 * classroom_year_months, so there is one copy of it. Days are counted in
 * the caller's time zone for both feeders: two schools a time zone apart
 * then share one calendar, which is what a comparison needs.
 */
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
       where d.feeder_id = r.home_feeder_id
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


revoke execute on function classroom_penpal_status(uuid)          from public, anon;
revoke execute on function classroom_penpal_invite(uuid)          from public, anon;
revoke execute on function classroom_penpal_accept(uuid, text)    from public, anon;
revoke execute on function classroom_penpal_end(uuid)             from public, anon;
revoke execute on function classroom_penpal_week(uuid, timestamptz, timestamptz, text[], text) from public, anon;
grant  execute on function classroom_penpal_status(uuid)          to authenticated;
grant  execute on function classroom_penpal_invite(uuid)          to authenticated;
grant  execute on function classroom_penpal_accept(uuid, text)    to authenticated;
grant  execute on function classroom_penpal_end(uuid)             to authenticated;
grant  execute on function classroom_penpal_week(uuid, timestamptz, timestamptz, text[], text) to authenticated;
revoke execute on function classroom_penpal_invite_ttl()          from public, anon, authenticated;

commit;
