-- ════════════════════════════════════════════════════════════════════
--  Paid communities — tiers, unlock codes, and self-serve creation
-- ════════════════════════════════════════════════════════════════════
--
--  A Gumroad purchase mints a single-use unlock code. Redeeming it lets
--  that user create one community at the purchased tier and become its
--  owner. Public or private is the buyer's choice.
--
--  Tiers (one-time purchase, decided 2026-08-23):
--
--    small    1–5   feeders   $20   zrrzco
--    medium   6–25  feeders   $50   ppbud
--    large    26–100 feeders  $150  vdhkakw
--
--  WHAT THE FEE BUYS: a grouping of feeders, and control over whether
--  that grouping is private. That is all. It stacks on top of the
--  per-install software licences (100 feeders still owe 100 licences)
--  and does NOT include per-feeder media storage, which is a separate
--  subscription. Say so on the storefront — "buy a community" reads
--  like it includes the software.
--
--  MOST OF THE SUBSTRATE ALREADY EXISTS and is not rebuilt here:
--  communities.visibility (public|private, with location suppression on
--  private), community_members.role (owner|moderator|viewer),
--  community_invites (email + role + 30-day token), community_feeders
--  (pending|approved|rejected), and the RLS that hides private
--  communities end to end. This file adds only the tier, the cap, the
--  codes, and a user-facing creation path.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. Tier + cap on communities ────────────────────────────────────

alter table communities
  add column if not exists tier text not null default 'small'
    check (tier in ('small', 'medium', 'large'));

-- Denormalized from the tier rather than derived on every check. The cap is
-- read on each feeder approval, and a community that was upgraded needs its
-- limit raised without rewriting what 'medium' means for everyone else.
alter table communities
  add column if not exists feeder_limit int not null default 5
    check (feeder_limit > 0);

-- Which purchase created this community. Null for the communities that
-- predate paid tiers, and for any a platform moderator creates by hand.
alter table communities
  add column if not exists unlock_code_id uuid;

comment on column communities.feeder_limit is
  'Max APPROVED feeders. Enforced in community_decide_feeder, not on request — '
  'blocking at request time would make a full community silently swallow joins.';

/**
 * Feeder allowance for a tier. One place, so the storefront, the redeem path
 * and any future upgrade all agree on what "medium" means.
 */
create or replace function community_tier_limit(p_tier text)
returns int
language sql immutable
as $$
  select case p_tier
           when 'small'  then 5
           when 'medium' then 25
           when 'large'  then 100
           else 5
         end;
$$;

grant execute on function community_tier_limit(text) to anon, authenticated;

-- Existing communities keep working: they were all created by a moderator
-- before tiers existed, so give them the largest allowance rather than
-- retroactively capping someone at 5. Only touches rows still on the default.
update communities
   set tier = 'large', feeder_limit = community_tier_limit('large')
 where unlock_code_id is null
   and tier = 'small'
   and feeder_limit = 5;


-- ── 2. Unlock codes ─────────────────────────────────────────────────
--
-- Same shape as `licenses`: minted by the Gumroad webhook, one row per sale,
-- with the provenance kept so a dispute can be traced back. Single-use is
-- enforced by the partial unique index below plus the atomic claim in
-- community_redeem_unlock_code.

create table if not exists community_unlock_codes (
    id                 uuid primary key default gen_random_uuid(),

    -- The thing the buyer types. Human-transcribable: no O/0/I/1 confusion.
    code               text unique not null,
    tier               text not null check (tier in ('small', 'medium', 'large')),
    feeder_limit       int  not null check (feeder_limit > 0),

    customer_email     text not null,
    customer_name      text,

    -- 'gumroad' | 'manual'. Manual exists so a code can be issued by hand for
    -- support, a comp, or a school that paid by invoice — same as licenses.
    source             text not null default 'gumroad',
    gumroad_sale_id    text unique,
    gumroad_product_id text,
    is_test            boolean not null default false,

    issued_at          timestamptz not null default now(),

    -- Claim state. redeemed_by is the auth user who used it; community_id is
    -- what they created with it.
    redeemed_at        timestamptz,
    redeemed_by        uuid,
    community_id       uuid references communities(id) on delete set null,

    revoked_at         timestamptz,
    revoked_reason     text
);

create index if not exists idx_unlock_codes_email
  on community_unlock_codes(lower(customer_email));
create index if not exists idx_unlock_codes_unredeemed
  on community_unlock_codes(code) where redeemed_at is null;

-- A code creates at most one community, belt-and-braces alongside the
-- conditional update in the redeem function.
create unique index if not exists idx_unlock_codes_one_community
  on community_unlock_codes(id) where community_id is not null;

comment on table community_unlock_codes is
  'Gumroad-minted single-use codes that authorize creating one community at a tier. '
  'Redeem via community_redeem_unlock_code. Never exposed to anon — see the RLS below.';

alter table community_unlock_codes enable row level security;

-- No policy for anon at all: a code IS the credential, so a readable table is
-- a giveaway. Everything goes through the security-definer RPCs below, which
-- bypass RLS by design. The service role (the webhook) is unaffected by RLS.
-- Drop by the name we are about to create, or a re-run collides and aborts the
-- rest of the file — including the revokes below, which is how a second run
-- could leave the grants wider than the first run set them.
drop policy if exists "Owner can see their own redeemed codes" on community_unlock_codes;
create policy "Owner can see their own redeemed codes" on community_unlock_codes
  for select to authenticated
  using (redeemed_by = auth.uid());


-- ── 3. Redeem: create a community from a code ───────────────────────

/**
 * Validate an unlock code and create one community with the caller as owner.
 *
 * Everything happens in one statement-level transaction: the code is claimed
 * with a conditional UPDATE that only succeeds if it is still unredeemed, so
 * two concurrent redemptions of the same code cannot both create a community.
 * The claim comes FIRST for that reason — creating the community first and
 * marking the code afterwards would leave a window where a double-submit
 * yields two communities from one purchase.
 *
 * Deliberately a NEW function rather than a loosened community_create. That
 * function's execute is revoked from public/anon/authenticated on purpose: it
 * takes a caller-chosen owner id, and it was reachable through PostgREST from
 * 2026-04-06 to 2026-08-21. Widening it would reopen exactly that hole.
 */
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
  -- community_assert_slug_ok (section 8) so the two paths can't drift into
  -- accepting different addresses.
  perform community_assert_slug_ok(v_slug);

  -- Claim the code. The WHERE clause is the lock: only an unredeemed,
  -- unrevoked code matches, and only one caller can win it.
  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and redeemed_at is null
     and revoked_at is null
  returning id, tier, feeder_limit
    into v_code_id, v_tier, v_limit;

  if v_code_id is null then
    -- One message for all three cases (absent / already used / revoked) so the
    -- function can't be used to enumerate valid codes.
    raise exception 'That unlock code is not valid, or has already been used';
  end if;

  insert into communities (slug, name, visibility, owner_user_id,
                           suppress_location, tier, feeder_limit, unlock_code_id)
  values (v_slug, v_name, p_visibility, auth.uid(),
          p_visibility = 'private', v_tier, v_limit, v_code_id)
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


-- ── 4. Enforce the cap when a feeder is approved ────────────────────
--
-- Replaces community_decide_feeder. Same signature and same behaviour, plus
-- the cap. Enforced here rather than at request time so a full community
-- shows its owner a pending queue and a clear error, instead of silently
-- rejecting joins the feeder owner thinks are still pending.
--
-- Feeders already approved are never kicked out by a cap change: this only
-- refuses to add the one that would exceed it.

create or replace function community_decide_feeder(
  p_community_id uuid,
  p_feeder_id    uuid,
  p_decision     text
)
returns boolean
language plpgsql security definer
as $$
declare
  v_limit    int;
  v_approved int;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  if p_decision = 'approved' then
    select feeder_limit into v_limit
      from communities where id = p_community_id;

    select count(*) into v_approved
      from community_feeders
     where community_id = p_community_id
       and status = 'approved'
       -- Re-approving an already-approved feeder must not count twice.
       and feeder_id <> p_feeder_id;

    if v_approved >= coalesce(v_limit, 5) then
      raise exception
        'This community is at its limit of % feeders. Remove a feeder, or upgrade the community, to approve another.',
        v_limit;
    end if;
  end if;

  update community_feeders
     set status = p_decision, decided_at = now(), decided_by = auth.uid()
   where community_id = p_community_id and feeder_id = p_feeder_id;

  return found;
end;
$$;

-- Tightened while we're replacing it. The original only GRANTed to
-- authenticated, which leaves PUBLIC's implicit EXECUTE in place — so anon
-- could call it. It was never exploitable, because community_require_role
-- raises 'Sign-in required' when auth.uid() is null, but relying on the body
-- alone is how the 2026-04 incident happened. Defense in depth.
--
-- NOTE: 34 of the 37 security-definer community_* functions have this same
-- over-wide grant. Every one sampled is guarded in its body (auth.uid(),
-- device_key, or a moderator session token), so this is a missing layer rather
-- than an open door — but it is the exact pattern that let add_moderator ship
-- callable. Tracked in TODO.MD; not swept here, because revoking across 34
-- live functions in the same change as a payment feature is how you break
-- both at once.
revoke execute on function community_decide_feeder(uuid, uuid, text) from public;
revoke execute on function community_decide_feeder(uuid, uuid, text) from anon;
grant  execute on function community_decide_feeder(uuid, uuid, text) to authenticated;


-- ── 5. Tier status, for the owner UI ────────────────────────────────

/**
 * Where a community stands against its allowance. Drives the "12 of 25
 * feeders" line and whether the approve button is offered at all.
 */
create or replace function community_tier_status(p_community_id uuid)
returns table (
  tier            text,
  feeder_limit    int,
  approved_count  int,
  pending_count   int,
  slots_remaining int
)
language plpgsql security definer
as $$
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'viewer']);

  return query
    select c.tier,
           c.feeder_limit,
           (select count(*)::int from community_feeders f
             where f.community_id = c.id and f.status = 'approved'),
           (select count(*)::int from community_feeders f
             where f.community_id = c.id and f.status = 'pending'),
           greatest(0, c.feeder_limit -
             (select count(*)::int from community_feeders f
               where f.community_id = c.id and f.status = 'approved'))
      from communities c
     where c.id = p_community_id;
end;
$$;

revoke execute on function community_tier_status(uuid) from public;
revoke execute on function community_tier_status(uuid) from anon;
grant  execute on function community_tier_status(uuid) to authenticated;


-- ── 6. Audit ────────────────────────────────────────────────────────
-- Every security-definer function added here, and what may execute it.
-- Postgres grants EXECUTE to PUBLIC on every new function and every role is a
-- member of PUBLIC, so a revoke naming only anon/authenticated leaves the
-- function callable through PostgREST with the published anon key. That is not
-- theoretical — three helpers shipped that way and were reachable for four
-- months. Every revoke above names `public` first.
--
-- Confirm nothing here is exposed to anon:
--
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_user,
--          has_function_privilege('public',        p.oid, 'EXECUTE') as pub
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('community_redeem_unlock_code', 'community_tier_status',
--                        'community_decide_feeder', 'community_tier_limit')
--    order by 1;
--
-- Expected: redeem and tier_status are auth_user only (anon false, pub false);
-- decide_feeder the same; tier_limit is a pure lookup and may be public.

-- ── 7. Bulk invite ──────────────────────────────────────────────────
--
-- `community_invites` was keyed by email precisely so a roster could be
-- pasted in ("paste 400 addresses, get 400 pending invites" — see the table
-- comment in setup-communities.sql). This is the RPC that makes that one
-- round-trip instead of 400.
--
-- Same rules as community_invite, deliberately: same role guard, same
-- owner-only restriction on inviting moderators, same upsert that reopens a
-- revoked or expired address. Divergence between the two would mean a bulk
-- paste could grant something the single-invite form refuses.

/**
 * Invite many addresses at once. Returns one row per input so the UI can show
 * exactly which addresses took and which were rejected, rather than a count.
 *
 * Invalid and duplicate addresses are REPORTED, not fatal: a 400-line paste
 * from a school roster will contain a typo, and failing the whole batch for one
 * bad line would make the feature useless at the size it exists for.
 */
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
  if p_role not in ('viewer', 'moderator') then
    raise exception 'Role must be viewer or moderator';
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


-- ── 8. Slug validation, shared ──────────────────────────────────────
--
-- Extracted so redeem and reset can't drift. Two functions each carrying their
-- own copy of the regex and the reserved list is how you end up with an address
-- that one path accepts and the other rejects.

/**
 * Raise unless p_slug is a usable community address.
 *
 * p_allow_id lets a community keep its own slug — reset passes its own id so
 * "rename the display name, keep the address" isn't reported as a collision.
 */
create or replace function community_assert_slug_ok(p_slug text, p_allow_id uuid default null)
returns void
language plpgsql
as $$
begin
  if p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then
    raise exception 'Community address must be 3-40 characters, lowercase letters, numbers and hyphens, and cannot start or end with a hyphen';
  end if;
  if p_slug in ('admin', 'api', 'app', 'birdwatch', 'birdwatchai', 'community',
                'dashboard', 'feed', 'help', 'login', 'moderator', 'official',
                'public', 'private', 'settings', 'support', 'system', 'www') then
    raise exception 'That community address is reserved';
  end if;
  if exists (select 1 from communities
              where slug = p_slug
                and (p_allow_id is null or id <> p_allow_id)) then
    raise exception 'That community address is already taken';
  end if;
end;
$$;

revoke execute on function community_assert_slug_ok(text, uuid) from public;
revoke execute on function community_assert_slug_ok(text, uuid) from anon;
grant  execute on function community_assert_slug_ok(text, uuid) to authenticated;


-- ── 9. Owner reset ──────────────────────────────────────────────────
--
-- Start the community over: drop every feeder, clear everyone except the
-- owner, and rename it. The tier and the feeder allowance are kept, because
-- those are what was paid for.
--
-- There is deliberately NO owner-facing DELETE. Removing a feeder from its only
-- community makes it visible to nobody on the community site: is_public is
-- already false for a private-only feeder, and feeders_autojoin_public_trg fires
-- on feeder INSERT only, so nothing rejoins it to the public feed. After a reset
-- that is recoverable — the community still exists, the owner can re-approve and
-- the feeder's owner can re-request. After a delete it is not: the community is
-- gone, and someone else's feeder has silently gone dark through no action of
-- their own. An owner who genuinely wants out asks support, and
-- community_admin_delete already handles that safely (it refuses while feeders
-- remain). Reset covers the real cases — set up wrong, or a new school year.

/**
 * Reset a community to a fresh state, keeping its tier.
 *
 * Owner only, not moderator: it removes every feeder and every other member,
 * which is not something a delegated moderator should be able to do to the
 * owner's purchase.
 *
 * Returns what it cleared, so the UI can report it rather than claiming success
 * in the abstract.
 */
create or replace function community_owner_reset(
  p_community_id uuid,
  p_new_name     text,
  p_new_slug     text,
  p_visibility   text
)
returns json
language plpgsql security definer
as $$
declare
  v_slug      text := lower(trim(p_new_slug));
  v_name      text := trim(p_new_name);
  v_old_slug  text;
  n_feeders   int;
  n_members   int;
  n_invites   int;
begin
  -- Owner only. community_require_role raises for anyone else, including a
  -- moderator of this community.
  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  if p_visibility not in ('public', 'private') then
    raise exception 'Visibility must be public or private';
  end if;
  if v_name = '' then
    raise exception 'Community name is required';
  end if;

  select slug into v_old_slug from communities where id = p_community_id;
  if v_old_slug is null then
    raise exception 'No such community';
  end if;
  if v_old_slug = 'public' then
    raise exception 'The Public Feed cannot be reset';
  end if;

  -- Validated before anything is cleared: a rejected address must not cost the
  -- owner their feeders.
  perform community_assert_slug_ok(v_slug, p_community_id);

  -- Feeders first. The AFTER trigger on community_feeders recomputes
  -- feeders.is_public per removed row, so visibility stays consistent without
  -- touching it here.
  select count(*) into n_feeders from community_feeders where community_id = p_community_id;
  delete from community_feeders where community_id = p_community_id;

  -- Everyone except the owner, and every outstanding invite: "like they just
  -- bought it" means the roster is empty too, not just the feeder list.
  select count(*) into n_members from community_members
   where community_id = p_community_id and user_id <> auth.uid();
  delete from community_members
   where community_id = p_community_id and user_id <> auth.uid();

  select count(*) into n_invites from community_invites where community_id = p_community_id;
  delete from community_invites where community_id = p_community_id;

  update communities
     set name              = v_name,
         slug              = v_slug,
         visibility        = p_visibility,
         suppress_location = (p_visibility = 'private')
   where id = p_community_id;

  return json_build_object(
    'community_id',     p_community_id,
    'slug',             v_slug,
    'feeders_removed',  n_feeders,
    'members_removed',  n_members,
    'invites_cleared',  n_invites
  );
end;
$$;

revoke execute on function community_owner_reset(uuid, text, text, text) from public;
revoke execute on function community_owner_reset(uuid, text, text, text) from anon;
grant  execute on function community_owner_reset(uuid, text, text, text) to authenticated;


-- ── 10. Admin overview: every community, with owner and tier ────────
--
-- community_admin_list already returned every community regardless of
-- visibility, with feeder and member counts. Replaced here to add the two
-- things the platform admin actually asks for and couldn't see: WHO owns each
-- one, and which tier it's on against how much of it is used.
--
-- feeder_count previously counted every row in community_feeders including
-- pending and rejected ones, which made it disagree with the cap (the cap
-- counts approved only). Split into both, so neither number has to be
-- explained.

create or replace function community_admin_list(p_token text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  result     json;
begin
  admin_role := moderator_session_role(p_token);

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  select json_agg(row_to_json(t) order by t.name) into result
  from (
    select c.id, c.slug, c.name, c.visibility, c.created_at,
           c.tier, c.feeder_limit,
           -- Owner email, so a support request can be tied to a person. Comes
           -- from auth.users because communities only stores the user id.
           (select u.email from auth.users u where u.id = c.owner_user_id) as owner_email,
           c.owner_user_id,
           (select count(*) from community_feeders cf
             where cf.community_id = c.id and cf.status = 'approved')      as approved_count,
           (select count(*) from community_feeders cf
             where cf.community_id = c.id and cf.status = 'pending')       as pending_count,
           (select count(*) from community_feeders cf
             where cf.community_id = c.id)                                as feeder_count,
           (select count(*) from community_members m
             where m.community_id = c.id)                                 as member_count,
           -- Whether it came from a purchase, and which one. Null for the
           -- communities that predate tiers and for admin-created ones.
           c.unlock_code_id is not null                                    as from_purchase
    from communities c
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

-- Unchanged from the original: this is moderator-token authenticated rather
-- than JWT, so it has to be reachable by anon. The body is the guard.
grant execute on function community_admin_list(text) to anon;
