-- ════════════════════════════════════════════════════════════════════
--  School mode becomes a dated subscription
-- ════════════════════════════════════════════════════════════════════
--
--  Until now `communities.kind = 'school'` was a free checkbox any
--  community OWNER could tick, and it unlocked classrooms permanently.
--  This makes it a term: an unlock code grants N months, and when the
--  term runs out the school stops being able to START things without
--  losing anything it has already done.
--
--  WHAT LAPSING DOES — and deliberately does not do
--  ────────────────────────────────────────────────
--  It does NOT set kind back to 'general'. Two reasons, both already
--  written into this codebase:
--
--    * community_set_kind refuses to turn school mode off while
--      classrooms exist, because "the teacher's panel empty, the term's
--      results still in the database" is a worse outcome than being
--      told to clear them out first. A lapse would recreate exactly
--      that situation, except nobody chose it.
--
--    * community_teacher_requires_school() downgrades a teacher to
--      viewer when their community is not a school. Flipping kind on
--      an unpaid invoice would quietly demote a school's whole staff,
--      and re-paying would not put them back.
--
--  So kind stays 'school' and the term gates ACTIONS instead:
--
--    blocked when lapsed   create a classroom, start a session
--    still allowed         results, session history, exports,
--                          predictions resolving, ending a session
--                          that is already running
--
--  The gates are TRIGGERS on the two inserts that matter, not edits to
--  the eighteen functions that call classroom_require_manage. That is
--  not laziness: six of those eighteen are reads (history, pending
--  predictions, participants) that must keep working after a lapse,
--  and two of them — classroom_session_start and classroom_session_end
--  — are defined twice, in setup-classrooms.sql and again in
--  setup-classroom-join.sql, so "edit the call site" means knowing
--  which copy a given database actually has. A trigger on the table is
--  true whichever function did the insert.
--
--  A lesson in progress is never interrupted. The gate is on INSERT
--  into classroom_sessions; once a session row exists, its questions,
--  votes and tallies run to the end of the hour.
--
--  PERPETUAL vs NEVER-ENTITLED
--  ───────────────────────────
--  licenses.expires_at uses null to mean perpetual, and that works
--  there because the ROW's existence is the entitlement. It cannot work
--  here: communities.school_expires_at lives on a row that exists
--  whether or not anybody paid, so null-means-perpetual would hand
--  every brand-new community free classrooms forever. Hence a separate
--  school_perpetual flag, and null expiry means NOT ENTITLED. The gate
--  fails closed; only an explicit backfill or an admin grant opens it.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
--
--  Wrapped in an explicit transaction. Every statement here is
--  transactional in Postgres, and the one thing worse than this file
--  failing is this file half-succeeding: a database with the new
--  columns but the old community_set_kind would sell a term that
--  nothing reads.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. The term on the community ────────────────────────────────────

alter table communities
  add column if not exists school_expires_at timestamptz;

-- Comped, grandfathered, or a school that paid once under the old
-- one-time deal. Kept separate from a far-future date because a date
-- that is a lie shows up in the owner's UI as "renews in 300 years".
alter table communities
  add column if not exists school_perpetual boolean not null default false;

comment on column communities.school_expires_at is
  'End of the paid school term. Null = no term. Null WITH school_perpetual '
  'false means not entitled — see setup-school-subscription.sql.';
comment on column communities.school_perpetual is
  'Grandfathered or comped school mode. Overrides school_expires_at.';


-- ── 2. Grandfathering ───────────────────────────────────────────────
--
-- Every community that is ALREADY a school when this runs gets a full
-- twelve months from today. They were promised a free checkbox and some
-- of them have classes in session; a migration that switched them off
-- on deploy day would be felt by teachers in a building, not by a
-- customer at a keyboard.
--
-- A YEAR, not perpetual. A perpetual grant is indistinguishable from a
-- bug for the rest of the product's life — nobody later can tell
-- whether a community has free classrooms because it was an early
-- school or because something failed to set a date. A term that has to
-- be renewed puts every school on the same footing after one year, and
-- a year is long enough that nobody is surprised.
--
-- school_perpetual still exists, for comps and support grants, but
-- nothing sets it automatically. community_set_school_term (see
-- setup-school-purchase.sql) is how a human does it on purpose.
--
-- Guarded on both columns, so re-running this file after real
-- subscriptions exist cannot reset a paying school's term or overwrite
-- a deliberate perpetual grant.

update communities
   set school_expires_at = now() + interval '12 months'
 where kind = 'school'
   and school_perpetual = false
   and school_expires_at is null;


-- ── 3. Is this community's school mode live? ────────────────────────

-- One place to change the grace window. Schools break for the summer,
-- and an annual renewal that falls due in July will be read in
-- September; a hard cutoff on the date means term starts with
-- classroom mode dead and nobody in the building to blame.
create or replace function community_school_grace()
returns interval
language sql immutable
as $$ select interval '30 days' $$;

create or replace function community_school_active(p_community_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((
    select c.kind = 'school'
       and (c.school_perpetual
            or (c.school_expires_at is not null
                and now() < c.school_expires_at + community_school_grace()))
      from communities c
     where c.id = p_community_id
  ), false);
$$;

-- Which of the five states, for the owner's UI and the error messages.
--   not_school | perpetual | active | grace | lapsed
create or replace function community_school_state(p_community_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when c.kind <> 'school'                              then 'not_school'
    when c.school_perpetual                              then 'perpetual'
    when c.school_expires_at is null                     then 'lapsed'
    when now() < c.school_expires_at                     then 'active'
    when now() < c.school_expires_at
                 + community_school_grace()              then 'grace'
    else                                                      'lapsed'
  end
  from communities c where c.id = p_community_id;
$$;

grant execute on function community_school_grace()            to anon, authenticated;
grant execute on function community_school_active(uuid)       to anon, authenticated;
grant execute on function community_school_state(uuid)        to anon, authenticated;


-- ── 4. The gates ────────────────────────────────────────────────────
--
-- 4a. Creating a classroom. Replaces the trigger function from
--     setup-community-kinds.sql §4, keeping its original job (school
--     only) and adding the term. Same trigger, same table — only the
--     body changes, so running this file after that one is enough.

create or replace function classroom_requires_school()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  st text;
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

  return new;
end;
$$;

drop trigger if exists trg_classrooms_school on classrooms;
create trigger trg_classrooms_school
  before insert on classrooms
  for each row execute function classroom_requires_school();


-- 4b. Starting a session. The gate that does the real work: a lapsed
--     school can still open the panel and read every result it ever
--     produced, but it cannot put a new lesson on the board.
--
--     On INSERT only. An UPDATE to classroom_sessions is how a session
--     ends and how its tallies are kept, and a class must never be
--     stranded mid-hour by a date passing.

create or replace function classroom_session_requires_term()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  cid uuid;
  st  text;
begin
  select community_id into cid from classrooms where id = new.classroom_id;
  if cid is null then
    return new;              -- classroom_require_manage already refused
  end if;

  st := community_school_state(cid);
  if st = 'lapsed' or st = 'not_school' then
    raise exception
      'This school''s subscription has ended, so a new lesson cannot be '
      'started. Results and history are still available. Enter a renewal '
      'code in the community settings to start again.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sessions_school_term on classroom_sessions;
create trigger trg_sessions_school_term
  before insert on classroom_sessions
  for each row execute function classroom_session_requires_term();


-- ── 5. Codes can now grant a term instead of a community ────────────
--
-- community_unlock_codes already mints one-per-sale rows with the
-- provenance kept. A school code is the same shape with a different
-- payload, so it goes in the same table rather than a parallel one
-- that would need its own revoke path, its own Gumroad branch and its
-- own support story.
--
-- tier and feeder_limit stop being universal: a school renewal buys
-- months, not feeders. They are relaxed to nullable and the shape is
-- enforced per product below.

alter table community_unlock_codes
  add column if not exists product text not null default 'community';

alter table community_unlock_codes
  add column if not exists school_months int;

-- `licenses` has had one of these since the beginning; the unlock-code
-- table never did, because every code came from Gumroad and
-- gumroad_sale_id was the reference. An invoiced school has a PO
-- number and no sale id, and putting one in the other's column makes
-- the Gumroad uniqueness constraint start rejecting purchase orders.
alter table community_unlock_codes
  add column if not exists order_reference text;

alter table community_unlock_codes alter column tier         drop not null;
alter table community_unlock_codes alter column feeder_limit drop not null;

alter table community_unlock_codes
  drop constraint if exists community_unlock_codes_product_check;
alter table community_unlock_codes
  add  constraint community_unlock_codes_product_check
  check (product in ('community', 'school'));

-- A community code needs a tier and a cap; a school code needs months.
-- Written as one constraint so neither kind of row can be half-filled.
alter table community_unlock_codes
  drop constraint if exists community_unlock_codes_shape;
alter table community_unlock_codes
  add  constraint community_unlock_codes_shape check (
       (product = 'community'
        and tier is not null and feeder_limit is not null)
    or (product = 'school'
        and school_months is not null and school_months > 0)
  );

comment on column community_unlock_codes.product is
  'community = creates a new community at a tier. school = adds or renews '
  'a school term on a community that already exists.';
comment on column community_unlock_codes.school_months is
  'Months of school mode this code grants. Null for community codes.';


-- ── 6. Apply a school code to a community you own ───────────────────
--
-- The one thing the purchase path could not do before: every existing
-- code CREATES a community. A renewal has to attach to one.
--
-- Order of operations is the opposite of what reads naturally, and
-- matches community_redeem_unlock_code for the same reason: everything
-- that can refuse the request is checked BEFORE the code is claimed, so
-- a teacher typing a code into the wrong community does not burn a
-- year's subscription on the error message.

create or replace function community_apply_school_code(
  p_code         text,
  p_community_id uuid
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c         communities%rowtype;
  v_code_id uuid;
  v_months  int;
  v_base    timestamptz;
  v_new     timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;

  -- Owner only, exactly like community_set_kind: a moderator
  -- administers a community, but what the community IS — and what it
  -- costs — is the owner's call.
  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  select * into c from communities where id = p_community_id;
  if c.id is null then
    raise exception 'Community not found';
  end if;

  -- Refused rather than silently swallowed. A perpetual community
  -- gains nothing from a dated code, and spending one on it is a
  -- support ticket with no way back.
  if c.school_perpetual then
    raise exception
      'This community already has school mode permanently. Save the code '
      'for another one.';
  end if;

  -- Claim. The WHERE clause is the lock: only an unredeemed, unrevoked
  -- school code matches, and only one caller can win it.
  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and product = 'school'
     and redeemed_at is null
     and revoked_at is null
  returning id, school_months into v_code_id, v_months;

  if v_code_id is null then
    -- One message for absent / already used / revoked / wrong product,
    -- so this cannot be used to enumerate valid codes.
    raise exception 'That code is not valid, or has already been used';
  end if;

  -- Renewing early must not cost the school the rest of its term, so a
  -- live term is extended from its END date. A lapsed one restarts from
  -- today — backdating would sell months that had already gone by.
  v_base := case
              when c.school_expires_at is not null
               and c.school_expires_at > now() then c.school_expires_at
              else now()
            end;
  v_new := v_base + make_interval(months => v_months);

  update communities
     set school_expires_at = v_new,
         kind              = 'school'
   where id = p_community_id;

  update community_unlock_codes
     set community_id = p_community_id
   where id = v_code_id;

  return json_build_object(
    'community_id', p_community_id,
    'months',       v_months,
    'expires_at',   v_new,
    'state',        community_school_state(p_community_id));
end;
$$;

revoke execute on function community_apply_school_code(text, uuid) from public;
revoke execute on function community_apply_school_code(text, uuid) from anon;
grant  execute on function community_apply_school_code(text, uuid) to authenticated;


-- ── 7. The checkbox stops granting school mode ──────────────────────
--
-- Replaces community_set_kind from setup-community-kinds.sql §5. The
-- 'general' half is unchanged, including its refusal to strand
-- classrooms. The 'school' half now needs a term that somebody paid
-- for.
--
-- Turning school mode back ON while the term still runs is free, and
-- has to be: an owner who ticks the box off by accident in October
-- must not have to buy the year again.

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
  else
    select * into c from communities where id = p_community_id;
    if c.id is null then
      raise exception 'Community not found';
    end if;

    -- Not community_school_active(): that reads kind, which is still
    -- 'general' at this point and would refuse every first purchase.
    -- The term itself is what is being checked here.
    if not (c.school_perpetual
            or (c.school_expires_at is not null
                and now() < c.school_expires_at + community_school_grace()))
    then
      raise exception
        'Classroom mode needs a school subscription. Enter an unlock code '
        'in the community settings to turn it on.';
    end if;
  end if;

  update communities set kind = p_kind where id = p_community_id
  returning * into c;

  return json_build_object(
    'id', c.id, 'name', c.name, 'kind', c.kind,
    'teachers_remaining', coalesce(n_teachers, 0),
    'school_state', community_school_state(c.id));
end;
$$;

revoke execute on function community_set_kind(uuid, text) from public;
revoke execute on function community_set_kind(uuid, text) from anon;
grant  execute on function community_set_kind(uuid, text) to authenticated;


-- ── 8. Status, for the panel ────────────────────────────────────────
--
-- Readable by staff, not just the owner. A teacher who finds "▶ On the
-- board" greyed out needs to be told why by the screen in front of
-- them, otherwise the first thing that happens is a phone call to the
-- person who owns the community, during a lesson.

create or replace function community_school_status(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c communities%rowtype;
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
    'is_owner',     c.owner_user_id = auth.uid());
end;
$$;

revoke execute on function community_school_status(uuid) from public;
revoke execute on function community_school_status(uuid) from anon;
grant  execute on function community_school_status(uuid) to authenticated;


-- ── 9. Minting codes by hand ────────────────────────────────────────
--
-- There is no Gumroad school product yet, and schools buy by purchase
-- order more often than by card — the tiers file already keeps a manual
-- path open "for a school that paid by invoice". This is that path, and
-- it is enough to sell a subscription today: invoice, mint, email the
-- code.
--
-- Same admin-token guard as record_manual_license and
-- community_admin_list.

create or replace function community_mint_school_code(
  p_token          text,
  p_customer_email text,
  p_months         int    default 12,
  p_customer_name  text   default null,
  p_order_reference text  default null
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  alphabet   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no I, O, 0, 1
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

  -- BWS- rather than the BWC- the webhook mints, so a support request
  -- that quotes a code says which product it is without a lookup.
  for attempt in 1..5 loop
    -- gen_random_bytes, not random(): a code IS the credential, and
    -- random() is a seeded PRNG whose stream a second session can
    -- follow. The alphabet is 32 characters and a byte is 256 values,
    -- so the modulo is exact and no character is favoured.
    rnd := gen_random_bytes(12);
    candidate := 'BWS';
    for i in 1..12 loop
      if i % 4 = 1 then candidate := candidate || '-'; end if;
      candidate := candidate
                || substr(alphabet, 1 + (get_byte(rnd, i - 1) % 32), 1);
    end loop;

    begin
      insert into community_unlock_codes
        (code, product, school_months, customer_email, customer_name,
         source, order_reference)
      values
        (candidate, 'school', p_months, lower(trim(p_customer_email)),
         p_customer_name, 'manual', nullif(trim(p_order_reference), ''))
      returning code into made;
      exit;
    exception when unique_violation then
      made := null;        -- collided; try another
    end;
  end loop;

  if made is null then
    raise exception 'Could not mint a unique code; try again';
  end if;

  return json_build_object(
    'code',   made,
    'months', p_months,
    'email',  lower(trim(p_customer_email)));
end;
$$;

revoke execute on function community_mint_school_code(text, text, int, text, text) from public;
revoke execute on function community_mint_school_code(text, text, int, text, text) from anon;
grant  execute on function community_mint_school_code(text, text, int, text, text) to authenticated;


-- ── 10. What this did not do ────────────────────────────────────────
--
--  * The purchase path is in setup-school-purchase.sql, which adds the
--    admin term grant and teaches community_redeem_unlock_code about
--    school_months. The webhook side is done; only the Gumroad
--    products themselves are still to be created.
--
--  * No renewal reminders. pg_cron, pg_net, Vault and Resend are
--    already wired up for the feedback digest, so the job is small —
--    but an annual term that falls due in July needs warning mail at
--    T-30, T-7 and on lapse, or the grace window is the only thing
--    standing between a school and a dead September.
-- ════════════════════════════════════════════════════════════════════

commit;
