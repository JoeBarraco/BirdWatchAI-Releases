-- ════════════════════════════════════════════════════════════════════
-- Feeder write tokens — step 3 of closing the anon-write hole.
--
-- Run AFTER setup-communities.sql and setup-detection-write-rpcs.sql.
--
-- WHY NOT JUST HIDE device_key
--
-- The plan in setup-detection-write-rpcs.sql said step 3 was "stop
-- exposing device_key to anon". That does not work. device_key is the
-- storage folder name:
--
--     .../object/public/detection-images/<device_key>/20260828-224823.jpg
--
-- and image_url is world-readable on community_detections, because the
-- gallery renders from it. Checked against the live database: for every
-- feeder, the folder segment equals feeders.device_key exactly. So the
-- key is recoverable from the public feed in one query no matter what
-- the feeders column grants say. Revoking the column would have moved
-- the leak, not closed it, and cost a two-bucket storage migration
-- (re-pathing every object and rewriting every historical image_url and
-- video_url) to do properly.
--
-- device_key stays what it actually is: a public identifier that names
-- storage folders. This file introduces a real secret to sit beside it.
--
-- THE MODEL
--
-- feeder_write_tokens holds one secret per feeder. The table is RLS-on
-- with no policies and no grants, so anon and authenticated cannot read
-- or write it by any route — only the security-definer functions below
-- touch it. The token never appears in any read path; the claim RPC is
-- the only thing that ever returns one.
--
-- Enforcement is per-feeder and self-migrating:
--
--   * feeder has NO token row  -> device_key alone is accepted (legacy)
--   * feeder HAS a token row   -> the matching token is required
--
-- So a feeder hardens the moment it upgrades and claims, with no flag
-- day and no coordinated cutover. A feeder that never upgrades stays
-- legacy-writable — see the bootstrap note below for how to force it.
--
-- ⚠ BOOTSTRAP WEAKNESS — READ BEFORE APPLYING
--
-- For feeders that already exist, the only ownership proof available is
-- device_key, which is public. So between this file being applied and a
-- given feeder claiming its token, ANYONE who can read that feeder's
-- device key can claim the token first and lock the real owner out of
-- its own rows. First claimer wins.
--
-- The window is per-feeder and closes on that feeder's first upgraded
-- run. For a feeder that will not upgrade promptly, close it manually
-- instead — mint with service_role and paste the value into that
-- install's config.json:
--
--   insert into feeder_write_tokens (feeder_id, token)
--   select id, replace(gen_random_uuid()::text,'-','') ||
--              replace(gen_random_uuid()::text,'-','')
--     from feeders where display_name = '<name>'
--   on conflict (feeder_id) do nothing
--   returning feeder_id, token;
--
-- Note that pre-minting STOPS that feeder writing until its config
-- carries the token, which is the point: it is a lock, not a warning.
-- ════════════════════════════════════════════════════════════════════


create table if not exists feeder_write_tokens (
  feeder_id  uuid primary key references feeders(id) on delete cascade,
  token      text        not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

alter table feeder_write_tokens enable row level security;

-- No policies are created for anon/authenticated on purpose: RLS with no
-- policy denies everything. The revoke is belt and braces in case a
-- blanket grant is ever applied to the schema.
revoke all on table feeder_write_tokens from anon, authenticated;

drop policy if exists "Service role full access write tokens" on feeder_write_tokens;
create policy "Service role full access write tokens" on feeder_write_tokens
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- Is this caller allowed to write this feeder's rows?
--
-- The self-migrating rule. Not security definer by itself — it is only
-- ever called from inside the definer functions below, and marking it
-- definer would make it independently callable as an oracle for
-- "is this token right?".
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_write_ok(p_feeder_id uuid, p_token text)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when not exists (select 1 from feeder_write_tokens t where t.feeder_id = p_feeder_id)
      then true                                    -- legacy: no token minted yet
    else exists (select 1 from feeder_write_tokens t
                  where t.feeder_id = p_feeder_id and t.token = p_token)
  end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Claim this feeder's write token. Returns the token on success, null
-- when one already exists (already claimed — the caller should be
-- holding it) or when the device key matches no feeder.
--
-- 64 hex chars from two gen_random_uuid()s: 256 bits, and no pgcrypto
-- dependency.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_claim_write_token(p_device_key text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  tok text;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_feeder_claim_write_token: device_key is required';
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return null;
  end if;

  if exists (select 1 from feeder_write_tokens where feeder_id = fid) then
    return null;                                   -- already claimed
  end if;

  tok := replace(gen_random_uuid()::text, '-', '') ||
         replace(gen_random_uuid()::text, '-', '');

  insert into feeder_write_tokens (feeder_id, token) values (fid, tok)
  on conflict (feeder_id) do nothing;

  -- Lost the race to a concurrent claim: report not-claimed rather than
  -- handing back a token that was never stored.
  if not exists (select 1 from feeder_write_tokens where feeder_id = fid and token = tok) then
    return null;
  end if;

  return tok;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Rotate. Requires the current token, so this is the recovery path for
-- a feeder that still holds its secret — not for one that lost it.
-- A feeder locked out by a hostile claim needs a service_role delete
-- from feeder_write_tokens, then a fresh claim.
-- ────────────────────────────────────────────────────────────────────
create or replace function community_feeder_rotate_write_token(
  p_device_key text, p_current_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  tok text;
begin
  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return null;
  end if;
  if not exists (select 1 from feeder_write_tokens
                  where feeder_id = fid and token = p_current_token) then
    return null;
  end if;

  tok := replace(gen_random_uuid()::text, '-', '') ||
         replace(gen_random_uuid()::text, '-', '');
  update feeder_write_tokens
     set token = tok, rotated_at = now()
   where feeder_id = fid;
  return tok;
end;
$$;


-- ════════════════════════════════════════════════════════════════════
-- Re-create the three detection write RPCs with the token parameter.
--
-- These must be DROPPED first, not just "create or replace"d: adding a
-- parameter produces a NEW signature, and leaving the old one in place
-- gives PostgREST two candidates and an ambiguous-function error on
-- every call.
-- ════════════════════════════════════════════════════════════════════

drop function if exists community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text);
drop function if exists community_detection_patch(text, uuid[], jsonb);
drop function if exists community_detection_delete(text, uuid[]);


create or replace function community_detection_insert(
  p_device_key  text,
  p_species     text,
  p_confidence  double precision,
  p_detected_at timestamptz,
  p_local_id    text,
  p_rarity      text             default null,
  p_temperature double precision default null,
  p_image_url   text             default null,
  p_video_url   text             default null,
  p_latitude    double precision default null,
  p_longitude   double precision default null,
  p_zip_code    text             default null,
  p_write_token text             default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  rid uuid;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_insert: device_key is required';
  end if;
  if p_species is null or p_detected_at is null then
    raise exception 'community_detection_insert: species and detected_at are required';
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return null;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_detection_insert: write token required or incorrect';
  end if;

  insert into community_detections
    (feeder_id, species, confidence, detected_at, local_id, rarity,
     temperature, image_url, video_url, latitude, longitude, zip_code)
  values
    (fid, p_species, p_confidence, p_detected_at, p_local_id, p_rarity,
     p_temperature, p_image_url, p_video_url, p_latitude, p_longitude, p_zip_code)
  returning id into rid;

  return rid;
end;
$$;


create or replace function community_detection_patch(
  p_device_key  text,
  p_ids         uuid[],
  p_patch       jsonb,
  p_write_token text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  n   integer;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_patch: device_key is required';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'community_detection_patch: patch must be a json object';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) as k
    where k not in ('species', 'rarity', 'image_url', 'video_url')
  ) then
    raise exception 'community_detection_patch: unsupported key in patch';
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return 0;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_detection_patch: write token required or incorrect';
  end if;

  update community_detections d
     set species   = case when p_patch ? 'species'   then p_patch->>'species'   else d.species   end,
         rarity    = case when p_patch ? 'rarity'    then p_patch->>'rarity'    else d.rarity    end,
         image_url = case when p_patch ? 'image_url' then p_patch->>'image_url' else d.image_url end,
         video_url = case when p_patch ? 'video_url' then p_patch->>'video_url' else d.video_url end
   where d.id = any(p_ids)
     and d.feeder_id in (select community_feeder_scope(p_device_key, 'name'));

  get diagnostics n = row_count;
  return n;
end;
$$;


create or replace function community_detection_delete(
  p_device_key  text,
  p_ids         uuid[],
  p_write_token text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  n   integer;
begin
  if p_device_key is null or length(trim(p_device_key)) = 0 then
    raise exception 'community_detection_delete: device_key is required';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  select id into fid from feeders where device_key = p_device_key limit 1;
  if fid is null then
    return 0;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_detection_delete: write token required or incorrect';
  end if;

  delete from community_detections d
   where d.id = any(p_ids)
     and d.feeder_id in (select community_feeder_scope(p_device_key, 'name'));

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Grants. Revoke from PUBLIC first — Postgres grants EXECUTE to PUBLIC
-- on every new function and every role belongs to PUBLIC, so a
-- grant-only file leaves these callable by anyone whatever it revokes
-- from anon.
--
-- community_feeder_write_ok is deliberately NOT granted to anon: it
-- would be a free oracle for testing candidate tokens.
-- ────────────────────────────────────────────────────────────────────
revoke execute on function community_feeder_write_ok(uuid, text)                from public;
revoke execute on function community_feeder_claim_write_token(text)             from public;
revoke execute on function community_feeder_rotate_write_token(text, text)      from public;
revoke execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text, text) from public;
revoke execute on function community_detection_patch(text, uuid[], jsonb, text)  from public;
revoke execute on function community_detection_delete(text, uuid[], text)        from public;

grant execute on function community_feeder_claim_write_token(text)              to anon, authenticated;
grant execute on function community_feeder_rotate_write_token(text, text)       to anon, authenticated;
grant execute on function community_detection_insert(text, text, double precision, timestamptz, text, text, double precision, text, text, double precision, double precision, text, text) to anon, authenticated;
grant execute on function community_detection_patch(text, uuid[], jsonb, text)   to anon, authenticated;
grant execute on function community_detection_delete(text, uuid[], text)         to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- Verify.
--
-- 1. anon must not be able to read the token table at all:
--      GET /rest/v1/feeder_write_tokens?select=*     -> 401/404, never rows
--
-- 2. the oracle must not be callable by anon:
--      select has_function_privilege('anon',
--        'community_feeder_write_ok(uuid,text)', 'EXECUTE');   -- expect false
--
-- 3. nothing is callable by PUBLIC:
--      select proname, has_function_privilege('public', oid, 'EXECUTE')
--        from pg_proc
--       where pronamespace = 'public'::regnamespace
--         and proname in ('community_feeder_write_ok',
--                         'community_feeder_claim_write_token',
--                         'community_feeder_rotate_write_token',
--                         'community_detection_insert',
--                         'community_detection_patch',
--                         'community_detection_delete');
--
-- 4. who has claimed so far:
--      select f.display_name, t.created_at, t.rotated_at
--        from feeders f left join feeder_write_tokens t on t.feeder_id = f.id
--       order by f.display_name;
-- ────────────────────────────────────────────────────────────────────
