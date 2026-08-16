-- ============================================================
-- BirdWatchAI Communities Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Adds named communities (public or private) that feeders can request
-- to join and that users can be granted membership in. Private community
-- content is hidden from the anon key at the ROW LEVEL SECURITY layer,
-- because the anon key is public (it ships in every install and is
-- visible in browser devtools) and so any client-side filter is
-- decorative.
--
-- Design notes live in birdwatchai-server/docs/COMMUNITIES.md.
--
-- ORDER MATTERS. This script is written so that the read policies are
-- only swapped AFTER every existing feeder has been enrolled into the
-- default "Public" community and feeders.is_public has been backfilled.
-- Running the policy section early would instantly blank the public
-- feed. Sections are numbered; run the whole file top to bottom.
--
-- SAFE TO RE-RUN. Every statement is idempotent.
-- ============================================================

create extension if not exists pgcrypto;


-- ────────────────────────────────────────────────────────────────────
-- 1. Tables
--
-- No foreign keys to auth.users: fix-drop-auth-fkeys.sql deliberately
-- dropped those so `moderators` identities (which have no Supabase Auth
-- session) can use community features. New user_id columns follow that
-- convention — plain uuid, no FK.
-- ────────────────────────────────────────────────────────────────────

create table if not exists communities (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null,
  name              text not null,
  description       text not null default '',
  visibility        text not null default 'private'
                      check (visibility in ('public', 'private')),
  owner_user_id     uuid,
  -- Private communities default to hiding precise feeder coordinates.
  -- A school should not be publishing the exact location of a building
  -- full of children.
  suppress_location boolean not null default false,
  created_at        timestamptz not null default now()
);

-- Which feeders publish INTO a community. The join request is initiated
-- by the feeder (server-side), because device_key is the only proof of
-- feeder ownership and it only exists on the device.
create table if not exists community_feeders (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  feeder_id    uuid not null references feeders(id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid,
  unique (community_id, feeder_id)
);

create index if not exists idx_community_feeders_feeder
  on community_feeders(feeder_id, status);
create index if not exists idx_community_feeders_community
  on community_feeders(community_id, status);

-- Which PEOPLE may view a community. Independent of community_feeders.
create table if not exists community_members (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  user_id      uuid not null,
  role         text not null default 'viewer'
                 check (role in ('owner', 'moderator', 'viewer')),
  created_at   timestamptz not null default now(),
  unique (community_id, user_id)
);

create index if not exists idx_community_members_user
  on community_members(user_id, community_id);

-- Invites are keyed by EMAIL, not user id: when an owner invites
-- parent@example.com that person usually has no auth.users row yet, so
-- membership can't reference a user id. The membership materializes on
-- first sign-in (see community_redeem_invites). This is also what makes
-- bulk roster loading work — paste 400 addresses, get 400 pending
-- invites — and it makes an uninvited signup inert by construction.
create table if not exists community_invites (
  id           uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  email        text not null,
  role         text not null default 'viewer'
                 check (role in ('moderator', 'viewer')),
  token        text unique not null default encode(gen_random_bytes(18), 'hex'),
  expires_at   timestamptz not null default (now() + interval '30 days'),
  redeemed_at  timestamptz,
  redeemed_by  uuid,
  invited_by   uuid,
  created_at   timestamptz not null default now(),
  unique (community_id, email)
);

create index if not exists idx_community_invites_email
  on community_invites(lower(email)) where redeemed_at is null;


-- ────────────────────────────────────────────────────────────────────
-- 2. feeders.is_public — denormalized visibility flag
--
-- The natural predicate ("is this feeder approved in a public
-- community?") is a join executed per row against a feed query
-- returning thousands of detections. Denormalizing to a boolean on
-- feeders turns the anon read policy into a primary-key lookup on a
-- small table.
--
-- The flag lives on feeders rather than community_detections on
-- purpose: one row per feeder instead of one per detection, so a
-- membership change is a single-row update rather than a rewrite of the
-- feeder's entire history.
-- ────────────────────────────────────────────────────────────────────

alter table feeders
  add column if not exists is_public boolean not null default true;

create index if not exists idx_feeders_is_public on feeders(is_public);

create or replace function community_refresh_feeder_visibility(p_feeder_id uuid)
returns void
language plpgsql security definer
as $$
begin
  if p_feeder_id is null then
    return;
  end if;

  update feeders
     set is_public = exists (
           select 1
           from community_feeders cf
           join communities c on c.id = cf.community_id
           where cf.feeder_id = p_feeder_id
             and cf.status = 'approved'
             and c.visibility = 'public'
         )
   where id = p_feeder_id;
end;
$$;

-- Recompute when a feeder's membership changes.
create or replace function community_feeders_visibility_trg()
returns trigger
language plpgsql security definer
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform community_refresh_feeder_visibility(new.feeder_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform community_refresh_feeder_visibility(old.feeder_id);
  end if;
  return null;
end;
$$;

drop trigger if exists community_feeders_visibility on community_feeders;
create trigger community_feeders_visibility
  after insert or update or delete on community_feeders
  for each row execute function community_feeders_visibility_trg();

-- Recompute every member feeder when a community flips public<->private.
create or replace function communities_visibility_trg()
returns trigger
language plpgsql security definer
as $$
begin
  if new.visibility is distinct from old.visibility then
    perform community_refresh_feeder_visibility(cf.feeder_id)
    from community_feeders cf
    where cf.community_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists communities_visibility on communities;
create trigger communities_visibility
  after update on communities
  for each row execute function communities_visibility_trg();


-- ────────────────────────────────────────────────────────────────────
-- 3. The default "Public" community + backfill
--
-- Modelling the public feed as a real community — rather than treating
-- "no membership" as implicitly public — keeps the model uniform and
-- gives public-feed policy somewhere to live later.
--
-- This MUST run before section 6 swaps the read policies, or the
-- signed-out feed goes blank.
-- ────────────────────────────────────────────────────────────────────

insert into communities (slug, name, description, visibility)
values ('public', 'Public Feed',
        'The open BirdWatchAI community feed. Every feeder starts here.',
        'public')
on conflict (slug) do nothing;

-- Enroll every existing feeder as approved.
insert into community_feeders (community_id, feeder_id, status, decided_at)
select c.id, f.id, 'approved', now()
from communities c
cross join feeders f
where c.slug = 'public'
on conflict (community_id, feeder_id) do nothing;

-- Backfill the flag for every feeder (the trigger only fires on change).
update feeders f
   set is_public = exists (
         select 1
         from community_feeders cf
         join communities c on c.id = cf.community_id
         where cf.feeder_id = f.id
           and cf.status = 'approved'
           and c.visibility = 'public'
       );

-- New feeders auto-join the public community, preserving today's
-- behaviour: a fresh install appears on the public feed without the
-- owner doing anything. They can leave it later to go private-only.
create or replace function feeders_autojoin_public_trg()
returns trigger
language plpgsql security definer
as $$
declare
  public_id uuid;
begin
  select id into public_id from communities where slug = 'public';
  if public_id is not null then
    insert into community_feeders (community_id, feeder_id, status, decided_at)
    values (public_id, new.id, 'approved', now())
    on conflict (community_id, feeder_id) do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists feeders_autojoin_public on feeders;
create trigger feeders_autojoin_public
  after insert on feeders
  for each row execute function feeders_autojoin_public_trg();


-- ────────────────────────────────────────────────────────────────────
-- 3b. Visibility helpers — MUST be defined before any policy uses them.
--
-- ⚠ Every one of these is SECURITY DEFINER, and that is the entire
-- point. A policy on community_members that itself SELECTs from
-- community_members re-triggers the same policy and Postgres aborts
-- with:
--     42P17: infinite recursion detected in policy for relation ...
-- A SECURITY DEFINER function runs as its owner, which bypasses RLS on
-- the tables it touches, breaking the cycle.
--
-- It is also much faster. Written inline, the community_detections
-- policy would evaluate the community_feeders policy, which evaluates
-- the communities policy, which evaluates the community_members policy
-- — a four-table policy cascade per detection row. These functions
-- collapse that to one uncached lookup, and being STABLE they can be
-- folded per statement.
--
-- search_path is pinned: an unqualified name inside a SECURITY DEFINER
-- function is otherwise resolvable against a caller-controlled schema.
-- ────────────────────────────────────────────────────────────────────

-- Is this user a member of this community (any role)?
create or replace function community_is_member(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1 from community_members
    where community_id = p_community_id and user_id = p_user_id
  );
$$;

-- This user's role in a community, or null.
create or replace function community_role(p_community_id uuid, p_user_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select role from community_members
  where community_id = p_community_id and user_id = p_user_id;
$$;

-- Is this community visible to this user at all?
create or replace function community_visible_to(p_community_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from communities c
    where c.id = p_community_id
      and (c.visibility = 'public' or community_is_member(c.id, p_user_id))
  );
$$;

-- Is this feeder in at least one public community? Reads the
-- denormalized flag; SECURITY DEFINER so the feeders policy can call it
-- without recursing into itself.
create or replace function community_feeder_is_public(p_feeder_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select is_public from feeders where id = p_feeder_id), false);
$$;

-- Does this user reach this feeder through a community they belong to?
-- Deliberately touches only community_feeders + community_members, never
-- feeders — so it is safe to call from the feeders policy.
create or replace function community_user_sees_feeder(p_feeder_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1
    from community_feeders cf
    join community_members cm on cm.community_id = cf.community_id
    where cf.feeder_id = p_feeder_id
      and cf.status = 'approved'
      and cm.user_id = p_user_id
  );
$$;


-- A role that cannot EXECUTE a function used in a policy gets
-- "permission denied" when the policy is evaluated, which reads exactly
-- like a broken feed. Grant explicitly rather than relying on the
-- default PUBLIC execute grant.
grant execute on function community_is_member(uuid, uuid)         to anon, authenticated;
grant execute on function community_role(uuid, uuid)              to anon, authenticated;
grant execute on function community_visible_to(uuid, uuid)        to anon, authenticated;
grant execute on function community_feeder_is_public(uuid)        to anon, authenticated;
grant execute on function community_user_sees_feeder(uuid, uuid)  to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 4. RLS on the new tables
-- ────────────────────────────────────────────────────────────────────

alter table communities        enable row level security;
alter table community_feeders  enable row level security;
alter table community_members  enable row level security;
alter table community_invites  enable row level security;

-- Communities: public ones are discoverable by anyone (so a feeder
-- owner can find one to join); private ones only by their members.
drop policy if exists "Public communities are visible" on communities;
create policy "Public communities are visible" on communities
  for select using (
    visibility = 'public'
    or community_is_member(id, auth.uid())
  );

drop policy if exists "Service role full access communities" on communities;
create policy "Service role full access communities" on communities
  for all to service_role using (true) with check (true);

-- Memberships: you can see your own, and owners/mods see their
-- community's roster. Everything else flows through the RPCs below.
-- ⚠ This is the policy that caused 42P17 when it was written inline:
-- selecting from community_members inside community_members' own policy
-- recurses. community_role is SECURITY DEFINER and so bypasses RLS.
drop policy if exists "Members see own membership" on community_members;
create policy "Members see own membership" on community_members
  for select using (
    user_id = auth.uid()
    or community_role(community_id, auth.uid()) in ('owner', 'moderator')
  );

drop policy if exists "Service role full access members" on community_members;
create policy "Service role full access members" on community_members
  for all to service_role using (true) with check (true);

-- Feeder memberships: readable for public communities (the dashboard
-- needs it to group the feed), and by members of private ones.
drop policy if exists "Community feeders are visible" on community_feeders;
create policy "Community feeders are visible" on community_feeders
  for select using (community_visible_to(community_id, auth.uid()));

drop policy if exists "Service role full access community feeders" on community_feeders;
create policy "Service role full access community feeders" on community_feeders
  for all to service_role using (true) with check (true);

-- Invites are never readable by anon or by ordinary members; they are
-- only ever touched through the SECURITY DEFINER RPCs below. No select
-- policy is defined on purpose.
drop policy if exists "Service role full access invites" on community_invites;
create policy "Service role full access invites" on community_invites
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 5. Role enforcement
--
-- community_role and the other visibility helpers are defined in
-- section 3b, because the policies in section 4 depend on them.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_require_role(
  p_community_id uuid,
  p_user_id      uuid,
  p_roles        text[]
)
returns void
language plpgsql security definer
as $$
declare
  r text;
begin
  if p_user_id is null then
    raise exception 'Sign-in required';
  end if;

  select community_role(p_community_id, p_user_id) into r;

  if r is null or not (r = any(p_roles)) then
    raise exception 'Insufficient permissions for this community';
  end if;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Read policies on the existing tables
--
-- ⚠ RUN ONLY AFTER SECTION 3 HAS COMPLETED. Postgres combines
-- permissive policies with OR, so any pre-existing "anon can select
-- everything" policy would defeat the new predicate — which is why the
-- old SELECT policies are dropped by name pattern first rather than
-- simply adding a new one alongside.
--
-- WRITE policies are deliberately left at qual=true, exactly matching
-- today's behaviour. Tightening them would break the server's own
-- writes to its private rows (ShareClipAsync / UpdateImageAsync PATCH
-- via the anon key) and every deployed WinForms install. The follow-up
-- is to route those writes through the device_key RPCs in section 7 and
-- then narrow these. Tracked in docs/COMMUNITIES.md.
-- ────────────────────────────────────────────────────────────────────

alter table community_detections enable row level security;
alter table feeders              enable row level security;

-- Drop every existing SELECT policy on the two tables so the new
-- predicate is authoritative rather than OR'd with a permissive one.
-- Every policy recreated below is explicit, so dropping the service_role
-- ones here too is safe — they are re-added at the end of this section.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where tablename in ('community_detections', 'feeders')
      and cmd in ('SELECT', 'ALL')
  loop
    execute format('drop policy if exists %I on %I.%I',
                   p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- Detections: public feeders are readable by anyone; private ones only
-- by members of a private community that feeder is approved in.
drop policy if exists "Community detections are visible" on community_detections;
create policy "Community detections are visible" on community_detections
  for select using (
    community_feeder_is_public(feeder_id)
    or community_user_sees_feeder(feeder_id, auth.uid())
  );

-- Feeders: same rule, so private feeders don't show up in the Feeders
-- tab, the map, or the feed's feeder dropdown.
-- Reads the is_public column directly rather than via
-- community_feeder_is_public — calling that from the feeders policy
-- would recurse into feeders.
drop policy if exists "Feeders are visible" on feeders;
create policy "Feeders are visible" on feeders
  for select using (
    is_public
    or community_user_sees_feeder(id, auth.uid())
  );

-- Preserve today's write access (see the note above).
drop policy if exists "Anon can write detections" on community_detections;
create policy "Anon can write detections" on community_detections
  for insert to anon, authenticated with check (true);

drop policy if exists "Anon can update detections" on community_detections;
create policy "Anon can update detections" on community_detections
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "Anon can delete detections" on community_detections;
create policy "Anon can delete detections" on community_detections
  for delete to anon, authenticated using (true);

drop policy if exists "Anon can register feeders" on feeders;
create policy "Anon can register feeders" on feeders
  for insert to anon, authenticated with check (true);

-- The feeders_anon_update_guard trigger (setup-feeders-update-guard.sql)
-- still protects id / device_key / subscription_* on this path.
drop policy if exists "Anon can update feeders" on feeders;
create policy "Anon can update feeders" on feeders
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "Service role full access detections" on community_detections;
create policy "Service role full access detections" on community_detections
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access feeders" on feeders;
create policy "Service role full access feeders" on feeders
  for all to service_role using (true) with check (true);

-- ⚠ feeder_status is a VIEW. Postgres views run with the DEFINER's
-- permissions unless created with security_invoker, which would
-- silently bypass every policy above. Force invoker semantics so the
-- view respects the caller's RLS. Requires PG15+ (Supabase is).
do $$
begin
  if exists (select 1 from pg_views where viewname = 'feeder_status') then
    execute 'alter view feeder_status set (security_invoker = on)';
  end if;
end $$;


-- ────────────────────────────────────────────────────────────────────
-- 7. Feeder-side RPCs (device_key authenticated)
--
-- The server holds the device_key; it is the only proof of feeder
-- ownership available off-device. These run SECURITY DEFINER so a
-- private feeder can still read and manage its OWN rows even though the
-- anon read policy hides them.
--
-- The one that actually breaks the product is community_feeder_id:
-- EnsureFeederRegisteredAsync resolves its own feeder uuid with a plain
-- SELECT on /feeders, and once that returns nothing the feeder stops
-- sharing entirely, silently. The rest degrade more gently (stale
-- edits, duplicate shares, a reconcile sweep that reports zero rows).
-- Ship all of these before any feeder goes private.
-- ────────────────────────────────────────────────────────────────────

-- ⚠ REQUIRED SERVER CHANGE. EnsureFeederRegisteredAsync currently
-- resolves its own feeder uuid with
--     GET /rest/v1/feeders?device_key=eq.{key}&select=id
-- Once section 6 gates feeders SELECT on visibility, a private feeder
-- can no longer see its own row through the anon key, that lookup
-- returns null, and the feeder stops sharing entirely. The server must
-- call this RPC instead.
create or replace function community_feeder_id(p_device_key text)
returns uuid
language sql stable security definer
as $$
  select id from feeders where device_key = p_device_key limit 1;
$$;

-- Resolve the feeder ids this device may act on.
--   'feeder' — just this device_key's row (used for idempotency checks,
--              where local_id values are only unique per feeder)
--   'name'   — every feeder sharing this one's display_name (used for
--              edit/delete propagation across stale identities, matching
--              GetAllFeederIdsForCurrentNameAsync)
create or replace function community_feeder_scope(p_device_key text, p_scope text)
returns setof uuid
language sql stable security definer
as $$
  select distinct f2.id
  from feeders f1
  join feeders f2
    on (p_scope = 'name' and f2.display_name = f1.display_name)
    or f2.id = f1.id
  where f1.device_key = p_device_key;
$$;

-- Page a feeder's own community rows. Mirrors the SELECT in
-- ReconcileWithLocalAsync.
create or replace function community_feeder_rows(
  p_device_key text,
  p_limit      int default 1000,
  p_offset     int default 0
)
returns json
language plpgsql security definer
as $$
declare
  fid    uuid;
  result json;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    raise exception 'Unknown device key';
  end if;

  select json_agg(row_to_json(t)) into result
  from (
    select id, local_id, detected_at, species, rarity, image_url, video_url
    from community_detections
    where feeder_id = fid
    order by detected_at desc
    limit greatest(1, least(coalesce(p_limit, 1000), 1000))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

-- Resolve a local detection's community row(s). Mirrors
-- FindCommunityRowIdsAsync: local_id first, then (detected_at ±5s AND
-- species) for WinForms-imported rows whose community local_id is the
-- original WinForms id.
--
-- Returns whole rows rather than bare ids so RestoreFromCommunityAsync
-- can read image_url / video_url from the same call.
create or replace function community_feeder_find_rows(
  p_device_key   text,
  p_local_id     text,
  p_from         timestamptz,
  p_to           timestamptz,
  p_species      text,
  p_alt_species  text default null,
  p_scope        text default 'feeder'
)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  if community_feeder_id(p_device_key) is null then
    raise exception 'Unknown device key';
  end if;

  select json_agg(row_to_json(t) order by t.detected_at) into result
  from (
    select d.id, d.local_id, d.detected_at, d.species, d.rarity,
           d.image_url, d.video_url
    from community_detections d
    where d.feeder_id in (select community_feeder_scope(p_device_key, p_scope))
      and (
        d.local_id = p_local_id
        or (
          d.detected_at >= p_from
          and d.detected_at <= p_to
          and (d.species = p_species
               or (p_alt_species is not null and d.species = p_alt_species))
        )
      )
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

-- Which of these local ids have already been shared? Mirrors
-- GetSharedLocalIdsAsync (current feeder only, by design).
create or replace function community_feeder_shared_local_ids(
  p_device_key text,
  p_local_ids  text[]
)
returns json
language plpgsql security definer
as $$
declare
  fid    uuid;
  result json;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    raise exception 'Unknown device key';
  end if;

  select json_agg(distinct d.local_id) into result
  from community_detections d
  where d.feeder_id = fid
    and d.local_id = any(p_local_ids);

  return coalesce(result, '[]'::json);
end;
$$;

-- Communities this feeder could join, plus its current status in each.
create or replace function community_feeder_memberships(p_device_key text)
returns json
language plpgsql security definer
as $$
declare
  fid    uuid;
  result json;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    raise exception 'Unknown device key';
  end if;

  select json_agg(row_to_json(t) order by t.name) into result
  from (
    select c.id, c.slug, c.name, c.description, c.visibility,
           cf.status, cf.requested_at, cf.decided_at
    from communities c
    left join community_feeders cf
      on cf.community_id = c.id and cf.feeder_id = fid
    where c.visibility = 'public' or cf.id is not null
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

-- Request to join. Public communities could arguably auto-approve, but
-- they go through the same queue so an owner always has a kill switch.
-- Joining by slug keeps the server from needing to know community uuids.
create or replace function community_request_join(
  p_device_key text,
  p_slug       text
)
returns json
language plpgsql security definer
as $$
declare
  fid  uuid;
  cid  uuid;
  cvis text;
  st   text;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    raise exception 'Unknown device key';
  end if;

  select id, visibility into cid, cvis
  from communities where slug = lower(trim(p_slug));
  if cid is null then
    raise exception 'No such community';
  end if;

  insert into community_feeders (community_id, feeder_id, status)
  values (cid, fid, case when cvis = 'public' then 'approved' else 'pending' end)
  on conflict (community_id, feeder_id) do update
    set status = case
                   when community_feeders.status = 'rejected' then 'pending'
                   else community_feeders.status
                 end,
        requested_at = now()
  returning status into st;

  return json_build_object('community_id', cid, 'slug', p_slug, 'status', st);
end;
$$;

-- Leave a community. Leaving the public one is how a feeder goes
-- private-only.
create or replace function community_leave(
  p_device_key text,
  p_slug       text
)
returns boolean
language plpgsql security definer
as $$
declare
  fid uuid;
  cid uuid;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    raise exception 'Unknown device key';
  end if;

  select id into cid from communities where slug = lower(trim(p_slug));
  if cid is null then
    raise exception 'No such community';
  end if;

  delete from community_feeders where community_id = cid and feeder_id = fid;
  return found;
end;
$$;

grant execute on function community_feeder_id(text)                                          to anon, authenticated;
grant execute on function community_feeder_scope(text, text)                                 to anon, authenticated;
grant execute on function community_feeder_rows(text, int, int)                              to anon, authenticated;
grant execute on function community_feeder_find_rows(text, text, timestamptz, timestamptz, text, text, text) to anon, authenticated;
grant execute on function community_feeder_shared_local_ids(text, text[])                    to anon, authenticated;
grant execute on function community_feeder_memberships(text)                                 to anon, authenticated;
grant execute on function community_request_join(text, text)                                 to anon, authenticated;
grant execute on function community_leave(text, text)                                        to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 8. Owner / moderator RPCs (Supabase Auth authenticated)
--
-- Scoped to one community. Deliberately NOT the global `moderators`
-- table, which grants edit/delete over every detection on the platform
-- — a teacher must never get that.
-- ────────────────────────────────────────────────────────────────────

-- Communities the signed-in user belongs to, for the feed's scope picker.
create or replace function community_my_communities()
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_agg(row_to_json(t) order by t.name) into result
  from (
    select c.id, c.slug, c.name, c.visibility, m.role
    from communities c
    join community_members m on m.community_id = c.id
    where m.user_id = auth.uid()
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

-- Pending feeder join requests, for the owner/moderator approval queue.
create or replace function community_pending_feeders(p_community_id uuid)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  select json_agg(row_to_json(t) order by t.requested_at) into result
  from (
    select cf.id, cf.feeder_id, cf.status, cf.requested_at,
           f.display_name, f.app_version, f.last_heartbeat_at
    from community_feeders cf
    join feeders f on f.id = cf.feeder_id
    where cf.community_id = p_community_id and cf.status = 'pending'
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

create or replace function community_decide_feeder(
  p_community_id uuid,
  p_feeder_id    uuid,
  p_decision     text
)
returns boolean
language plpgsql security definer
as $$
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  update community_feeders
     set status = p_decision, decided_at = now(), decided_by = auth.uid()
   where community_id = p_community_id and feeder_id = p_feeder_id;

  return found;
end;
$$;

-- Invite a person by email. Moderators may only invite viewers; letting
-- them mint moderators would make a compromised teacher account an
-- escalation path.
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
  if p_role not in ('viewer', 'moderator') then
    raise exception 'Role must be viewer or moderator';
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

create or replace function community_revoke_invite(
  p_community_id uuid,
  p_email        text
)
returns boolean
language plpgsql security definer
as $$
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  delete from community_invites
   where community_id = p_community_id and email = lower(trim(p_email));
  return found;
end;
$$;

create or replace function community_remove_member(
  p_community_id uuid,
  p_user_id      uuid
)
returns boolean
language plpgsql security definer
as $$
declare
  target_role text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  target_role := community_role(p_community_id, p_user_id);

  if target_role = 'owner' then
    raise exception 'The community owner cannot be removed';
  end if;
  -- Only the owner may remove a moderator.
  if target_role = 'moderator'
     and community_role(p_community_id, auth.uid()) <> 'owner' then
    raise exception 'Only the community owner can remove a moderator';
  end if;

  delete from community_members
   where community_id = p_community_id and user_id = p_user_id;
  return found;
end;
$$;

-- Called on every sign-in: turn any outstanding invites for this user's
-- email address into real memberships. This is the half of the
-- email-keyed invite design that makes bulk roster loading work.
create or replace function community_redeem_invites()
returns json
language plpgsql security definer
as $$
declare
  my_email text;
  claimed  int := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;

  select lower(email) into my_email from auth.users where id = auth.uid();
  if my_email is null then
    return json_build_object('claimed', 0);
  end if;

  with fresh as (
    select * from community_invites
    where lower(email) = my_email
      and redeemed_at is null
      and expires_at > now()
  ), ins as (
    insert into community_members (community_id, user_id, role)
    select community_id, auth.uid(), role from fresh
    on conflict (community_id, user_id) do nothing
    returning 1
  )
  update community_invites i
     set redeemed_at = now(), redeemed_by = auth.uid()
    from fresh
   where i.id = fresh.id;

  get diagnostics claimed = row_count;
  return json_build_object('claimed', claimed);
end;
$$;

grant execute on function community_my_communities()                       to authenticated;
grant execute on function community_pending_feeders(uuid)                  to authenticated;
grant execute on function community_decide_feeder(uuid, uuid, text)        to authenticated;
grant execute on function community_invite(uuid, text, text)               to authenticated;
grant execute on function community_revoke_invite(uuid, text)              to authenticated;
grant execute on function community_remove_member(uuid, uuid)              to authenticated;
grant execute on function community_redeem_invites()                       to authenticated;

-- Community creation stays manual for now — open creation invites name
-- squatting, and schools are a sales conversation anyway. Run from the
-- SQL editor as service_role:
--
--   select community_create('lincoln-elementary', 'Lincoln Elementary',
--                           'private', '<owner auth.users uuid>');
create or replace function community_create(
  p_slug          text,
  p_name          text,
  p_visibility    text,
  p_owner_user_id uuid
)
returns uuid
language plpgsql security definer
as $$
declare
  new_id uuid;
begin
  insert into communities (slug, name, visibility, owner_user_id,
                           suppress_location)
  values (lower(trim(p_slug)), trim(p_name), p_visibility, p_owner_user_id,
          p_visibility = 'private')
  returning id into new_id;

  insert into community_members (community_id, user_id, role)
  values (new_id, p_owner_user_id, 'owner')
  on conflict (community_id, user_id) do update set role = 'owner';

  return new_id;
end;
$$;

revoke execute on function community_create(text, text, text, uuid) from anon;
revoke execute on function community_create(text, text, text, uuid) from authenticated;


-- ============================================================
-- 9. Post-migration verification — run these before walking away.
--
--   -- Signed-out feed must still return rows:
--   set role anon;
--   select count(*) from community_detections;   -- expect: unchanged
--   select count(*) from feeders;                -- expect: unchanged
--   select count(*) from feeder_status;          -- expect: unchanged
--   reset role;
--
--   -- Every feeder should be public at this point:
--   select count(*) filter (where is_public) as public,
--          count(*)                          as total
--   from feeders;                                -- expect: equal
--
--   -- Make one feeder private and confirm it disappears for anon:
--   --   delete from community_feeders
--   --    where feeder_id = '<id>'
--   --      and community_id = (select id from communities where slug='public');
--   --   set role anon; select count(*) from community_detections
--   --     where feeder_id = '<id>';             -- expect: 0
--   --   reset role;
--
--   -- And that the feeder can still read its own rows via the RPC:
--   --   select community_feeder_rows('<device_key>', 5, 0);
--
-- ⚠ STILL OPEN after this migration: detection media lives in PUBLIC
-- storage buckets (/storage/v1/object/public/...). RLS hides the row,
-- not the JPEG. Private communities are not fully private until media
-- moves to a private bucket with signed URLs. See docs/COMMUNITIES.md.
-- ============================================================
