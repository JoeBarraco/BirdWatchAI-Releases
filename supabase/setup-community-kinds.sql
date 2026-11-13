-- ============================================================
-- BirdWatchAI — community kind (school or not)
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql. Purely additive: one column, one
-- backfill, two trigger functions and one RPC. Nothing existing is
-- replaced, so no earlier file needs re-running.
--
-- WHY
-- Classroom mode arrived switched on for every community. A birding
-- group, a test community and a family's two feeders all got the
-- Classroom button and a 'teacher' option in the roster, none of which
-- mean anything to them. A classroom belongs to a school; the rest of
-- the site does not.
--
-- So a community now declares what it is, and the school-only features
-- answer to that rather than to whoever happens to be an owner.
--
-- WHERE IT IS ENFORCED, AND WHY NOT IN THE FUNCTIONS
-- 'teacher' can be granted from five places: community_invite (which
-- exists in two files), community_invite_bulk, community_set_member_role,
-- and invite redemption. Classrooms can be created from classroom_create.
-- Adding the same check to each would be six copies of one rule, and the
-- divergence that invites is exactly how the burned-in caption got missed
-- twice.
--
-- Triggers instead. One rule per table, at the point the row is written,
-- so every current path and every future one is covered whether or not
-- its author remembered. The cost is that the error surfaces as an
-- exception from a trigger rather than from the function the client
-- called, which is why both messages below say plainly what to do.
--
-- SAFE TO RE-RUN.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────
-- 1. The column
--
-- 'general' is the default because it is the honest description of
-- almost every community on the platform, and because defaulting to
-- 'school' would switch classroom mode on for everybody — the thing
-- this file exists to stop.
-- ────────────────────────────────────────────────────────────────────

alter table communities
  add column if not exists kind text not null default 'general';

do $$
begin
  alter table communities drop constraint if exists communities_kind_check;
  alter table communities
    add constraint communities_kind_check check (kind in ('general', 'school'));
end $$;

comment on column communities.kind is
  'general | school. Classroom mode and the teacher role are school-only; '
  'see the triggers in setup-community-kinds.sql.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Backfill from evidence, not from names
--
-- A community that already has a classroom is already being used as a
-- school, so marking it is a statement of fact rather than a guess.
-- Deliberately NOT matching on the name: "Roland Park K-8" looks like a
-- school and "Lincoln" does not, and a backfill that reads names would
-- be wrong in both directions on somebody else's data.
--
-- Every other community stays 'general' and its owner can say
-- otherwise. That is the safe direction: the worst case is a real
-- school having to tick one box, against classroom mode appearing
-- unbidden in a birding group's roster.
-- ────────────────────────────────────────────────────────────────────

update communities c
   set kind = 'school'
 where c.kind <> 'school'
   and exists (select 1 from classrooms r where r.community_id = c.id);


-- ────────────────────────────────────────────────────────────────────
-- 3. The teacher role is school-only
--
-- Fires on community_members and community_invites, which between them
-- are every way a role is recorded — including redemption, which copies
-- an invite's role into a membership.
--
-- Existing teacher rows in a community that is not a school are left
-- alone rather than demoted. Changing somebody's access as a side
-- effect of a migration is the kind of surprise that is very hard to
-- explain afterwards; §4 below makes the role inert there anyway, since
-- a teacher with no classrooms to create can do nothing.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_teacher_requires_school()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.role <> 'teacher' then
    return new;
  end if;
  if (select kind from communities where id = new.community_id) = 'school' then
    return new;
  end if;

  -- A person chose this one: an invite being written, or a role being
  -- changed on an existing member. Refuse it and say why.
  if tg_table_name = 'community_invites' or tg_op = 'UPDATE' then
    raise exception
      'The teacher role is only available in a community set up as a school. '
      'Turn on "This community is a school" in the community settings first.';
  end if;

  -- A membership INSERT is almost always community_redeem_invites, which
  -- claims EVERY outstanding invite for the address in one statement on
  -- sign-in. Raising there would abort the whole batch, so one stale
  -- teacher invite — from a community that has since turned school mode
  -- off — would lock that person out of every other community they were
  -- invited to, at the moment they sign in. Downgrade instead: they come
  -- in as a viewer, which is what the community can actually offer them,
  -- and an owner can promote them if it becomes a school again.
  new.role := 'viewer';
  return new;
end;
$$;

drop trigger if exists trg_members_teacher_school on community_members;
create trigger trg_members_teacher_school
  before insert or update of role on community_members
  for each row execute function community_teacher_requires_school();

drop trigger if exists trg_invites_teacher_school on community_invites;
create trigger trg_invites_teacher_school
  before insert or update of role on community_invites
  for each row execute function community_teacher_requires_school();


-- ────────────────────────────────────────────────────────────────────
-- 4. Classrooms are school-only
--
-- The gate that actually matters. classroom_create admits owners and
-- moderators as well as teachers, so without this an owner of any
-- community could still make a classroom whatever the roster says.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_requires_school()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if (select kind from communities where id = new.community_id) <> 'school' then
    raise exception
      'Classrooms are only available in a community set up as a school. '
      'Turn on "This community is a school" in the community settings first.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_classrooms_school on classrooms;
create trigger trg_classrooms_school
  before insert on classrooms
  for each row execute function classroom_requires_school();


-- ────────────────────────────────────────────────────────────────────
-- 5. Setting it
--
-- Owner only. A moderator administers a community; deciding what the
-- community IS is the owner's call, and it changes which features the
-- whole roster sees.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_set_kind(
  p_community_id uuid,
  p_kind         text
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  n_rooms    integer;
  n_teachers integer;
  c          communities%rowtype;
begin
  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  if p_kind not in ('general', 'school') then
    raise exception 'Kind must be general or school';
  end if;

  if p_kind = 'general' then
    -- Refused rather than cascaded. Turning the flag off with classrooms
    -- still in place would leave them unreachable but not deleted — the
    -- teacher's panel empty, the term's results still in the database —
    -- and "where did my classes go?" is a worse outcome than being told
    -- to clear them out first.
    select count(*) into n_rooms from classrooms
     where community_id = p_community_id and archived_at is null;
    if n_rooms > 0 then
      raise exception
        'This community still has % classroom(s). Delete them before turning off school mode.',
        n_rooms;
    end if;

    -- Teachers are reported, not demoted: the owner should decide what
    -- those people become.
    select count(*) into n_teachers from community_members
     where community_id = p_community_id and role = 'teacher';
  end if;

  update communities set kind = p_kind where id = p_community_id
  returning * into c;

  return json_build_object(
    'id', c.id, 'name', c.name, 'kind', c.kind,
    'teachers_remaining', coalesce(n_teachers, 0));
end;
$$;

revoke execute on function community_set_kind(uuid, text) from public;
revoke execute on function community_set_kind(uuid, text) from anon;
grant  execute on function community_set_kind(uuid, text) to authenticated;

-- The trigger functions are never called directly by a client.
revoke execute on function community_teacher_requires_school() from public;
revoke execute on function community_teacher_requires_school() from anon;
revoke execute on function community_teacher_requires_school() from authenticated;
revoke execute on function classroom_requires_school()         from public;
revoke execute on function classroom_requires_school()         from anon;
revoke execute on function classroom_requires_school()         from authenticated;
