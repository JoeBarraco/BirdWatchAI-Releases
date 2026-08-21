-- ============================================================
-- BirdWatchAI Community Moderator Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- Enable pgcrypto for password hashing
create extension if not exists pgcrypto;

-- 1. Create moderators table (email-based authentication)
create table if not exists moderators (
  id                   uuid primary key default gen_random_uuid(),
  email                text unique not null,
  password_hash        text not null,
  role                 text not null default 'moderator' check (role in ('admin', 'moderator')),
  must_change_password boolean not null default false,
  created_at           timestamptz default now()
);

-- Migration helpers: add new columns if table already exists
alter table moderators
  add column if not exists role text not null default 'moderator' check (role in ('admin', 'moderator'));
alter table moderators
  add column if not exists must_change_password boolean not null default false;
alter table moderators
  add column if not exists display_name text;

-- If migrating from username-based auth, rename column
-- (Skip if column already named 'email')
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'moderators' and column_name = 'username'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'moderators' and column_name = 'email'
  ) then
    alter table moderators rename column username to email;
  end if;
end $$;

-- 2. Row-level security: no public access to moderators table
alter table moderators enable row level security;

drop policy if exists "Service role full access" on moderators;
create policy "Service role full access" on moderators
  to service_role using (true) with check (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 2c. Moderator sessions
--
-- Moderators used to authenticate every privileged call by re-sending their
-- email + password, which meant the browser had to keep the password around
-- for the whole visit (it lived in sessionStorage). That made the highest-
-- privilege credential on the site readable by any script on the page, and a
-- lifted copy was a reusable password rather than a revocable session.
--
-- Now `moderator_login` is the only function that ever sees the password: it
-- mints a random 256-bit bearer token, stores only the SHA-256 of that token,
-- and hands the token back once. Every other moderator RPC takes `p_token`.
-- The client keeps the token and nothing else; the password exists only for
-- the microseconds it takes to POST the login.
--
-- Lifetime: 8 hours of idle, refreshed on each use, hard-capped at 24 hours
-- from login. Storing the hash (not the token) means a leaked database dump
-- or a stray `select *` yields nothing a caller can replay.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists moderator_sessions (
  token_hash   text        primary key,
  moderator_id uuid        not null references moderators(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);

create index if not exists moderator_sessions_moderator_idx
  on moderator_sessions (moderator_id);
create index if not exists moderator_sessions_expires_idx
  on moderator_sessions (expires_at);

-- No public access: only the security-definer functions below touch this table.
alter table moderator_sessions enable row level security;

drop policy if exists "Service role full access" on moderator_sessions;
create policy "Service role full access" on moderator_sessions
  to service_role using (true) with check (true);

-- Resolve a token to its moderator and slide the idle window forward.
-- Returns null for an unknown, expired, or malformed token.
--
-- `search_path` is pinned because Supabase installs pgcrypto in `extensions`
-- rather than `public`; without it the digest() call below fails. See the same
-- note on community_admin_create in setup-communities.sql.
--
-- Internal helper: NOT granted to anon/authenticated. Other security-definer
-- functions call it as the function owner, and the edge functions call it with
-- the service-role key.
create or replace function moderator_session_lookup(p_token text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  h text;
  m record;
begin
  -- A real token is 64 hex chars; anything shorter can't be one, and bailing
  -- early keeps a flood of junk tokens from touching the table at all.
  if p_token is null or length(p_token) < 64 then
    return null;
  end if;

  h := encode(digest(p_token, 'sha256'), 'hex');

  select mo.id, mo.email, mo.role, mo.display_name, mo.must_change_password
    into m
    from moderator_sessions s
    join moderators mo on mo.id = s.moderator_id
   where s.token_hash = h
     and s.expires_at > now();

  if m.id is null then
    return null;
  end if;

  -- Slide the idle timeout, but never past the 24h absolute cap.
  update moderator_sessions
     set last_seen_at = now(),
         expires_at   = least(now() + interval '8 hours',
                              created_at + interval '24 hours')
   where token_hash = h;

  return json_build_object(
    'id',                   m.id,
    'email',                m.email,
    'role',                 m.role,
    'display_name',         m.display_name,
    'must_change_password', m.must_change_password
  );
end;
$$;

-- Thin wrappers so the RPCs below read as one line of auth. Each performs a
-- single lookup (and therefore a single idle-window refresh).
create or replace function moderator_session_id(p_token text)
returns uuid
language sql security definer
set search_path = public, extensions
as $$
  select (moderator_session_lookup(p_token) ->> 'id')::uuid;
$$;

create or replace function moderator_session_role(p_token text)
returns text
language sql security definer
set search_path = public, extensions
as $$
  select moderator_session_lookup(p_token) ->> 'role';
$$;

-- These three are internal. Postgres grants EXECUTE to PUBLIC on new functions
-- by default and Supabase adds anon/authenticated on top, so revoke all three
-- explicitly — revoking anon alone would leave the PUBLIC grant standing.
revoke execute on function moderator_session_lookup(text) from public;
revoke execute on function moderator_session_lookup(text) from anon;
revoke execute on function moderator_session_lookup(text) from authenticated;
revoke execute on function moderator_session_id(text)     from public;
revoke execute on function moderator_session_id(text)     from anon;
revoke execute on function moderator_session_id(text)     from authenticated;
revoke execute on function moderator_session_role(text)   from public;
revoke execute on function moderator_session_role(text)   from anon;
revoke execute on function moderator_session_role(text)   from authenticated;
grant  execute on function moderator_session_lookup(text) to service_role;

-- End the calling session. Idempotent: an unknown token is a no-op.
drop function if exists moderator_logout(text);
create or replace function moderator_logout(p_token text)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if p_token is null or length(p_token) < 64 then
    return false;
  end if;
  delete from moderator_sessions
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  return found;
end;
$$;

grant execute on function moderator_logout(text) to anon;

-- 2b. Drop old functions (parameter names changed from p_username to p_email)
drop function if exists moderator_login(text, text);
drop function if exists moderator_update_detection(text, text, uuid, text, text);
drop function if exists moderator_update_detection(text, text, uuid, text, text, boolean, boolean);
drop function if exists moderator_delete_detection(text, text, uuid);
drop function if exists moderator_list_users(text, text);
drop function if exists moderator_add_user(text, text, text, text, text);
drop function if exists moderator_add_user(text, text, text, text);
drop function if exists moderator_remove_user(text, text, uuid);
drop function if exists moderator_change_password(text, text, text);
drop function if exists moderator_reset_password(text);
-- pre-token signatures (these took p_email + p_password)
drop function if exists moderator_update_display_name(text, text, text);
drop function if exists moderator_delete_feeder(text, text, uuid);
drop function if exists moderator_merge_feeder(text, text, uuid, uuid);

-- 3. RPC: Validate moderator credentials
--    Returns the moderator's id, role, email, and must_change_password flag.
create or replace function moderator_login(p_email text, p_password text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  m   record;
  tok text;
  exp timestamptz;
begin
  select id, role, email, display_name, must_change_password
    into m
    from moderators
   where email = lower(trim(p_email))
     and password_hash = crypt(p_password, password_hash);

  -- Same shape as before: null rather than an exception on bad credentials, so
  -- a caller cannot tell "no such email" from "wrong password".
  if m.id is null then
    return null;
  end if;

  -- Housekeeping in lieu of a scheduled job: each successful login clears out
  -- sessions that have already lapsed.
  delete from moderator_sessions where expires_at < now();

  tok := encode(gen_random_bytes(32), 'hex');
  exp := now() + interval '8 hours';

  insert into moderator_sessions (token_hash, moderator_id, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), m.id, exp);

  -- `token` is handed back exactly once. Only its hash is stored, so this is
  -- the only moment the raw token exists server-side.
  return json_build_object(
    'id',                   m.id,
    'role',                 m.role,
    'email',                m.email,
    'display_name',         m.display_name,
    'must_change_password', m.must_change_password,
    'token',                tok,
    'expires_at',           exp
  );
end;
$$;

-- RPC: Update moderator's display name (used by Profile modal when
-- signed in via moderator bridge, since user_profiles is gated on
-- auth.users and moderators don't have a Supabase Auth session).
drop function if exists moderator_update_display_name(text, text, text);
create or replace function moderator_update_display_name(
  p_token        text,
  p_display_name text
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id uuid;
  cleaned text;
begin
  mod_id := moderator_session_id(p_token);
  if mod_id is null then raise exception 'Invalid or expired moderator session'; end if;

  cleaned := nullif(trim(coalesce(p_display_name, '')), '');
  if cleaned is null then raise exception 'Display name is required'; end if;
  if length(cleaned) > 60 then raise exception 'Display name is too long'; end if;

  update moderators set display_name = cleaned where id = mod_id;
  return json_build_object('display_name', cleaned);
end;
$$;

grant execute on function moderator_update_display_name(text, text) to anon;

-- 4. RPC: Update a detection (rename species, adjust rarity,
--    optionally clear attached photo and/or video)
create or replace function moderator_update_detection(
  p_token        text,
  p_detection_id uuid,
  p_species      text    default null,
  p_rarity       text    default null,
  p_delete_image boolean default false,
  p_delete_video boolean default false
)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id uuid;
begin
  mod_id := moderator_session_id(p_token);

  if mod_id is null then
    raise exception 'Invalid or expired moderator session';
  end if;

  update community_detections
  set
    species   = coalesce(p_species, species),
    rarity    = coalesce(p_rarity, rarity),
    image_url = case when p_delete_image then null else image_url end,
    video_url = case when p_delete_video then null else video_url end
  where id = p_detection_id;

  return found;
end;
$$;

-- 5. RPC: Delete a detection
create or replace function moderator_delete_detection(
  p_token        text,
  p_detection_id uuid
)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id uuid;
begin
  mod_id := moderator_session_id(p_token);

  if mod_id is null then
    raise exception 'Invalid or expired moderator session';
  end if;

  delete from community_detections where id = p_detection_id;
  return found;
end;
$$;

-- 6. RPC: List all moderators (admin only)
create or replace function moderator_list_users(p_token text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role text;
  result json;
begin
  admin_role := moderator_session_role(p_token);

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  select json_agg(json_build_object(
    'id', id, 'email', email, 'role', role, 'created_at', created_at
  ) order by created_at)
  into result
  from moderators;

  return coalesce(result, '[]'::json);
end;
$$;

-- 7. RPC: Add a moderator (admin only, via GUI)
--    Generates a random temporary password and returns it so the
--    caller can trigger the email edge function.
create or replace function moderator_add_user(
  p_token         text,
  p_new_email     text,
  p_new_role      text default 'moderator'
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_role  text;
  new_id      uuid;
  temp_pass   text;
begin
  admin_role := moderator_session_role(p_token);

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  if p_new_role not in ('admin', 'moderator') then
    raise exception 'Invalid role. Must be admin or moderator.';
  end if;

  -- Generate a random 12-character temporary password
  temp_pass := encode(gen_random_bytes(9), 'base64');

  insert into moderators (email, password_hash, role, must_change_password)
  values (
    lower(trim(p_new_email)),
    crypt(temp_pass, gen_salt('bf')),
    p_new_role,
    true
  )
  returning id into new_id;

  return json_build_object('id', new_id, 'temp_password', temp_pass);
end;
$$;

-- 8. RPC: Remove a moderator (admin only, via GUI)
create or replace function moderator_remove_user(
  p_token      text,
  p_target_id  uuid
)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  admin_id   uuid;
  admin_role text;
  sess       json;
begin
  sess       := moderator_session_lookup(p_token);
  admin_id   := (sess ->> 'id')::uuid;
  admin_role := sess ->> 'role';

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  -- Prevent admins from deleting themselves
  if admin_id = p_target_id then
    raise exception 'Cannot remove yourself';
  end if;

  delete from moderators where id = p_target_id;
  return found;
end;
$$;

-- 9. RPC: Change own password (any logged-in moderator)
create or replace function moderator_change_password(
  p_token            text,
  p_current_password text,
  p_new_password     text
)
returns boolean
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id uuid;
begin
  if length(p_new_password) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;

  mod_id := moderator_session_id(p_token);

  if mod_id is null then
    raise exception 'Invalid or expired moderator session';
  end if;

  -- Still require the current password. A session token is enough to moderate
  -- but deliberately not enough to take the account over, so a stolen token
  -- cannot lock the real owner out.
  if not exists (
    select 1 from moderators
     where id = mod_id
       and password_hash = crypt(p_current_password, password_hash)
  ) then
    raise exception 'Current password is incorrect';
  end if;

  update moderators
  set password_hash = crypt(p_new_password, gen_salt('bf')),
      must_change_password = false
  where id = mod_id;

  -- The credential changed, so every other session for this moderator dies.
  -- The caller's own token survives: they stay signed in where they are.
  delete from moderator_sessions
   where moderator_id = mod_id
     and token_hash <> encode(digest(p_token, 'sha256'), 'hex');

  return true;
end;
$$;

-- 10. RPC: Request password reset (generates temp password, returns it)
--     Called by the send-temp-password edge function (service role).
--     Returns null if email not found (to avoid leaking user existence).
create or replace function moderator_reset_password(p_target_email text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id    uuid;
  temp_pass text;
begin
  select id into mod_id
  from moderators
  where email = lower(trim(p_target_email));

  if mod_id is null then
    return null;
  end if;

  temp_pass := encode(gen_random_bytes(9), 'base64');

  update moderators
  set password_hash = crypt(temp_pass, gen_salt('bf')),
      must_change_password = true
  where id = mod_id;

  -- The old password is gone, so anything still holding a session goes with it.
  delete from moderator_sessions where moderator_id = mod_id;

  return json_build_object('id', mod_id, 'temp_password', temp_pass);
end;
$$;

-- 11. Grant anon access to call the RPC functions
grant execute on function moderator_login(text, text) to anon;
grant execute on function moderator_update_detection(text, uuid, text, text, boolean, boolean) to anon;
grant execute on function moderator_delete_detection(text, uuid) to anon;
grant execute on function moderator_list_users(text) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- moderator_delete_feeder: remove a feeder row and every community_detection
-- that referenced it, in one transaction. Used by the mod-only "🗑️ Delete
-- feeder" button on the community Feeders tab to clean up the duplicate
-- feeders that accumulated before the activation-key feeder identity (a
-- config reset used to spawn a fresh device_key and leave the old row
-- behind under the same display_name).
--
-- The accompanying edge function (moderator-delete-media, action="delete_feeder")
-- removes the photo/video files from Supabase Storage BEFORE calling this RPC,
-- so by the time we get here it's just DB rows.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists moderator_delete_feeder(text, text, uuid);

create or replace function moderator_delete_feeder(
  p_token     text,
  p_feeder_id uuid
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id              uuid;
  detections_deleted  int;
  feeder_existed      boolean;
begin
  mod_id := moderator_session_id(p_token);

  if mod_id is null then
    raise exception 'Invalid or expired moderator session';
  end if;

  delete from community_detections where feeder_id = p_feeder_id;
  get diagnostics detections_deleted = row_count;

  delete from feeders where id = p_feeder_id;
  feeder_existed := found;

  return json_build_object(
    'feeder_deleted',     feeder_existed,
    'detections_deleted', detections_deleted
  );
end;
$$;

grant execute on function moderator_delete_feeder(text, uuid) to anon;
grant execute on function moderator_add_user(text, text, text) to anon;
grant execute on function moderator_remove_user(text, uuid) to anon;
grant execute on function moderator_change_password(text, text, text) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- moderator_merge_feeder: reassign every community_detection from a source
-- feeder to a target feeder, then delete the (now empty) source row. Used by
-- the mod-only "🔀 Merge into…" button on the community Feeders tab when two
-- feeder rows represent the same physical feeder (e.g. one registered under
-- the old display-name identity and one under the new activation-key identity)
-- and we want to consolidate the detection history under the surviving row
-- instead of throwing it away.
--
-- Storage objects are NOT touched — the photo/video URLs on each detection
-- already point at the correct blobs; only the feeder_id foreign key changes.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists moderator_merge_feeder(text, text, uuid, uuid);

create or replace function moderator_merge_feeder(
  p_token     text,
  p_source_id uuid,
  p_target_id uuid
)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  mod_id            uuid;
  detections_moved  int;
  source_existed    boolean;
  target_exists     boolean;
begin
  mod_id := moderator_session_id(p_token);

  if mod_id is null then
    raise exception 'Invalid or expired moderator session';
  end if;

  if p_source_id is null or p_target_id is null then
    raise exception 'source and target feeder ids are required';
  end if;

  if p_source_id = p_target_id then
    raise exception 'source and target must be different feeders';
  end if;

  select exists(select 1 from feeders where id = p_target_id) into target_exists;
  if not target_exists then
    raise exception 'target feeder does not exist';
  end if;

  update community_detections
     set feeder_id = p_target_id
   where feeder_id = p_source_id;
  get diagnostics detections_moved = row_count;

  delete from feeders where id = p_source_id;
  source_existed := found;

  return json_build_object(
    'source_deleted',   source_existed,
    'detections_moved', detections_moved
  );
end;
$$;

grant execute on function moderator_merge_feeder(text, uuid, uuid) to anon;

-- moderator_reset_password should only be called by service role (via edge function)
revoke execute on function moderator_reset_password(text) from public;
revoke execute on function moderator_reset_password(text) from anon;
revoke execute on function moderator_reset_password(text) from authenticated;

-- ============================================================
-- 12. Bootstrap: Create the first admin account
--     Run this ONCE in SQL Editor to create your admin user,
--     then manage all other users from the GUI.
--
--     Usage:
--       select add_moderator('admin@example.com', 'secure-password-here', 'admin');
-- ============================================================

-- Drop old versions if they exist (from previous setup)
drop function if exists add_moderator(text, text);
drop function if exists add_moderator(text, text, text);

create or replace function add_moderator(p_email text, p_password text, p_role text default 'moderator')
returns uuid
language plpgsql security definer
as $$
declare
  new_id uuid;
begin
  insert into moderators (email, password_hash, role)
  values (lower(trim(p_email)), crypt(p_password, gen_salt('bf')), p_role)
  returning id into new_id;
  return new_id;
end;
$$;

-- Only service_role should call add_moderator (run from SQL Editor)
revoke execute on function add_moderator(text, text, text) from public;
revoke execute on function add_moderator(text, text, text) from anon;
revoke execute on function add_moderator(text, text, text) from authenticated;
