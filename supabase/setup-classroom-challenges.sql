-- ════════════════════════════════════════════════════════════════════
--  Weekly challenges and a school scoreboard
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-classrooms.sql. A moderator names a challenge and a
--  week; every class in the school plays its own lessons as usual; the
--  scoreboard compares how they did. For the morning show.
--
--  WHAT A CHALLENGE IS, AND IS NOT
--  It is a NAMED WINDOW OF TIME, not a separate kind of lesson. No new
--  question path, no special session, nothing a teacher has to opt into
--  on the day. A class that teaches its normal lesson on Tuesday is in
--  the challenge by having done so.
--
--  That is deliberate. A challenge that needed its own lesson type
--  would be one more thing to remember on a Monday morning, and the
--  classes that forgot would look like classes that lost.
--
--  COMPARING CLASSES IS THE HARD PART
--  A K-2 class counts dots. A 6-8 class reads a distribution and makes
--  a prediction. Ranking both on raw percent correct would put the
--  six-year-olds top and the thirteen-year-olds bottom, and the 6-8
--  teacher would stop entering within a fortnight.
--
--  So the standings carry the band on every row and the UI groups by
--  it. The score itself is percent correct, which is the only measure
--  that survives classes running different numbers of lessons — a
--  class that taught four days cannot be compared to one that taught
--  two on totals alone.
--
--  UNSETTLED PREDICTIONS DO NOT COUNT. A prediction is neither right
--  nor wrong until the birds settle it, and counting it as wrong would
--  penalise exactly the classes asking the most interesting questions.
--
--  ⚠ TIMEZONE. The window is compared against started_at in UTC. For a
--  US school an evening lesson on the last day can fall outside a
--  window that ends that day. Communities do not store a timezone, so
--  fixing this properly needs one; until then ends_on is treated
--  generously — see the +1 day in the standings query.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. The challenge ────────────────────────────────────────────────

create table if not exists classroom_challenges (
    id           uuid primary key default gen_random_uuid(),
    community_id uuid not null references communities(id) on delete cascade,

    name         text not null,
    starts_on    date not null,
    ends_on      date not null,

    created_by   uuid,
    created_at   timestamptz not null default now()
);

alter table classroom_challenges
  drop constraint if exists classroom_challenges_dates;
alter table classroom_challenges
  add  constraint classroom_challenges_dates check (ends_on >= starts_on);

alter table classroom_challenges
  drop constraint if exists classroom_challenges_name;
alter table classroom_challenges
  add  constraint classroom_challenges_name
  check (length(btrim(name)) between 1 and 80);

create index if not exists idx_challenges_community
  on classroom_challenges (community_id, starts_on desc);

comment on table classroom_challenges is
  'A named window of dates. Lessons taught inside it count towards the '
  'school scoreboard; see setup-classroom-challenges.sql.';

alter table classroom_challenges enable row level security;

-- Everything goes through the security-definer RPCs below, which do
-- their own role checks. No anon or authenticated policy at all.
drop policy if exists "Service role full access challenges" on classroom_challenges;
create policy "Service role full access challenges" on classroom_challenges
  for all to service_role using (true) with check (true);


-- ── 2. Creating and removing one ────────────────────────────────────
--
-- Owner and moderator. A challenge is a school-wide thing and a
-- teacher setting one for everybody else is not the shape of a school.

create or replace function classroom_challenge_create(
  p_community_id uuid,
  p_name         text,
  p_starts_on    date,
  p_ends_on      date
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c classroom_challenges%rowtype;
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

  insert into classroom_challenges (community_id, name, starts_on, ends_on, created_by)
  values (p_community_id, btrim(p_name), p_starts_on, p_ends_on, auth.uid())
  returning * into c;

  return row_to_json(c);
end;
$$;

create or replace function classroom_challenge_delete(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  select community_id into cid from classroom_challenges where id = p_id;
  if cid is null then
    raise exception 'Challenge not found';
  end if;
  perform community_require_role(cid, auth.uid(), array['owner', 'moderator']);

  -- Deleting a challenge removes the WINDOW, never a lesson. Nothing a
  -- class did is touched; it simply stops being counted towards this
  -- scoreboard.
  delete from classroom_challenges where id = p_id;
  return found;
end;
$$;


-- ── 3. Reading them ─────────────────────────────────────────────────
--
-- Teachers included: a teacher wants to see the board, and may well be
-- the one putting it on the screen in front of a class.

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
           (current_date > c.ends_on)                        as is_over
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


-- ── 4. The scoreboard ───────────────────────────────────────────────
--
-- One row per classroom that taught at least one lesson in the window.
-- A class with nothing in the window is left out rather than shown on
-- zero: "no lessons yet" and "got everything wrong" are different
-- things, and a scoreboard that cannot tell them apart is one no
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
  result json;
begin
  select community_id, starts_on, ends_on into cid, starts, ends
    from classroom_challenges where id = p_id;
  if cid is null then
    raise exception 'Challenge not found';
  end if;

  perform community_require_role(cid, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

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
     group by r.id, r.name, r.grade_band, p.display_name, u.email
    having count(a.id) filter (where a.is_correct is not null) > 0
  ) t;

  return json_build_object(
    'challenge_id', p_id,
    'starts_on',    starts,
    'ends_on',      ends,
    'standings',    coalesce(result, '[]'::json));
end;
$$;


-- ── 5. Grants ───────────────────────────────────────────────────────

do $$
declare f text;
begin
  foreach f in array array[
    'classroom_challenge_create(uuid, text, date, date)',
    'classroom_challenge_delete(uuid)',
    'classroom_challenge_list(uuid)',
    'classroom_challenge_standings(uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon', f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;


commit;
