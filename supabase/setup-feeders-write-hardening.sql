-- ════════════════════════════════════════════════════════════════════
-- Harden writes to the feeders table.
--
-- Run AFTER setup-feeder-write-tokens.sql. Safe and additive on its own:
-- the policy drop at the end is the only breaking part, and it is
-- separated and labelled.
--
-- ⚠ THE OBVIOUS FIX DOES NOT WORK — READ THIS FIRST
--
-- feeders currently carries qual=true anon policies for INSERT and
-- UPDATE, so the published key can create feeders, rename any feeder,
-- and move any feeder's map pin. (DELETE is already denied — there has
-- never been an anon delete policy, which is why
-- CleanupOrphanFeedersAsync's direct-delete fallback has never actually
-- worked; only its RPC path does.)
--
-- Dropping those two policies ALONE accomplishes nothing, because
-- community_feeder_upsert / _heartbeat / _delete_sibling are SECURITY
-- DEFINER and authenticate on device_key — which is public. It is a
-- readable column, and it is also the storage folder name in every
-- world-readable image_url. So an attacker simply calls the RPC with
-- your device key instead of PostgREST, and renames your feeder exactly
-- as before. The writes would move; the hole would not close.
--
-- So the RPCs have to require the write token first. Same self-migrating
-- rule as the detection writes: a feeder with no token row is accepted
-- on device_key alone (legacy), a feeder that has claimed one must
-- present it. All five live feeders had claimed by 2026-08-29, so in
-- practice this is enforced immediately for them.
--
-- ONE DELIBERATE EXCEPTION: community_feeder_upsert is also the
-- REGISTRATION path. A brand-new feeder has no row and therefore no
-- token, and must still be able to create itself. Enforcement is
-- conditional on the feeder already existing. That is not a loophole for
-- an existing feeder — once the row exists and holds a token, the token
-- is required.
-- ════════════════════════════════════════════════════════════════════


-- Drop old signatures before recreating with the token parameter, or
-- PostgREST sees two candidates and every call fails as ambiguous.
drop function if exists community_feeder_upsert(text, text, int, text, text, double precision, double precision);
drop function if exists community_feeder_heartbeat(text, boolean, text);
drop function if exists community_feeder_delete_sibling(text, uuid);


-- ────────────────────────────────────────────────────────────────────
-- Register / update this feeder's own row.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_upsert(
  p_device_key   text,
  p_display_name text,
  p_share_level  int     default 1,
  p_app_version  text    default null,
  p_zip_code     text    default null,
  p_latitude     double precision default null,
  p_longitude    double precision default null,
  p_write_token  text    default null
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  fid uuid;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'device_key is required';
  end if;

  -- Conditional on existence: registration of a NEW feeder is allowed
  -- without a token; updating an EXISTING one that holds a token is not.
  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is not null and not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_feeder_upsert: write token required or incorrect';
  end if;

  insert into feeders (device_key, display_name, share_level, app_version,
                       zip_code, latitude, longitude)
  values (p_device_key, p_display_name, p_share_level, p_app_version,
          p_zip_code, p_latitude, p_longitude)
  on conflict (device_key) do update
    set display_name = excluded.display_name,
        share_level  = excluded.share_level,
        app_version  = coalesce(excluded.app_version, feeders.app_version),
        zip_code     = coalesce(excluded.zip_code, feeders.zip_code),
        latitude     = coalesce(excluded.latitude, feeders.latitude),
        longitude    = coalesce(excluded.longitude, feeders.longitude)
  returning id into fid;

  return fid;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Heartbeat. Returns false when the device key matches no feeder, as
-- before; raises when the feeder exists but the token is wrong.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_heartbeat(
  p_device_key    text,
  p_is_monitoring boolean,
  p_app_version   text default null,
  p_write_token   text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  fid uuid;
begin
  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return false;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_feeder_heartbeat: write token required or incorrect';
  end if;

  update feeders
     set last_heartbeat_at = now(),
         is_monitoring     = p_is_monitoring,
         app_version       = coalesce(p_app_version, app_version)
   where id = fid;
  return found;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Delete a stale same-named sibling identity.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_delete_sibling(
  p_device_key  text,
  p_target_id   uuid,
  p_write_token text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  own_id uuid;
begin
  own_id := community_feeder_id(p_device_key);
  if own_id is null then
    raise exception 'Unknown device key';
  end if;
  if not community_feeder_write_ok(own_id, p_write_token) then
    raise exception 'community_feeder_delete_sibling: write token required or incorrect';
  end if;
  if p_target_id = own_id then
    raise exception 'Refusing to delete the calling feeder''s own row';
  end if;

  delete from feeders t
  where t.id = p_target_id
    and t.display_name = (select display_name from feeders where id = own_id);

  return found;
end;
$$;


revoke execute on function community_feeder_upsert(text, text, int, text, text, double precision, double precision, text) from public;
revoke execute on function community_feeder_heartbeat(text, boolean, text, text)      from public;
revoke execute on function community_feeder_delete_sibling(text, uuid, text)          from public;

grant execute on function community_feeder_upsert(text, text, int, text, text, double precision, double precision, text) to anon, authenticated;
grant execute on function community_feeder_heartbeat(text, boolean, text, text)       to anon, authenticated;
grant execute on function community_feeder_delete_sibling(text, uuid, text)           to anon, authenticated;


-- ════════════════════════════════════════════════════════════════════
-- ⛔ THE BREAKING PART — everything above is additive; this is not.
--
-- Do NOT run this until every feeder is on a build that sends the write
-- token with its upsert and heartbeat. Before that, dropping these
-- policies is harmless (the RPCs still work) but pointless; after the
-- server ships, it is what actually closes the direct path.
--
-- Dropped BY DISCOVERY, not by name. The detections cutover taught this
-- the hard way: the policies are declared in setup-communities.sql as
-- "Anon can register feeders" / "Anon can update feeders" but the live
-- database may well call them something else, and `drop policy if
-- exists` is silent when nothing matches — it reports success having
-- changed nothing. Check the notices.
--
-- SELECT is untouched: the feeders list, the map and the feed's feeder
-- dropdown all read this table.
-- ════════════════════════════════════════════════════════════════════
do $$
declare
  p record;
  n int := 0;
begin
  for p in
    select policyname, cmd
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'feeders'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and not ('service_role' = any(roles))
  loop
    execute format('drop policy if exists %I on public.feeders', p.policyname);
    raise notice 'dropped % policy %', p.cmd, p.policyname;
    n := n + 1;
  end loop;

  if n = 0 then
    raise notice 'no anon write policies found on feeders — already closed?';
  end if;

  for p in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'feeders'
       and cmd = 'ALL'
       and not ('service_role' = any(roles))
  loop
    raise warning 'ALL-command policy % still grants writes on feeders — review by hand, dropping it would also remove SELECT', p.policyname;
  end loop;
end $$;

drop policy if exists "Service role full access feeders" on feeders;
create policy "Service role full access feeders" on feeders
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- VERIFY
--
--   select policyname, cmd, roles from pg_policies
--    where tablename = 'feeders' order by cmd;
--   -- expect only SELECT (public) and ALL (service_role)
--
-- Then, with the ANON key, confirm a rename is refused both ways:
--
--   PATCH /rest/v1/feeders?id=eq.<id>   {"display_name":"probe"}
--     -> filtered to zero rows
--   POST  /rest/v1/rpc/community_feeder_upsert
--     {"p_device_key":"<a real, public device key>","p_display_name":"probe"}
--     -> raises "write token required or incorrect"
--
-- The second is the one that matters. The first was never the whole
-- problem.
-- ────────────────────────────────────────────────────────────────────
