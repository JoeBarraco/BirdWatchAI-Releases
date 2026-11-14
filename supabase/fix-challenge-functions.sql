-- ════════════════════════════════════════════════════════════════════
--  Challenge functions: repair, in one transaction
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS FILE EXISTS
--  setup-classroom-challenges.sql was re-run on top of the two migrations
--  that follow it. It is idempotent on its own, but it is not the LATEST
--  definition of three of its functions, so re-running it put the old ones
--  back:
--
--    * classroom_challenge_create     the four-argument version returned,
--                                     alongside the five-argument one. Two
--                                     candidates match a four-argument named
--                                     call, so PostgREST answers PGRST203 —
--                                     "could not choose the best candidate
--                                     function" — and a school with one
--                                     class cannot create a challenge at all.
--    * classroom_challenge_list       lost classroom_ids.
--    * classroom_challenge_standings  lost the roster filter.
--
--  Running the two migrations by hand would also work, but ONLY in the order
--  rooms-then-questions: the rooms file re-creates the five-argument create
--  that the questions file exists to drop, so the other order re-breaks it.
--  An order that has to be remembered is a trap, so this file is both, in
--  one transaction, with the drops first.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run. Safe to run even if the schema is already
--  correct.
--
--  AFTERWARDS classroom_challenge_create must have exactly ONE signature,
--  the eight-argument one. The check at the foot of this file says so out
--  loud rather than leaving you to look.
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

-- ── 1. The policy ───────────────────────────────────────────────────

alter table classroom_challenges
  add column if not exists question_mode  text not null default 'any',
  add column if not exists categories     text[],
  add column if not exists template_picks text[];

do $$
begin
  alter table classroom_challenges
    add constraint classroom_challenges_question_mode
    check (question_mode in ('any', 'categories', 'templates'));
exception when duplicate_object then null;
end $$;

-- Size and no-nulls only, as on classrooms.template_picks: a CHECK may not
-- contain a subquery, so the per-element rules live in the write path below,
-- which is the only way in.
do $$
begin
  alter table classroom_challenges
    add constraint classroom_challenges_picks_shape
    check (
      (categories is null
        or (cardinality(categories) between 1 and 40
            and array_position(categories, null) is null))
      and
      (template_picks is null
        or (cardinality(template_picks) between 1 and 400
            and array_position(template_picks, null) is null))
    );
exception when duplicate_object then null;
end $$;

comment on column classroom_challenges.question_mode is
  'any | categories | templates. See setup-classroom-challenge-questions.sql. '
  'Overrides each classroom''s own template_picks for the duration.';


-- ── 2. Creating one ─────────────────────────────────────────────────
--
-- The five-argument signature is DROPPED, for the third time in this
-- feature's history and for the same reason: defaulted parameters mean two
-- candidates match a four- or five-argument named call, and PostgREST calls
-- that "function is not unique" rather than picking one.

drop function if exists classroom_challenge_create(uuid, text, date, date);
drop function if exists classroom_challenge_create(uuid, text, date, date, uuid[]);

create or replace function classroom_challenge_create(
  p_community_id  uuid,
  p_name          text,
  p_starts_on     date,
  p_ends_on       date,
  p_classroom_ids uuid[] default null,
  p_question_mode text   default 'any',
  p_categories    text[] default null,
  p_template_ids  text[] default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c     classroom_challenges%rowtype;
  ids   uuid[];
  cats  text[];
  tmpl  text[];
  mode  text;
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
  if p_ends_on - p_starts_on > 180 then
    raise exception 'That window is longer than six months — check the dates';
  end if;

  mode := coalesce(nullif(btrim(p_question_mode), ''), 'any');
  if mode not in ('any', 'categories', 'templates') then
    raise exception 'Unknown question mode: %', mode;
  end if;

  -- Trim, drop blanks, de-duplicate — the same treatment classroom_set_
  -- templates gives a teacher's list, for the same reason: a list arriving
  -- with the same id twice is not worth refusing a save over.
  select array_agg(distinct v) into cats
    from (select btrim(x) as v from unnest(coalesce(p_categories, '{}'::text[])) x) q
   where v is not null and length(v) between 1 and 40;

  select array_agg(distinct v) into tmpl
    from (select btrim(x) as v from unnest(coalesce(p_template_ids, '{}'::text[])) x) q
   where v is not null and length(v) between 1 and 80;

  -- A mode that names nothing is the same as naming everything, and it is
  -- much more likely to be a UI that failed to send its list than a
  -- deliberate request for a challenge with no questions in it. Fall back to
  -- 'any' rather than create something that cannot be taught.
  if mode = 'categories' and (cats is null or cardinality(cats) = 0) then mode := 'any'; end if;
  if mode = 'templates'  and (tmpl is null or cardinality(tmpl) = 0) then mode := 'any'; end if;

  if mode <> 'categories' then cats := null; end if;
  if mode <> 'templates'  then tmpl := null; end if;

  if cats is not null and cardinality(cats) > 40 then
    raise exception 'That is more categories than exist';
  end if;
  if tmpl is not null and cardinality(tmpl) > 400 then
    raise exception 'That is more question types than a challenge can hold';
  end if;

  -- Only this school's own live classes. Silently dropping a foreign id
  -- would let a caller aim a challenge at another school's class and read
  -- its scores off the board.
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

    select count(*) into n_all from classrooms
     where community_id = p_community_id and archived_at is null;
    if array_length(ids, 1) >= n_all then
      ids := null;                        -- "every class", including later ones
    end if;
  end if;

  insert into classroom_challenges (community_id, name, starts_on, ends_on, created_by,
                                    question_mode, categories, template_picks)
  values (p_community_id, btrim(p_name), p_starts_on, p_ends_on, auth.uid(),
          mode, cats, tmpl)
  returning * into c;

  if ids is not null then
    insert into classroom_challenge_rooms (challenge_id, classroom_id)
    select c.id, x from unnest(ids) x;
  end if;

  return row_to_json(c);
end;
$$;


-- ── 3. Reading them ─────────────────────────────────────────────────

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
           c.question_mode, c.categories, c.template_picks,
           (current_date between c.starts_on and c.ends_on) as is_current,
           (current_date > c.ends_on)                        as is_over,
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


-- ── 4. What a class should be asking right now ──────────────────────
--
-- Called as a lesson starts, by the teacher about to teach it — so the
-- permission rule is classroom_require_manage, not the community-wide one:
-- a teacher may ask this about their own room without being handed the
-- roster of every other class in the school.
--
-- Returns null rather than raising when there is no challenge on. "No
-- challenge today" is the ordinary case, not an error, and a lesson must
-- never fail to start because the scoreboard had nothing to say.

create or replace function classroom_active_challenge(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  cid    uuid;
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select community_id into cid from classrooms where id = p_classroom_id;
  if cid is null then
    return null;
  end if;

  select row_to_json(t) into result
  from (
    select c.id, c.name, c.starts_on, c.ends_on,
           c.question_mode, c.categories, c.template_picks
      from classroom_challenges c
     where c.community_id = cid
       and current_date between c.starts_on and c.ends_on
       -- No roster means every class; a roster means only the named ones.
       and (not exists (select 1 from classroom_challenge_rooms cr
                         where cr.challenge_id = c.id)
            or exists (select 1 from classroom_challenge_rooms cr
                        where cr.challenge_id = c.id
                          and cr.classroom_id = p_classroom_id))
     -- Two live challenges is not supposed to happen, but if it does the
     -- most recently created one is the one somebody meant.
     order by c.created_at desc
     limit 1
  ) t;

  return result;          -- null when nothing is running
end;
$$;


-- ── 5. Grants ───────────────────────────────────────────────────────

do $$
declare f text;
begin
  foreach f in array array[
    'classroom_challenge_create(uuid, text, date, date, uuid[], text, text[], text[])',
    'classroom_challenge_list(uuid)',
    'classroom_active_challenge(uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon', f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;

-- ── The check ───────────────────────────────────────────────────────
--
-- One signature, or this file has not done its job and challenges are still
-- broken. Raising rather than returning a row, because a NOTICE in a long
-- output is a thing you scroll past.

do $$
declare n int;
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'classroom_challenge_create';
  if n <> 1 then
    raise exception 'classroom_challenge_create still has % signatures, expected 1', n;
  end if;

  if to_regclass('public.classroom_challenge_rooms') is null then
    raise exception 'classroom_challenge_rooms is missing';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name   = 'classroom_challenges'
                    and column_name  = 'question_mode') then
    raise exception 'classroom_challenges.question_mode is missing';
  end if;

  raise notice 'Challenge functions repaired: one create signature, rooms table present, question policy present.';
end $$;


commit;
