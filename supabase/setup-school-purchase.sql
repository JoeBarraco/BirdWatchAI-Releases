-- ════════════════════════════════════════════════════════════════════
--  Buying a school: codes that CREATE one, and an admin grant
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-school-subscription.sql. Three things:
--
--    1. An admin RPC for setting a school's term by hand, so the
--       grandfathered perpetual grants can be turned into real dated
--       ones without a raw UPDATE against production.
--
--    2. community_redeem_unlock_code learns about school_months, so a
--       SINGLE Gumroad purchase can create a community that is already
--       a school with a term running. The alternative — buy a
--       community, then buy a school code, then apply it — is two
--       transactions and two emails for one decision, and the gap
--       between them is a support ticket waiting.
--
--    3. The redeem path now insists on product = 'community'. School
--       renewal codes go through community_apply_school_code and
--       nowhere else; without this a renewal code would be accepted as
--       a creation code and spend a year's subscription on a brand-new
--       empty community.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. Set a school's term by hand ──────────────────────────────────
--
-- Two jobs, and both of them are the kind of thing that otherwise gets
-- done with an UPDATE typed straight into the production SQL editor at
-- the end of a long day:
--
--   * converting a grandfathered perpetual school to a real dated term
--   * comping a school, extending one that paid late, or putting right
--     a renewal that went wrong
--
-- p_months null means perpetual. Anything else sets a dated term and
-- clears the perpetual flag, because a community that is both would
-- read as paid-up forever whatever the date said.
--
-- Same admin-token guard as record_manual_license and
-- community_admin_list. Identified by slug rather than id: an id is
-- copied from a dashboard, a slug is in the URL the school uses.

create or replace function community_set_school_term(
  p_token  text,
  p_slug   text,
  p_months int default 12
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  c          communities%rowtype;
  v_new      timestamptz;
begin
  admin_role := moderator_session_role(p_token);
  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  select * into c from communities where slug = lower(trim(p_slug));
  if c.id is null then
    raise exception 'No community with the address %', lower(trim(p_slug));
  end if;

  if p_months is not null and (p_months < 1 or p_months > 120) then
    raise exception 'months must be between 1 and 120, or null for perpetual';
  end if;

  if p_months is null then
    update communities
       set school_perpetual  = true,
           school_expires_at = null,
           kind              = 'school'
     where id = c.id;
    v_new := null;
  else
    -- From today, not from whatever the old expiry was. This is the
    -- function for "their year starts now"; extending an existing term
    -- is what a renewal code does, and conflating the two here would
    -- make a comp silently shorter than it looks.
    v_new := now() + make_interval(months => p_months);
    update communities
       set school_perpetual  = false,
           school_expires_at = v_new,
           kind              = 'school'
     where id = c.id;
  end if;

  return json_build_object(
    'slug',       c.slug,
    'name',       c.name,
    'perpetual',  p_months is null,
    'expires_at', v_new,
    'state',      community_school_state(c.id));
end;
$$;

revoke execute on function community_set_school_term(text, text, int) from public;
revoke execute on function community_set_school_term(text, text, int) from anon;
grant  execute on function community_set_school_term(text, text, int) to authenticated;


-- ── 2. A community code can carry a school term ─────────────────────
--
-- Replaces community_redeem_unlock_code from setup-community-tiers.sql
-- §3. Everything about the original is kept, including the reason it
-- exists as its own function rather than a loosened community_create
-- ("that function takes a caller-chosen owner id, and it was reachable
-- through PostgREST from 2026-04-06 to 2026-08-21").
--
-- Two changes:
--
--   * product = 'community' is now required. A school RENEWAL code
--     reaching this function would have created an empty community and
--     burned the year on it.
--
--   * school_months, when the code carries it, makes the new community
--     a school with a term already running. One purchase, one code, one
--     screen.

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

  -- Slug rules, checked before the code is spent: a rejected slug must not
  -- consume the purchase. Shared with community_owner_reset via
  -- community_assert_slug_ok so the two paths can't drift into accepting
  -- different addresses.
  perform community_assert_slug_ok(v_slug);

  -- Claim the code. The WHERE clause is the lock: only an unredeemed,
  -- unrevoked CREATION code matches, and only one caller can win it.
  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and product = 'community'
     and redeemed_at is null
     and revoked_at is null
  returning id, tier, feeder_limit, school_months
    into v_code_id, v_tier, v_limit, v_months;

  if v_code_id is null then
    -- One message for all of absent / already used / revoked / wrong
    -- product, so the function can't be used to enumerate valid codes.
    raise exception 'That unlock code is not valid, or has already been used';
  end if;

  insert into communities (slug, name, visibility, owner_user_id,
                           suppress_location, tier, feeder_limit, unlock_code_id,
                           kind, school_expires_at)
  values (v_slug, v_name, p_visibility, auth.uid(),
          p_visibility = 'private', v_tier, v_limit, v_code_id,
          case when v_months is not null then 'school' else 'general' end,
          case when v_months is not null
               then now() + make_interval(months => v_months) end)
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


-- ── 3. Minting a school-community code by hand ──────────────────────
--
-- The companion to community_mint_school_code: that one sells a
-- renewal, this one sells a school community outright. Same admin
-- guard, same BWC- prefix as every other creation code, because that
-- is what it is — the school term rides along on it.

create or replace function community_mint_school_community_code(
  p_token           text,
  p_customer_email  text,
  p_tier            text default 'small',
  p_months          int  default 12,
  p_customer_name   text default null,
  p_order_reference text default null
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

  -- Postgres owns the cap; mirror it onto the row so a later change to
  -- community_tier_limit cannot retroactively shrink a purchase.
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
        (code, product, tier, feeder_limit, school_months,
         customer_email, customer_name, source, order_reference)
      values
        (candidate, 'community', p_tier, v_limit, p_months,
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
    'code',   made,
    'tier',   p_tier,
    'months', p_months,
    'email',  lower(trim(p_customer_email)));
end;
$$;

revoke execute on function community_mint_school_community_code(text, text, text, int, text, text) from public;
revoke execute on function community_mint_school_community_code(text, text, text, int, text, text) from anon;
grant  execute on function community_mint_school_community_code(text, text, text, int, text, text) to authenticated;


commit;


-- ════════════════════════════════════════════════════════════════════
--  AFTERWARDS — convert the grandfathered perpetual schools
--
--  An earlier version of setup-school-subscription.sql grandfathered
--  every existing school to perpetual. The backfill grants twelve
--  months now, but it will not touch a row already marked perpetual —
--  a migration that silently un-perpetuals somebody is exactly the
--  surprise that guard exists to prevent. So those rows are converted
--  by hand, once.
--
--  First, see which they are:
--
--    select slug, name, kind, school_perpetual, school_expires_at
--      from communities where kind = 'school';
--
--  Then, IN THIS SQL EDITOR, where you are the database owner and no
--  token is involved:
--
--    update communities
--       set school_perpetual  = false,
--           school_expires_at = now() + interval '12 months'
--     where slug = '<slug>'
--    returning slug, name, school_perpetual, school_expires_at;
--
--  community_set_school_term above does the same thing and more, but
--  it is guarded by moderator_session_role, which wants a live Mod
--  login session token that expires after eight hours. That is the
--  right shape for doing this FROM THE APP, and the wrong shape for a
--  one-line correction in a SQL editor you already have open. Use the
--  function when you are comping a school later; use the update now.
--
--  Check it landed — the state should read 'active':
--
--    select slug, community_school_state(id) as state, school_expires_at
--      from communities where kind = 'school';
-- ════════════════════════════════════════════════════════════════════
