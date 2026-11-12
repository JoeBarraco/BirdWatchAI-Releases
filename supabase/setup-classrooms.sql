-- ============================================================
-- BirdWatchAI Classroom Mode — phase 1
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-communities.sql and setup-community-tiers.sql: every
-- guard here delegates to community_role / community_require_role from
-- the first file, and section 1 re-shapes check constraints those files
-- created.
--
-- ON AN EXISTING DATABASE THIS IS THE ONLY FILE YOU NEED TO RUN.
-- Classroom mode also needed a one-line change inside community_invite
-- and community_invite_bulk, which live in those two earlier files.
-- Rather than send you back to re-run a 1500-line script that drops and
-- recreates the read policies on community_detections and feeders,
-- section 2b carries both functions here verbatim. Paste this file and
-- nothing else; the edits in the other two files are there so a FRESH
-- install lands in the same place.
--
-- Design notes: "BirdWatch AI – Classroom Mode (design notes)",
-- sections 7 (architecture), 8 (roles and permissions), 9A (teacher-led
-- voting) and 14 step 1 (build phase 1).
--
-- WHAT PHASE 1 IS
--   A classroom is a community-level entity with a home feeder, optional
--   partner feeders, a grade band and a teacher. The teacher runs a
--   session on the classroom projector, polls the room by hand, and taps
--   the class's answer. There are NO student accounts and no student
--   devices — those are phase 2 (join codes), and the tables here are
--   shaped so phase 2 adds rows beside them rather than rewriting them.
--
-- PRIVACY (design notes §8)
--   Most K–8 students are under 13, so COPPA applies. Nothing in this
--   file stores anything about a student: classroom_session_answers
--   holds one row per QUESTION, recording what the class as a whole
--   voted, never who voted. The only user ids stored are staff —
--   teacher_user_id and started_by, both adults with community accounts.
--   Phase 2's nicknames and session tokens get their own table with a
--   delete-on-end rule; keeping them out of here is deliberate, so that
--   "delete the session's student data" never has to mean deleting the
--   teacher's record of what the class got right.
--
-- SAFE TO RE-RUN.
-- ============================================================

create extension if not exists pgcrypto;


-- ────────────────────────────────────────────────────────────────────
-- 1. The 'teacher' role
--
-- Design notes §8: a teacher is "a member role, not a new login
-- system". So 'teacher' joins the existing enum on community_members
-- and community_invites rather than arriving as a parallel table — it
-- inherits magic-link auth, invite redemption and the roster UI for
-- free.
--
-- The check constraints were created inline by `create table` in
-- setup-communities.sql, so they carry generated names and `create
-- table if not exists` will not touch them on an existing database.
-- Drop whatever check constraint currently governs `role` and replace
-- it with a named one, so this is re-runnable and so a future change
-- has a name to target.
--
-- Where 'teacher' sits in the hierarchy: above viewer (it can create
-- classrooms and run sessions), below moderator (it cannot touch the
-- roster, approve feeders, or reach any other classroom). A teacher
-- account is the one most likely to be left signed in on a shared
-- classroom machine, which is exactly why it is given no power over
-- who can see the community.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  c record;
begin
  for c in
    select conname, conrelid::regclass as tbl
    from pg_constraint
    where contype = 'c'
      and conrelid in ('community_members'::regclass, 'community_invites'::regclass)
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table community_members
  add constraint community_members_role_check
  check (role in ('owner', 'moderator', 'teacher', 'viewer'));

-- Invites deliberately cannot mint an owner: ownership transfers are a
-- support conversation, not a mail-merge.
alter table community_invites
  add constraint community_invites_role_check
  check (role in ('moderator', 'teacher', 'viewer'));


-- Is this user a teacher (or better) in this community?
create or replace function community_is_staff(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select community_role(p_community_id, p_user_id)
           in ('owner', 'moderator', 'teacher');
$$;

grant execute on function community_is_staff(uuid, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 2. Promote or demote an existing member
--
-- Until now the only way to set a role was to invite the address with
-- it, which left no way to make a teacher out of somebody who had
-- already signed in — the exact case the Roland Park moderator hits
-- when she adds her staff first and sorts out who teaches afterwards.
--
-- The escalation rules mirror community_invite exactly: a moderator may
-- hand out 'teacher' and 'viewer', only the owner may hand out
-- 'moderator', and nobody may hand out or take away 'owner'.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_set_member_role(
  p_community_id uuid,
  p_user_id      uuid,
  p_role         text
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  my_role     text;
  target_role text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  my_role     := community_role(p_community_id, auth.uid());
  target_role := community_role(p_community_id, p_user_id);

  if target_role is null then
    raise exception 'That person is not a member of this community';
  end if;
  if p_role not in ('moderator', 'teacher', 'viewer') then
    raise exception 'Role must be moderator, teacher or viewer';
  end if;

  -- The owner row is the community's anchor: community_remove_member
  -- refuses to delete it, so it must not be demotable either, or the
  -- community ends up with no owner and no way back.
  if target_role = 'owner' then
    raise exception 'The community owner''s role cannot be changed';
  end if;
  if (p_role = 'moderator' or target_role = 'moderator') and my_role <> 'owner' then
    raise exception 'Only the community owner can add or remove moderators';
  end if;

  update community_members
     set role = p_role
   where community_id = p_community_id and user_id = p_user_id;

  return found;
end;
$$;

revoke execute on function community_set_member_role(uuid, uuid, text) from public;
revoke execute on function community_set_member_role(uuid, uuid, text) from anon;
grant  execute on function community_set_member_role(uuid, uuid, text) to authenticated;



-- ────────────────────────────────────────────────────────────────────
-- 2b. Teacher-aware invites
--
-- ⚠ THE TWO FUNCTIONS BELOW ARE VERBATIM COPIES.
--     community_invite       — setup-communities.sql      §9
--     community_invite_bulk  — setup-community-tiers.sql
--   Change one, change all three. They are duplicated here for one
--   reason: both needed a one-line change to accept 'teacher', and the
--   alternative — telling an existing deployment to re-run
--   setup-communities.sql — means re-running a 1500-line script whose
--   section 6 drops and recreates the SELECT policies on
--   community_detections and feeders. Getting one function definition
--   should not put the public feed at risk.
--
--   On a FRESH database the copies in the original files are already
--   teacher-aware, so running those first and this file second leaves
--   exactly the same definitions in place either way.
--
--   The rule being added, in both: a moderator may hand out 'teacher'
--   as well as 'viewer'; 'moderator' still requires the owner. A
--   teacher can run classrooms and nothing else, so a moderator
--   granting it gives away no access the moderator did not have.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_invite(
  p_community_id uuid,
  p_email        text,
  p_role         text default 'viewer'
)
returns json
language plpgsql security definer
as $$
declare
  my_role text;
  inv     community_invites%rowtype;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  my_role := community_role(p_community_id, auth.uid());
  if p_role not in ('viewer', 'teacher', 'moderator') then
    raise exception 'Role must be viewer, teacher or moderator';
  end if;
  if p_role = 'moderator' and my_role <> 'owner' then
    raise exception 'Only the community owner can invite moderators';
  end if;

  insert into community_invites (community_id, email, role, invited_by)
  values (p_community_id, lower(trim(p_email)), p_role, auth.uid())
  on conflict (community_id, email) do update
    set role       = excluded.role,
        invited_by = excluded.invited_by,
        expires_at = now() + interval '30 days',
        -- Re-inviting a revoked/expired address reopens it.
        redeemed_at = null,
        redeemed_by = null,
        token      = encode(gen_random_bytes(18), 'hex')
  returning * into inv;

  -- The caller (edge function) sends the mail; it needs the token.
  return json_build_object(
    'invite_id',  inv.id,
    'email',      inv.email,
    'role',       inv.role,
    'token',      inv.token,
    'expires_at', inv.expires_at
  );
end;
$$;


create or replace function community_invite_bulk(
  p_community_id uuid,
  p_emails       text[],
  p_role         text default 'viewer'
)
returns table (email text, status text, token text)
language plpgsql security definer
as $$
-- The RETURNS TABLE columns `email` and `token` are also PL/pgSQL variables, and
-- they collide with community_invites' own columns in `on conflict (…, email)`
-- and `returning *` — Postgres raises "column reference is ambiguous" and the
-- insert never runs. Tell PL/pgSQL that a bare name means the COLUMN; the OUT
-- values are only ever produced positionally by `return query`, never referenced
-- by name, so nothing here needs the variable meaning.
#variable_conflict use_column
declare
  my_role text;
  raw     text;
  addr    text;
  seen    text[] := '{}';
  inv     community_invites%rowtype;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  my_role := community_role(p_community_id, auth.uid());
  if p_role not in ('viewer', 'teacher', 'moderator') then
    raise exception 'Role must be viewer, teacher or moderator';
  end if;
  if p_role = 'moderator' and my_role <> 'owner' then
    raise exception 'Only the community owner can invite moderators';
  end if;

  -- Cap the batch. Unbounded input here is a way to make one request hold a
  -- transaction open for a very long time.
  if array_length(p_emails, 1) is null then
    return;
  end if;
  if array_length(p_emails, 1) > 1000 then
    raise exception 'Too many addresses at once — paste up to 1000 per batch (got %)',
      array_length(p_emails, 1);
  end if;

  foreach raw in array p_emails loop
    addr := lower(trim(raw));

    if addr = '' then
      continue;                                   -- blank lines in a paste
    end if;

    -- Deliberately loose: the authoritative check is whether the invite is
    -- ever redeemed. Rejecting valid-but-unusual addresses is worse than
    -- accepting one that never gets claimed.
    if addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return query select addr, 'invalid'::text, null::text;
      continue;
    end if;

    if addr = any(seen) then
      return query select addr, 'duplicate'::text, null::text;
      continue;
    end if;
    seen := seen || addr;

    -- Already a member? Say so rather than creating an invite they can't use.
    if exists (
      select 1 from community_members m
        join auth.users u on u.id = m.user_id
       where m.community_id = p_community_id and lower(u.email) = addr
    ) then
      return query select addr, 'already_member'::text, null::text;
      continue;
    end if;

    insert into community_invites (community_id, email, role, invited_by)
    values (p_community_id, addr, p_role, auth.uid())
    on conflict (community_id, email) do update
      set role        = excluded.role,
          invited_by  = excluded.invited_by,
          expires_at  = now() + interval '30 days',
          redeemed_at = null,
          redeemed_by = null,
          token       = encode(gen_random_bytes(18), 'hex')
    returning * into inv;

    return query select inv.email, 'invited'::text, inv.token;
  end loop;
end;
$$;

revoke execute on function community_invite_bulk(uuid, text[], text) from public;
revoke execute on function community_invite_bulk(uuid, text[], text) from anon;
grant  execute on function community_invite_bulk(uuid, text[], text) to authenticated;

grant execute on function community_invite(uuid, text, text) to authenticated;

-- ────────────────────────────────────────────────────────────────────
-- 3. Tables (design notes §7)
--
-- A classroom belongs to the COMMUNITY, not to a feeder. Two facts
-- force that: several classrooms share one home feeder (a kindergarten
-- class and an 8th-grade class both watch the courtyard feeder), and a
-- classroom's partner feeders belong to other people entirely. Hanging
-- it off feeders would make the second case a cross-owner write.
--
-- No foreign keys to auth.users, following the convention set in
-- setup-communities.sql §1 (fix-drop-auth-fkeys.sql dropped those so
-- `moderators` identities keep working). Plain uuid, no FK.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classrooms (
  id             uuid primary key default gen_random_uuid(),
  community_id   uuid not null references communities(id) on delete cascade,
  name           text not null,

  -- The feeder the class actually watches. Nullable, and ON DELETE SET
  -- NULL rather than CASCADE: a feeder being retired must not silently
  -- delete a teacher's classroom and its term of results. The UI shows
  -- "pick a new home feeder" instead.
  home_feeder_id uuid references feeders(id) on delete set null,

  grade_band     text not null default 'k-2'
                   check (grade_band in ('k-2', '3-5', '6-8')),

  -- How far out questions may reach for their data. 'home' is the whole
  -- of phase 1; 'partner' and 'community' are accepted here so a
  -- classroom created now does not need a migration when phase 4 lands.
  question_scope text not null default 'home'
                   check (question_scope in ('home', 'partner', 'community')),

  teacher_user_id uuid not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz
);

create index if not exists idx_classrooms_community
  on classrooms(community_id) where archived_at is null;
create index if not exists idx_classrooms_teacher
  on classrooms(teacher_user_id);

-- Partner feeders: the comparison set, and the fallback when the home
-- feeder is quiet (design notes §3, §5). A bare join table — the order
-- carries no meaning and a feeder is either a partner or it isn't.
create table if not exists classroom_partner_feeders (
  classroom_id uuid not null references classrooms(id) on delete cascade,
  feeder_id    uuid not null references feeders(id)    on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (classroom_id, feeder_id)
);

-- One row per class period. 'teacher_led' is phase 1; 'join_code' is
-- reserved for phase 2 so the history view doesn't need reshaping when
-- the second mode arrives.
create table if not exists classroom_sessions (
  id            uuid primary key default gen_random_uuid(),
  classroom_id  uuid not null references classrooms(id) on delete cascade,
  mode          text not null default 'teacher_led'
                  check (mode in ('teacher_led', 'join_code')),
  started_by    uuid not null,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  asked_count   integer not null default 0,
  correct_count integer not null default 0
);

create index if not exists idx_classroom_sessions_room
  on classroom_sessions(classroom_id, started_at desc);

-- One row per question asked, with the question frozen into it.
--
-- The prompt and choices are STORED rather than regenerated from the
-- template id. A template fills its slots from live detection data, so
-- re-running it next week produces a different question — and a results
-- screen that shows a different question from the one the class
-- answered is worse than no results screen. This is a record, not a
-- cache.
create table if not exists classroom_session_answers (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references classroom_sessions(id) on delete cascade,
  asked_at       timestamptz not null default now(),

  template_id    text not null,
  category       text not null,
  grade_band     text not null,
  scope          text not null default 'home',

  prompt         text not null,
  choices        jsonb not null default '[]'::jsonb,
  correct_index  integer,          -- null for a prediction, until it resolves
  class_index    integer,          -- what the teacher tapped on the class's behalf
  is_correct     boolean,

  -- Which feeder's data answered it, so a question drawn from a partner
  -- feeder during a quiet week can be labelled honestly on the results
  -- screen as well as on the projector.
  source_feeder_id uuid,
  detection_id     uuid,           -- the snapshot, for identification questions

  -- Prediction questions (design notes §4 category 5, §5): the class
  -- answers today and the data that settles it does not exist yet. The
  -- spec of the check is stored here and resolved on a later visit.
  pending_check    jsonb,
  resolve_after    timestamptz,
  resolved_at      timestamptz,
  resolved_actual  double precision
);

create index if not exists idx_classroom_answers_session
  on classroom_session_answers(session_id, asked_at);

-- Partial index for the "what is still waiting to be scored?" lookup,
-- which runs on every classroom open and must not scan the term.
create index if not exists idx_classroom_answers_pending
  on classroom_session_answers(resolve_after)
  where pending_check is not null and resolved_at is null;


-- ────────────────────────────────────────────────────────────────────
-- 4. RLS
--
-- Following the community_invites pattern from setup-communities.sql
-- §4: no SELECT policy for anon or authenticated at all. Everything
-- goes through the SECURITY DEFINER RPCs below, which apply the role
-- checks in one place. A classroom roster is a list of which teacher
-- watches which school feeder; it does not belong in reach of the
-- publishable key under any predicate.
-- ────────────────────────────────────────────────────────────────────

alter table classrooms                enable row level security;
alter table classroom_partner_feeders enable row level security;
alter table classroom_sessions        enable row level security;
alter table classroom_session_answers enable row level security;

drop policy if exists "Service role full access classrooms" on classrooms;
create policy "Service role full access classrooms" on classrooms
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access classroom partners" on classroom_partner_feeders;
create policy "Service role full access classroom partners" on classroom_partner_feeders
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access classroom sessions" on classroom_sessions;
create policy "Service role full access classroom sessions" on classroom_sessions
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access classroom answers" on classroom_session_answers;
create policy "Service role full access classroom answers" on classroom_session_answers
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 5. Permission helpers
--
-- Two different questions, deliberately kept apart:
--
--   classroom_require_manage — may the caller change this classroom or
--     run a session in it? The classroom's own teacher, or a moderator
--     or owner of its community. NOT every teacher in the school: a
--     6th-grade teacher has no business restarting the kindergarten's
--     session, and on a shared staff machine that is an accident
--     waiting rather than an attack.
--
--   community_require_role(…, teacher) — may the caller create a
--     classroom here at all?
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_require_manage(p_classroom_id uuid)
returns classrooms
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
  r    text;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;

  select * into room from classrooms where id = p_classroom_id;
  if room.id is null then
    raise exception 'Classroom not found';
  end if;

  if room.teacher_user_id = auth.uid() then
    return room;
  end if;

  r := community_role(room.community_id, auth.uid());
  if r in ('owner', 'moderator') then
    return room;
  end if;

  -- Same message whether the classroom is someone else's or does not
  -- exist, so this cannot be used to enumerate a school's classrooms.
  raise exception 'Classroom not found';
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Classroom CRUD
-- ────────────────────────────────────────────────────────────────────

/**
 * Classrooms the caller can run, newest first.
 *
 * A teacher sees their own; a moderator or owner sees every classroom
 * in the community, because somebody has to be able to fix a classroom
 * whose teacher has left mid-term.
 *
 * Returns the home feeder's display name and the partner feeder list
 * inline: the client needs both to render a classroom card, and three
 * round-trips per card is the difference between a panel that opens and
 * one that flickers.
 */
create or replace function classroom_list(p_community_id uuid)
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

  select json_agg(row_to_json(t) order by t.created_at desc) into result
  from (
    select c.id,
           c.name,
           c.grade_band,
           c.question_scope,
           c.home_feeder_id,
           f.display_name           as home_feeder_name,
           f.last_heartbeat_at      as home_feeder_seen_at,
           c.teacher_user_id,
           coalesce(nullif(p.display_name, ''), u.email, 'Teacher') as teacher_label,
           (c.teacher_user_id = auth.uid())                         as is_mine,
           c.created_at,
           coalesce((
             select json_agg(json_build_object(
                      'feeder_id',    pf.feeder_id,
                      'display_name', pfd.display_name)
                    order by pfd.display_name)
             from classroom_partner_feeders pf
             join feeders pfd on pfd.id = pf.feeder_id
             where pf.classroom_id = c.id
           ), '[]'::json)           as partners,
           (select max(s.started_at) from classroom_sessions s
             where s.classroom_id = c.id)                           as last_session_at,
           (select count(*) from classroom_sessions s
             where s.classroom_id = c.id)                           as session_count
    from classrooms c
    left join feeders       f on f.id = c.home_feeder_id
    left join user_profiles p on p.id = c.teacher_user_id
    left join auth.users    u on u.id = c.teacher_user_id
    where c.community_id = p_community_id
      and c.archived_at is null
      and (r in ('owner', 'moderator') or c.teacher_user_id = auth.uid())
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


/**
 * Create a classroom. Teacher, moderator or owner.
 *
 * The home feeder must be APPROVED in this community. Letting a teacher
 * point a classroom at an arbitrary feeder id would turn classroom mode
 * into a way to read any feeder's detections through a projector screen
 * — the one place on the site where nobody is looking at the URL.
 */
create or replace function classroom_create(
  p_community_id   uuid,
  p_name           text,
  p_home_feeder_id uuid,
  p_grade_band     text default 'k-2',
  p_question_scope text default 'home'
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'A classroom needs a name';
  end if;
  if length(trim(p_name)) > 80 then
    raise exception 'Classroom name is too long (80 characters max)';
  end if;

  if p_home_feeder_id is not null and not exists (
    select 1 from community_feeders
    where community_id = p_community_id
      and feeder_id    = p_home_feeder_id
      and status       = 'approved'
  ) then
    raise exception 'That feeder is not part of this community';
  end if;

  insert into classrooms (community_id, name, home_feeder_id, grade_band,
                          question_scope, teacher_user_id, created_by)
  values (p_community_id, trim(p_name), p_home_feeder_id,
          coalesce(p_grade_band, 'k-2'), coalesce(p_question_scope, 'home'),
          auth.uid(), auth.uid())
  returning * into room;

  return row_to_json(room);
end;
$$;


/**
 * Change a classroom. Null arguments mean "leave alone", so the client
 * can send one field without reading the row back first.
 *
 * p_teacher_user_id is owner/moderator only: a teacher handing their own
 * classroom to someone else is a roster decision, and letting a teacher
 * assign a classroom TO another teacher would make "teacher" a way to
 * put work in a colleague's list.
 */
create or replace function classroom_update(
  p_classroom_id    uuid,
  p_name            text default null,
  p_home_feeder_id  uuid default null,
  p_grade_band      text default null,
  p_question_scope  text default null,
  p_teacher_user_id uuid default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
begin
  room := classroom_require_manage(p_classroom_id);

  if p_name is not null and length(trim(p_name)) = 0 then
    raise exception 'A classroom needs a name';
  end if;
  if p_name is not null and length(trim(p_name)) > 80 then
    raise exception 'Classroom name is too long (80 characters max)';
  end if;

  if p_home_feeder_id is not null and not exists (
    select 1 from community_feeders
    where community_id = room.community_id
      and feeder_id    = p_home_feeder_id
      and status       = 'approved'
  ) then
    raise exception 'That feeder is not part of this community';
  end if;

  if p_teacher_user_id is not null then
    if community_role(room.community_id, auth.uid()) not in ('owner', 'moderator') then
      raise exception 'Only a community moderator can reassign a classroom';
    end if;
    if not community_is_staff(room.community_id, p_teacher_user_id) then
      raise exception 'That person is not a teacher in this community';
    end if;
  end if;

  update classrooms
     set name            = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         home_feeder_id  = coalesce(p_home_feeder_id, home_feeder_id),
         grade_band      = coalesce(p_grade_band, grade_band),
         question_scope  = coalesce(p_question_scope, question_scope),
         teacher_user_id = coalesce(p_teacher_user_id, teacher_user_id)
   where id = p_classroom_id
  returning * into room;

  return row_to_json(room);
end;
$$;


/**
 * Delete a classroom and everything under it.
 *
 * A real delete, not an archive flag. The sessions cascade away with
 * it, and since none of them contain student data (see the header)
 * there is nothing here worth keeping once a teacher says the class is
 * over. `archived_at` stays on the table for a future "hide last
 * year's classrooms" without losing the results.
 */
create or replace function classroom_delete(p_classroom_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  perform classroom_require_manage(p_classroom_id);
  delete from classrooms where id = p_classroom_id;
  return found;
end;
$$;


/**
 * Replace the partner feeder set in one call.
 *
 * Set semantics, not add/remove: the UI is a multi-select, so sending
 * the whole list is both what the client naturally has and immune to
 * the half-applied state a sequence of adds and removes can leave
 * behind if one call fails.
 *
 * Partners must be approved in the same community and must not be the
 * home feeder — a classroom comparing a feeder with itself produces
 * questions whose answer is always "they're the same", which reads as
 * a broken question rather than as a misconfiguration.
 */
create or replace function classroom_partners_set(
  p_classroom_id uuid,
  p_feeder_ids   uuid[]
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
  ids  uuid[];
begin
  room := classroom_require_manage(p_classroom_id);

  ids := coalesce(p_feeder_ids, '{}'::uuid[]);

  if array_length(ids, 1) > 10 then
    raise exception 'Up to 10 partner feeders per classroom';
  end if;

  if exists (
    select 1 from unnest(ids) as fid
    where fid = room.home_feeder_id
       or not exists (
         select 1 from community_feeders cf
         where cf.community_id = room.community_id
           and cf.feeder_id    = fid
           and cf.status       = 'approved')
  ) then
    raise exception 'Partner feeders must be other approved feeders in this community';
  end if;

  delete from classroom_partner_feeders where classroom_id = p_classroom_id;

  insert into classroom_partner_feeders (classroom_id, feeder_id)
  select p_classroom_id, fid from unnest(ids) as fid
  on conflict do nothing;

  return coalesce((
    select json_agg(json_build_object('feeder_id', pf.feeder_id,
                                      'display_name', f.display_name)
                    order by f.display_name)
    from classroom_partner_feeders pf
    join feeders f on f.id = pf.feeder_id
    where pf.classroom_id = p_classroom_id
  ), '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 7. Sessions (design notes §9A — teacher-led)
-- ────────────────────────────────────────────────────────────────────

/**
 * Open a session and close any that were left open on this classroom.
 *
 * The close-the-stragglers step is not tidiness. A teacher-led session
 * ends when the bell rings, and the bell is not an event this system
 * can observe — the tab just gets closed. Without this, a classroom
 * accumulates open sessions forever and "how did the class do today?"
 * has to guess which one today is.
 */
create or replace function classroom_session_start(
  p_classroom_id uuid,
  p_mode         text default 'teacher_led'
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  sess classroom_sessions%rowtype;
begin
  perform classroom_require_manage(p_classroom_id);

  if coalesce(p_mode, 'teacher_led') <> 'teacher_led' then
    raise exception 'Only teacher-led sessions are available yet';
  end if;

  update classroom_sessions
     set ended_at = now()
   where classroom_id = p_classroom_id and ended_at is null;

  insert into classroom_sessions (classroom_id, mode, started_by)
  values (p_classroom_id, 'teacher_led', auth.uid())
  returning * into sess;

  return row_to_json(sess);
end;
$$;


/**
 * Record the class's answer to one question.
 *
 * p_question is the question as it was shown, built client-side by the
 * template engine:
 *
 *   { template_id, category, grade_band, scope, prompt,
 *     choices: [...], correct_index, class_index,
 *     source_feeder_id, detection_id,
 *     pending_check: {...}, resolve_after: "<iso>" }
 *
 * correct_index is null exactly when the question is a prediction: the
 * data that settles it does not exist yet, so is_correct stays null
 * until classroom_resolve_prediction runs.
 *
 * The running totals on the session row are maintained here rather than
 * computed on read, so the history list is one query over a handful of
 * session rows instead of an aggregate over every question of the term.
 */
create or replace function classroom_session_record(
  p_session_id uuid,
  p_question   jsonb
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id    uuid;
  ans        classroom_session_answers%rowtype;
  correct_ix integer;
  class_ix   integer;
  ok         boolean;
begin
  select classroom_id into room_id from classroom_sessions where id = p_session_id;
  if room_id is null then
    raise exception 'Session not found';
  end if;
  perform classroom_require_manage(room_id);

  if p_question is null or jsonb_typeof(p_question) <> 'object' then
    raise exception 'A question object is required';
  end if;
  if coalesce(p_question->>'prompt', '') = '' then
    raise exception 'A question needs a prompt';
  end if;
  if length(p_question->>'prompt') > 500 then
    raise exception 'Question prompt is too long';
  end if;
  if jsonb_typeof(coalesce(p_question->'choices', '[]'::jsonb)) <> 'array' then
    raise exception 'Question choices must be a list';
  end if;
  if jsonb_array_length(coalesce(p_question->'choices', '[]'::jsonb)) > 8 then
    raise exception 'Too many choices for one question';
  end if;

  correct_ix := nullif(p_question->>'correct_index', '')::integer;
  class_ix   := nullif(p_question->>'class_index',   '')::integer;
  ok         := case when correct_ix is null or class_ix is null
                     then null else correct_ix = class_ix end;

  insert into classroom_session_answers (
    session_id, template_id, category, grade_band, scope,
    prompt, choices, correct_index, class_index, is_correct,
    source_feeder_id, detection_id, pending_check, resolve_after)
  values (
    p_session_id,
    coalesce(p_question->>'template_id', 'unknown'),
    coalesce(p_question->>'category',    'unknown'),
    coalesce(p_question->>'grade_band',  'k-2'),
    coalesce(p_question->>'scope',       'home'),
    p_question->>'prompt',
    coalesce(p_question->'choices', '[]'::jsonb),
    correct_ix, class_ix, ok,
    nullif(p_question->>'source_feeder_id', '')::uuid,
    nullif(p_question->>'detection_id',     '')::uuid,
    case when jsonb_typeof(coalesce(p_question->'pending_check', 'null'::jsonb)) = 'object'
         then p_question->'pending_check' else null end,
    nullif(p_question->>'resolve_after', '')::timestamptz)
  returning * into ans;

  update classroom_sessions
     set asked_count   = asked_count + 1,
         correct_count = correct_count + case when ok then 1 else 0 end
   where id = p_session_id;

  return row_to_json(ans);
end;
$$;


create or replace function classroom_session_end(p_session_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
  sess    classroom_sessions%rowtype;
begin
  select classroom_id into room_id from classroom_sessions where id = p_session_id;
  if room_id is null then
    raise exception 'Session not found';
  end if;
  perform classroom_require_manage(room_id);

  update classroom_sessions
     set ended_at = coalesce(ended_at, now())
   where id = p_session_id
  returning * into sess;

  return row_to_json(sess);
end;
$$;


/**
 * Recent sessions with their questions, for the "how did we do?" view.
 *
 * Capped rather than paged: a teacher looking back over the term wants
 * the last few classes, and an unbounded version of this returns every
 * question of the year to a projector-attached browser.
 */
create or replace function classroom_session_history(
  p_classroom_id uuid,
  p_limit        integer default 10
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select json_agg(row_to_json(t) order by t.started_at desc) into result
  from (
    select s.id, s.started_at, s.ended_at, s.asked_count, s.correct_count,
           coalesce((
             select json_agg(json_build_object(
                      'id',             a.id,
                      'asked_at',       a.asked_at,
                      'category',       a.category,
                      'prompt',         a.prompt,
                      'choices',        a.choices,
                      'correct_index',  a.correct_index,
                      'class_index',    a.class_index,
                      'is_correct',     a.is_correct,
                      'pending',        (a.pending_check is not null and a.resolved_at is null),
                      'resolved_actual', a.resolved_actual)
                    order by a.asked_at)
             from classroom_session_answers a
             where a.session_id = s.id
           ), '[]'::json) as questions
    from classroom_sessions s
    where s.classroom_id = p_classroom_id
    order by s.started_at desc
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 8. Predictions (design notes §4 category 5, §5)
--
-- "Will tomorrow have more or fewer visits than today?" cannot be
-- scored when it is asked. The class's answer is recorded with a
-- pending_check describing what to measure and a resolve_after saying
-- when the measurement becomes possible; the client counts the real
-- detections once that time has passed and sends back the verdict.
--
-- The arithmetic is done client-side on purpose: the browser has
-- already loaded the classroom's detections to build this session's
-- questions, so re-deriving the count in SQL would be a second,
-- slower copy of the same rule — and a copy that could disagree with
-- the one the class watched on the projector.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_pending_predictions(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select json_agg(row_to_json(t) order by t.asked_at) into result
  from (
    select a.id, a.asked_at, a.prompt, a.choices, a.class_index,
           a.pending_check, a.resolve_after, a.source_feeder_id
    from classroom_session_answers a
    join classroom_sessions s on s.id = a.session_id
    where s.classroom_id = p_classroom_id
      and a.pending_check is not null
      and a.resolved_at is null
    -- 30 days, not forever: a prediction nobody came back for in a
    -- month is a class that moved on, and carrying it indefinitely
    -- turns the "ready to check" badge into permanent furniture.
      and a.asked_at > now() - interval '30 days'
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


create or replace function classroom_resolve_prediction(
  p_answer_id     uuid,
  p_actual        double precision,
  p_correct_index integer
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
  ans     classroom_session_answers%rowtype;
  ok      boolean;
begin
  select s.classroom_id into room_id
  from classroom_session_answers a
  join classroom_sessions s on s.id = a.session_id
  where a.id = p_answer_id;

  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  select * into ans from classroom_session_answers where id = p_answer_id;
  if ans.resolved_at is not null then
    return row_to_json(ans);          -- already scored; idempotent
  end if;

  ok := (p_correct_index is not null and ans.class_index is not null
         and p_correct_index = ans.class_index);

  update classroom_session_answers
     set correct_index   = p_correct_index,
         is_correct      = ok,
         resolved_actual = p_actual,
         resolved_at     = now()
   where id = p_answer_id
  returning * into ans;

  -- Keep the session tally honest: the question counted as asked when
  -- the class answered it, but it could not count as correct until now.
  if ok then
    update classroom_sessions
       set correct_count = correct_count + 1
     where id = ans.session_id;
  end if;

  return row_to_json(ans);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 9. Grants
--
-- Nothing here is reachable with the publishable key. Every function is
-- authenticated-only and re-checks the caller's role itself; the
-- revokes are explicit rather than relying on the default PUBLIC
-- execute grant being absent.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_list(uuid)',
    'classroom_create(uuid, text, uuid, text, text)',
    'classroom_update(uuid, text, uuid, text, text, uuid)',
    'classroom_delete(uuid)',
    'classroom_partners_set(uuid, uuid[])',
    'classroom_session_start(uuid, text)',
    'classroom_session_record(uuid, jsonb)',
    'classroom_session_end(uuid)',
    'classroom_session_history(uuid, integer)',
    'classroom_pending_predictions(uuid)',
    'classroom_resolve_prediction(uuid, double precision, integer)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;

-- classroom_require_manage is a building block for the above, never
-- called directly by a client.
revoke execute on function classroom_require_manage(uuid) from public;
revoke execute on function classroom_require_manage(uuid) from anon;
revoke execute on function classroom_require_manage(uuid) from authenticated;
