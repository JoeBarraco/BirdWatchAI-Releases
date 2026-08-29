-- ════════════════════════════════════════════════════════════════════
-- CLOSE the anon write hole on community_detections.
--
-- ⛔ THIS ONE BREAKS THINGS. Everything before it was additive; this is
-- the cutover. Read the preflight and run it first.
--
-- WHAT IT DOES
--
-- Drops the three qual=true write policies that let the publishable anon
-- key insert, update and delete ANY row belonging to ANY feeder. After
-- this, RLS has no write policy for anon or authenticated at all, and
-- Postgres denies by default.
--
-- WHAT KEEPS WORKING
--
-- The community_detection_* RPCs. They are SECURITY DEFINER, so they run
-- as the function owner and are not subject to these policies — that is
-- the whole design. A feeder on a build that uses them is unaffected.
--
-- WHAT STOPS WORKING — this is the part to be sure about
--
-- Any client still writing through PostgREST directly. That means every
-- install older than v0.4.426, including WinForms installs, which nobody
-- can force-upgrade. They will start getting 401/403 on share, on
-- species and rarity corrections, and on delete propagation. They will
-- not fall back to anything, because there is nothing left to fall back
-- to. Sharing simply stops for them until they update.
--
-- The server logs this as a refusal at warning level rather than
-- swallowing it (that was fixed in a94de4d), so an affected operator has
-- something to find. Old builds predate that and will be quieter.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- PREFLIGHT — run this on its own and read the output before going on.
--
-- Every feeder that has heartbeated recently should be on 0.4.426 or
-- later. Anything older is a feeder you are about to cut off. Feeders
-- that have been silent for a long time matter less; feeders that are
-- live and stale are the ones to chase.
--
--   select display_name,
--          app_version,
--          last_heartbeat_at,
--          case when last_heartbeat_at > now() - interval '1 day'
--               then 'LIVE — will break if older than 0.4.426'
--               else 'dormant' end as status
--     from feeders
--    order by last_heartbeat_at desc nulls last;
--
-- And confirm the write RPCs are all present, or the cutover strands
-- even up-to-date clients:
--
--   select proname from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('community_detection_insert',
--                      'community_detection_patch',
--                      'community_detection_patch_by_local_id',
--                      'community_detection_delete');
--   -- expect all four
-- ────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────
-- The cutover. SELECT is untouched — the public feed must stay readable
-- or the website goes dark.
-- ────────────────────────────────────────────────────────────────────
-- ⚠ Dropped BY DISCOVERY, not by name. The first version of this file named the
-- three policies as setup-communities.sql declares them ("Anon can write
-- detections" etc.). On the live database they are actually called
-- anon_insert_detections / anon_update_detections / anon_delete_detections, so
-- every `drop policy if exists` matched nothing, did nothing, and reported
-- success. The hole stayed wide open and the run looked clean.
--
-- Their roles are also {public}, not {anon, authenticated} — so they applied to
-- every role on the database, PUBLIC being one every role belongs to. Same trap
-- as the function EXECUTE grants, one layer up.
--
-- Hence: enumerate and drop whatever write policies exist, whatever they are
-- called. SELECT policies are left alone (the public feed must stay readable)
-- and so is anything scoped to service_role.
do $$
declare
  p record;
  n int := 0;
begin
  for p in
    select policyname, cmd
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'community_detections'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and not ('service_role' = any(roles))
  loop
    execute format('drop policy if exists %I on public.community_detections', p.policyname);
    raise notice 'dropped % policy %', p.cmd, p.policyname;
    n := n + 1;
  end loop;

  if n = 0 then
    raise notice 'no anon write policies found — already closed, or they are ALL-command policies (see below)';
  end if;

  -- An ALL-command policy for a non-service role would also carry SELECT, so
  -- dropping it blindly would take the public feed down with it. Report instead.
  for p in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'community_detections'
       and cmd = 'ALL'
       and not ('service_role' = any(roles))
  loop
    raise warning 'ALL-command policy % still grants writes — review by hand, dropping it would also remove SELECT', p.policyname;
  end loop;
end $$;

-- Belt and braces: re-assert the service_role policy so a maintenance
-- session and the moderator edge functions keep full access whatever
-- else has been dropped over time.
drop policy if exists "Service role full access detections" on community_detections;
create policy "Service role full access detections" on community_detections
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- VERIFY
--
-- 1. Only SELECT (for anon) and ALL (for service_role) should remain:
--
--      select policyname, cmd, roles
--        from pg_policies
--       where tablename = 'community_detections'
--       order by cmd;
--
-- 2. The direct path must now be refused. With the ANON key, against a
--    real row id — expect 401/403 and the row still present:
--
--      DELETE /rest/v1/community_detections?id=eq.<some row>
--
-- 3. The RPC path must still work. From a real feeder holding its write
--    token, share a sighting and confirm it lands.
--
-- ROLLBACK, if a client you forgot about turns out to matter. Note these
-- recreate the policies scoped to anon+authenticated rather than to
-- PUBLIC as the originals were — same effect through PostgREST, which
-- only ever reaches those two roles, and narrower everywhere else:
--
--   create policy "Anon can write detections" on community_detections
--     for insert to anon, authenticated with check (true);
--   create policy "Anon can update detections" on community_detections
--     for update to anon, authenticated using (true) with check (true);
--   create policy "Anon can delete detections" on community_detections
--     for delete to anon, authenticated using (true);
--
-- That restores the hole exactly as it was. It is a real escape hatch,
-- not a recommendation — if you use it, note why, because the reason is
-- the thing blocking the fix.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- NOT CLOSED BY THIS FILE: the feeders table.
--
-- setup-communities.sql §6 also leaves "Anon can register feeders" and
-- "Anon can update feeders" at qual=true, so the published key can still
-- rename any feeder or move its map location. The
-- feeders_anon_update_guard trigger protects id, device_key and the
-- subscription_* columns, so this is a lesser problem than the detection
-- one — but it is the same problem, and community_feeder_upsert already
-- exists as the authenticated replacement. Worth doing next.
-- ────────────────────────────────────────────────────────────────────
