-- ════════════════════════════════════════════════════════════════════
--  A challenge can name the classes that are in it
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-classroom-challenges.sql, where a challenge was the whole
--  school or nothing. That is the right default and it is not always what a
--  moderator wants: a K-2 contest between the two infant classes, a year
--  group running something the rest of the school is not, a class on a trip
--  that should not appear on a board it never had a chance at.
--
--  AN EMPTY SET MEANS EVERY CLASS.
--  Not "no classes". Every challenge that exists today has no rows here and
--  must go on meaning what it meant when it was created, so absence has to
--  be the permissive case — and it is also the more useful one: a school
--  that adds a class in March should see it join March's challenge without
--  anybody editing the challenge.
--
--  So the UI stores NOTHING when every box is ticked, and rows only once a
--  moderator has actually narrowed it. "All of them" and "all of them as of
--  Tuesday" are different intentions and this keeps them different.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. Which classes are in it ──────────────────────────────────────

create table if not exists classroom_challenge_rooms (
    challenge_id uuid not null
                 references classroom_challenges(id) on delete cascade,
    classroom_id uuid not null
                 references classrooms(id) on delete cascade,
    primary key (challenge_id, classroom_id)
);

comment on table classroom_challenge_rooms is
  'The classes a challenge is limited to. NO ROWS MEANS EVERY CLASS — see '
  'setup-classroom-challenge-rooms.sql.';

create index if not exists idx_challenge_rooms_classroom
  on classroom_challenge_rooms (classroom_id);

alter table classroom_challenge_rooms enable row level security;

-- Same posture as the challenge itself: everything goes through the
-- security-definer RPCs, which do their own role checks.
drop policy if exists "Service role full access challenge rooms"
  on classroom_challenge_rooms;
create policy "Service role full access challenge rooms"
  on classroom_challenge_rooms
  for all to service_role using (true) with check (true);


-- ── 2. Creating one, now with a roster ──────────────────────────────
--
-- The old four-argument signature is DROPPED, not left beside this one.
-- p_classroom_ids has a default, so both would resolve for a four-argument
-- call and PostgREST would answer "function is not unique" — which is a
-- production outage, not a warning, and this project has already had it
-- once from exactly this mistake.

drop function if exists classroom_challenge_create(uuid, text, date, date);

create or replace function classroom_challenge_create(
  p_community_id  uuid,
  p_name          text,
  p_starts_on     date,
  p_ends_on       date,
  p_classroom_ids uuid[] default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c     classroom_challenges%rowtype;
  ids   uuid[];
  n_all int;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'The challenge needs a name';
  end if;
  if p_ends_on < p_starts_on then
    raise exception 'The challenge cannot end before it starts';
  end if;
  -- A window longer than a term is almost certainly a typo in a year.
  if p_ends_on - p_starts_on > 180 then
    raise exception 'That window is longer than six months — check the dates';
  end if;

  -- Only this school's own live classes, de-duplicated. Silently dropping a
  -- foreign id would let a caller aim a challenge at another school's class
  -- and read its scores off the board; refusing says so instead.
  if p_classroom_ids is not null and array_length(p_classroom_ids, 1) > 0 then
    select array_agg(distinct r.id) into ids
      from classrooms r
     where r.id = any(p_classroom_ids)
       and r.community_id = p_community_id
       and r.archived_at is null;

    if ids is null or array_length(ids, 1) <> array_length(
         (select array_agg(distinct x) from unnest(p_classroom_ids) x), 1) then
      raise exception 'One of those classes is not in this school';
    end if;

    -- Every live class ticked is the same intention as "the whole school",
    -- and storing it as the whole school is the version that keeps being
    -- true when a class is added next week. See the header.
    select count(*) into n_all from classrooms
     where community_id = p_community_id and archived_at is null;
    if array_length(ids, 1) >= n_all then
      ids := null;
    end if;
  end if;

  insert into classroom_challenges (community_id, name, starts_on, ends_on, created_by)
  values (p_community_id, btrim(p_name), p_starts_on, p_ends_on, auth.uid())
  returning * into c;

  if ids is not null then
    insert into classroom_challenge_rooms (challenge_id, classroom_id)
    select c.id, x from unnest(ids) x;
  end if;

  return row_to_json(c);
end;
$$;


-- ── 3. Reading them, with the roster attached ───────────────────────

create or replace function classroom_challenge_list(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
  r      text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);
  r := community_role(p_community_id, auth.uid());

  select json_agg(row_to_json(t) order by t.starts_on desc) into result
  from (
    select c.id, c.name, c.starts_on, c.ends_on, c.created_at,
           (current_date between c.starts_on and c.ends_on) as is_current,
           (current_date > c.ends_on)                        as is_over,
           -- '[]' means every class. The UI needs to be able to say which,
           -- so it gets the ids rather than a count it cannot act on.
           coalesce((select json_agg(cr.classroom_id)
                       from classroom_challenge_rooms cr
                      where cr.challenge_id = c.id), '[]'::json) as classroom_ids
      from classroom_challenges c
     where c.community_id = p_community_id
     order by c.starts_on desc
     limit 20
  ) t;

  return json_build_object(
    'items',     coalesce(result, '[]'::json),
    'can_manage', r in ('owner', 'moderator'));
end;
$$;


-- ── 4. The scoreboard, limited to the roster ────────────────────────
--
-- Unchanged except for the one clause. A class outside the roster is left
-- off the board entirely rather than shown on zero, for the same reason a
-- class that taught nothing is: "did not take part" and "took part and did
-- badly" are different things and a scoreboard that confuses them is one no
-- teacher will stand behind.

create or replace function classroom_challenge_standings(p_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  cid    uuid;
  starts date;
  ends   date;
  picked boolean;
  result json;
begin
  select community_id, starts_on, ends_on into cid, starts, ends
    from classroom_challenges where id = p_id;
  if cid is null then
    raise exception 'Challenge not found';
  end if;

  perform community_require_role(cid, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  select exists (select 1 from classroom_challenge_rooms where challenge_id = p_id)
    into picked;

  select json_agg(row_to_json(t) order by t.pct desc nulls last, t.answered desc, t.name)
    into result
  from (
    select r.id,
           r.name,
           r.grade_band,
           coalesce(nullif(p.display_name, ''), u.email, 'Teacher') as teacher_label,
           count(a.id) filter (where a.is_correct is not null)      as answered,
           count(a.id) filter (where a.is_correct)                  as correct,
           count(a.id) filter (where a.pending_check is not null
                                 and a.resolved_at is null)         as waiting,
           -- Sessions that ASKED SOMETHING. The session row is created the
           -- moment the board goes up — it has to be, because a join code
           -- and every answer hang off it — so a teacher who opens one and
           -- is interrupted leaves a row behind with nothing in it. Counting
           -- those would put a class that taught once and was interrupted
           -- twice on the board as having taught three lessons, in front of
           -- the whole school.
           count(distinct s.id) filter (where a.id is not null)      as lessons,
           case when count(a.id) filter (where a.is_correct is not null) > 0
                then round(100.0 * count(a.id) filter (where a.is_correct)
                                 / count(a.id) filter (where a.is_correct is not null))
           end                                                      as pct
      from classrooms r
      -- The window, generously: any lesson begun on or after the first
      -- day and before the day AFTER the last. See the timezone note.
      join classroom_sessions s
        on s.classroom_id = r.id
       and s.started_at >= starts::timestamptz
       and s.started_at <  (ends + 1)::timestamptz
      left join classroom_session_answers a on a.session_id = s.id
      left join user_profiles p on p.id = r.teacher_user_id
      left join auth.users    u on u.id = r.teacher_user_id
     where r.community_id = cid
       and r.archived_at is null
       and (not picked
            or exists (select 1 from classroom_challenge_rooms cr
                        where cr.challenge_id = p_id
                          and cr.classroom_id = r.id))
     group by r.id, r.name, r.grade_band, p.display_name, u.email
    having count(a.id) filter (where a.is_correct is not null) > 0
  ) t;

  return json_build_object(
    'challenge_id', p_id,
    'starts_on',    starts,
    'ends_on',      ends,
    'limited',      picked,
    'standings',    coalesce(result, '[]'::json));
end;
$$;


-- ── 5. Grants ───────────────────────────────────────────────────────

do $$
declare f text;
begin
  foreach f in array array[
    'classroom_challenge_create(uuid, text, date, date, uuid[])',
    'classroom_challenge_list(uuid)',
    'classroom_challenge_standings(uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon', f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;


commit;
