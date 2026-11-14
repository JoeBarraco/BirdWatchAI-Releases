-- ════════════════════════════════════════════════════════════════════
--  Schools are sized by CLASSROOMS, not feeders
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-school-subscription.sql and setup-school-purchase.sql.
--
--  WHY
--  Community tiers are sized by feeders, which is right for a birding
--  group and wrong for a school. Roland Park is the proof: three
--  classes, ONE feeder. On feeder pricing they are a $20 Small forever,
--  however many teachers join, because a school's cost has nothing to
--  do with how many bird feeders it owns and everything to do with how
--  much teaching it does.
--
--  So school products are sized by classrooms. The feeder allowance
--  stops being the dial and becomes a fixed, generous constant — one
--  number for a head teacher to think about instead of two.
--
--  Ladder: 5 / 25 / unlimited.
--
--  NULL MEANS UNLIMITED, and unlike school_expires_at that is safe
--  here. An absent term had to fail CLOSED, because the column sits on
--  every community whether or not anybody paid, and null-means-
--  perpetual would have given every new community free classrooms.
--  An absent classroom cap fails OPEN, and cannot be exploited: making
--  a classroom at all already requires kind = 'school' AND a live term,
--  both of which are checked in the same trigger, three lines above
--  this one. A community nobody paid for never reaches the cap test.
--  It also lets 'unlimited' be a real product rather than a magic
--  number like 9999 that turns up in somebody's invoice one day.
--
--  WHAT HAPPENS WHEN A SCHOOL IS OVER ITS LIMIT
--  Nothing, to what already exists. Same rule as a lapsed term: being
--  over the line stops you creating NEW classes and touches nothing
--  you have. A school that drops from 25 to 5 keeps all 25 running and
--  simply cannot add a 26th. Deleting a term's results because an
--  invoice shrank would be indefensible, and silently archiving them
--  is the same thing with extra steps.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. The cap ──────────────────────────────────────────────────────

alter table communities
  add column if not exists classroom_limit int;

alter table communities
  drop constraint if exists communities_classroom_limit_check;
alter table communities
  add  constraint communities_classroom_limit_check
  check (classroom_limit is null or classroom_limit > 0);

comment on column communities.classroom_limit is
  'How many active classrooms this school may have. NULL = unlimited. '
  'Set from the unlock code; see setup-school-classroom-limits.sql.';

alter table community_unlock_codes
  add column if not exists classroom_limit int;

alter table community_unlock_codes
  drop constraint if exists community_unlock_codes_classroom_limit_check;
alter table community_unlock_codes
  add  constraint community_unlock_codes_classroom_limit_check
  check (classroom_limit is null or classroom_limit > 0);

comment on column community_unlock_codes.classroom_limit is
  'Classroom allowance this code grants. NULL = unlimited.';


-- ── 2. Grandfathering ───────────────────────────────────────────────
--
-- Every school that exists now keeps unlimited classrooms. They were
-- sold a community, not a classroom allowance, and retroactively
-- capping somebody mid-term is the kind of change that is discovered
-- by a teacher who cannot make next week's class.
--
-- Nothing to do: the column defaults to null, which IS unlimited. Said
-- out loud because "the migration did nothing here" is otherwise
-- indistinguishable from "the migration forgot".


-- ── 3. How many are in use ──────────────────────────────────────────
--
-- Archived classrooms do not count. Archiving is how a school retires
-- last year's class without losing its results, and charging for
-- something nobody can open would make the archive button a trap.

create or replace function community_classroom_usage(p_community_id uuid)
returns json
language sql stable security definer
set search_path = public
as $$
  select json_build_object(
    'used',  (select count(*) from classrooms r
               where r.community_id = p_community_id and r.archived_at is null),
    'limit', c.classroom_limit,
    'room',  c.classroom_limit is null
             or (select count(*) from classrooms r
                  where r.community_id = p_community_id and r.archived_at is null)
                < c.classroom_limit)
  from communities c where c.id = p_community_id;
$$;

grant execute on function community_classroom_usage(uuid) to anon, authenticated;


-- ── 4. Enforcing it ─────────────────────────────────────────────────
--
-- Replaces the trigger function from setup-school-subscription.sql §4a,
-- keeping both of its existing jobs — school only, term live — and
-- adding the cap as a third. One function so there is exactly one
-- place that decides whether a classroom may be created, whichever
-- RPC is asking.
--
-- The count and the insert are in the same statement's transaction, so
-- two teachers creating the 5th and 6th class at the same instant
-- cannot both pass: the second sees the first's row.

create or replace function classroom_requires_school()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  st    text;
  lim   int;
  used  int;
begin
  st := community_school_state(new.community_id);

  if st = 'not_school' then
    raise exception
      'Classrooms are only available in a community set up as a school. '
      'Turn on "This community is a school" in the community settings first.';
  end if;

  if st = 'lapsed' then
    raise exception
      'This school''s subscription has ended, so new classrooms cannot be '
      'created. Existing results stay readable. Enter a renewal code in '
      'the community settings to start again.';
  end if;

  select classroom_limit into lim from communities where id = new.community_id;
  if lim is not null then
    select count(*) into used from classrooms
     where community_id = new.community_id and archived_at is null;
    if used >= lim then
      raise exception
        'This school''s plan covers % class%. Archive one you have finished '
        'with, or upgrade to add more.',
        lim, case when lim = 1 then '' else 'es' end;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_classrooms_school on classrooms;
create trigger trg_classrooms_school
  before insert on classrooms
  for each row execute function classroom_requires_school();


-- ── 5. Codes carry the allowance ────────────────────────────────────
--
-- Both purchase paths. Replaces the versions in
-- setup-school-purchase.sql §2 and setup-school-subscription.sql §6.
--
-- A RENEWAL may also change the allowance, because upgrading from 5
-- classes to 25 is the same transaction as paying for another year.
-- When a renewal code carries no allowance, the school keeps the one
-- it has rather than silently dropping to unlimited.

create or replace function community_redeem_unlock_code(
  p_code       text,
  p_slug       text,
  p_name       text,
  p_visibility text
)
returns uuid
language plpgsql security definer
as $$
declare
  v_code_id uuid;
  v_tier    text;
  v_limit   int;
  v_months  int;
  v_rooms   int;
  v_new_id  uuid;
  v_slug    text := lower(trim(p_slug));
  v_name    text := trim(p_name);
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;
  if p_visibility not in ('public', 'private') then
    raise exception 'Visibility must be public or private';
  end if;
  if v_name = '' then
    raise exception 'Community name is required';
  end if;

  perform community_assert_slug_ok(v_slug);

  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and product = 'community'
     and redeemed_at is null
     and revoked_at is null
  returning id, tier, feeder_limit, school_months, classroom_limit
    into v_code_id, v_tier, v_limit, v_months, v_rooms;

  if v_code_id is null then
    raise exception 'That unlock code is not valid, or has already been used';
  end if;

  insert into communities (slug, name, visibility, owner_user_id,
                           suppress_location, tier, feeder_limit, unlock_code_id,
                           kind, school_expires_at, classroom_limit)
  values (v_slug, v_name, p_visibility, auth.uid(),
          p_visibility = 'private', v_tier, v_limit, v_code_id,
          case when v_months is not null then 'school' else 'general' end,
          case when v_months is not null
               then now() + make_interval(months => v_months) end,
          v_rooms)
  returning id into v_new_id;

  insert into community_members (community_id, user_id, role)
  values (v_new_id, auth.uid(), 'owner')
  on conflict (community_id, user_id) do nothing;

  update community_unlock_codes
     set community_id = v_new_id
   where id = v_code_id;

  return v_new_id;
end;
$$;

revoke execute on function community_redeem_unlock_code(text, text, text, text) from public;
revoke execute on function community_redeem_unlock_code(text, text, text, text) from anon;
grant  execute on function community_redeem_unlock_code(text, text, text, text) to authenticated;


create or replace function community_apply_school_code(
  p_code         text,
  p_community_id uuid
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c           communities%rowtype;
  v_code_id   uuid;
  v_months    int;
  v_rooms     int;
  v_has_rooms boolean;
  v_base      timestamptz;
  v_new       timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;

  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  select * into c from communities where id = p_community_id;
  if c.id is null then
    raise exception 'Community not found';
  end if;

  if c.school_perpetual then
    raise exception
      'This community already has school mode permanently. Save the code '
      'for another one.';
  end if;

  -- Whether the code SAYS anything about classrooms has to be read from
  -- the row, not from the value: null means unlimited on a code that
  -- mentions it, and "leave what they have" on one that does not.
  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and product = 'school'
     and redeemed_at is null
     and revoked_at is null
  returning id, school_months, classroom_limit,
            (classroom_limit is not null)
    into v_code_id, v_months, v_rooms, v_has_rooms;

  if v_code_id is null then
    raise exception 'That code is not valid, or has already been used';
  end if;

  v_base := case
              when c.school_expires_at is not null
               and c.school_expires_at > now() then c.school_expires_at
              else now()
            end;
  v_new := v_base + make_interval(months => v_months);

  update communities
     set school_expires_at = v_new,
         kind              = 'school',
         classroom_limit   = case when v_has_rooms then v_rooms
                                  else classroom_limit end
   where id = p_community_id;

  update community_unlock_codes
     set community_id = p_community_id
   where id = v_code_id;

  return json_build_object(
    'community_id', p_community_id,
    'months',       v_months,
    'expires_at',   v_new,
    'classrooms',   community_classroom_usage(p_community_id),
    'state',        community_school_state(p_community_id));
end;
$$;

revoke execute on function community_apply_school_code(text, uuid) from public;
revoke execute on function community_apply_school_code(text, uuid) from anon;
grant  execute on function community_apply_school_code(text, uuid) to authenticated;


-- ── 6. The panel needs to show it ───────────────────────────────────
--
-- Replaces community_school_status from setup-school-subscription.sql
-- §8, adding the classroom usage so the panel can say "3 of 5" and
-- grey out "+ New class" BEFORE somebody fills in the form.

create or replace function community_school_status(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c  communities%rowtype;
  st text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  select * into c from communities where id = p_community_id;
  if c.id is null then
    raise exception 'Community not found';
  end if;

  st := community_school_state(p_community_id);

  return json_build_object(
    'community_id', c.id,
    'kind',         c.kind,
    'state',        st,
    'perpetual',    c.school_perpetual,
    'expires_at',   c.school_expires_at,
    'grace_ends_at', case
                       when c.school_expires_at is null then null
                       else c.school_expires_at + community_school_grace()
                     end,
    'days_left',    case
                      when c.school_perpetual or c.school_expires_at is null
                        then null
                      else floor(extract(epoch from
                             (c.school_expires_at - now())) / 86400)::int
                    end,
    'can_start',    st in ('perpetual', 'active', 'grace'),
    'classrooms',   community_classroom_usage(p_community_id),
    'is_owner',     c.owner_user_id = auth.uid());
end;
$$;

revoke execute on function community_school_status(uuid) from public;
revoke execute on function community_school_status(uuid) from anon;
grant  execute on function community_school_status(uuid) to authenticated;


-- ── 7. Minting, with an allowance ───────────────────────────────────
--
-- p_classrooms null means unlimited, which is the top of the ladder and
-- a real product rather than an oversight.
--
-- ⚠ THE OLD SIGNATURES ARE DROPPED FIRST, and they have to be.
-- `create or replace function` only replaces a function with the SAME
-- argument list; adding a parameter creates a SECOND overload beside
-- the old one. Both then have defaults covering a three-argument call,
-- so `community_mint_school_code(token, email, 12)` stops resolving at
-- all — "function is not unique". It fails in plain SQL and it fails
-- through PostgREST, which is the same overload trap the picks RPC hit
-- earlier in this project's history. Caught here by a test that called
-- the short form.

drop function if exists community_mint_school_code(text, text, int, text, text);
drop function if exists community_mint_school_community_code(text, text, text, int, text, text);

create or replace function community_mint_school_code(
  p_token          text,
  p_customer_email text,
  p_months         int    default 12,
  p_customer_name  text   default null,
  p_order_reference text  default null,
  p_classrooms     int    default null
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  alphabet   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate  text;
  made       text;
  rnd        bytea;
  i          int;
  attempt    int;
begin
  admin_role := moderator_session_role(p_token);
  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  if coalesce(trim(p_customer_email), '') = '' then
    raise exception 'customer_email is required';
  end if;
  if p_months is null or p_months < 1 or p_months > 60 then
    raise exception 'months must be between 1 and 60';
  end if;
  if p_classrooms is not null and p_classrooms < 1 then
    raise exception 'classrooms must be at least 1, or null for unlimited';
  end if;

  for attempt in 1..5 loop
    rnd := gen_random_bytes(12);
    candidate := 'BWS';
    for i in 1..12 loop
      if i % 4 = 1 then candidate := candidate || '-'; end if;
      candidate := candidate
                || substr(alphabet, 1 + (get_byte(rnd, i - 1) % 32), 1);
    end loop;

    begin
      insert into community_unlock_codes
        (code, product, school_months, classroom_limit, customer_email,
         customer_name, source, order_reference)
      values
        (candidate, 'school', p_months, p_classrooms,
         lower(trim(p_customer_email)), p_customer_name, 'manual',
         nullif(trim(p_order_reference), ''))
      returning code into made;
      exit;
    exception when unique_violation then
      made := null;
    end;
  end loop;

  if made is null then
    raise exception 'Could not mint a unique code; try again';
  end if;

  return json_build_object(
    'code', made, 'months', p_months, 'classrooms', p_classrooms,
    'email', lower(trim(p_customer_email)));
end;
$$;

revoke execute on function community_mint_school_code(text, text, int, text, text, int) from public;
revoke execute on function community_mint_school_code(text, text, int, text, text, int) from anon;
grant  execute on function community_mint_school_code(text, text, int, text, text, int) to authenticated;


create or replace function community_mint_school_community_code(
  p_token           text,
  p_customer_email  text,
  p_tier            text default 'medium',
  p_months          int  default 12,
  p_customer_name   text default null,
  p_order_reference text default null,
  p_classrooms      int  default null
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  alphabet   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate  text;
  made       text;
  rnd        bytea;
  v_limit    int;
  i          int;
  attempt    int;
begin
  admin_role := moderator_session_role(p_token);
  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  if coalesce(trim(p_customer_email), '') = '' then
    raise exception 'customer_email is required';
  end if;
  if p_tier not in ('small', 'medium', 'large') then
    raise exception 'tier must be small, medium or large';
  end if;
  if p_months is null or p_months < 1 or p_months > 60 then
    raise exception 'months must be between 1 and 60';
  end if;
  if p_classrooms is not null and p_classrooms < 1 then
    raise exception 'classrooms must be at least 1, or null for unlimited';
  end if;

  v_limit := community_tier_limit(p_tier);

  for attempt in 1..5 loop
    rnd := gen_random_bytes(12);
    candidate := 'BWC';
    for i in 1..12 loop
      if i % 4 = 1 then candidate := candidate || '-'; end if;
      candidate := candidate
                || substr(alphabet, 1 + (get_byte(rnd, i - 1) % 32), 1);
    end loop;

    begin
      insert into community_unlock_codes
        (code, product, tier, feeder_limit, school_months, classroom_limit,
         customer_email, customer_name, source, order_reference)
      values
        (candidate, 'community', p_tier, v_limit, p_months, p_classrooms,
         lower(trim(p_customer_email)), p_customer_name, 'manual',
         nullif(trim(p_order_reference), ''))
      returning code into made;
      exit;
    exception when unique_violation then
      made := null;
    end;
  end loop;

  if made is null then
    raise exception 'Could not mint a unique code; try again';
  end if;

  return json_build_object(
    'code', made, 'tier', p_tier, 'months', p_months,
    'classrooms', p_classrooms, 'email', lower(trim(p_customer_email)));
end;
$$;

revoke execute on function community_mint_school_community_code(text, text, text, int, text, text, int) from public;
revoke execute on function community_mint_school_community_code(text, text, text, int, text, text, int) from anon;
grant  execute on function community_mint_school_community_code(text, text, text, int, text, text, int) to authenticated;


commit;


-- ════════════════════════════════════════════════════════════════════
--  The ladder, for reference. Feeders are FIXED at the medium
--  allowance on every school product — classrooms are the only dial:
--
--    5 classes        25 feeders
--    25 classes       25 feeders
--    unlimited        25 feeders   (classroom_limit null)
--
--  Check a school's usage:
--    select slug, name, classroom_limit, community_classroom_usage(id)
--      from communities where kind = 'school';
-- ════════════════════════════════════════════════════════════════════
