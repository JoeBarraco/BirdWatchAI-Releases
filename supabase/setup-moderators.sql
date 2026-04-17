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

-- 3. RPC: Validate moderator credentials
--    Returns the moderator's id, role, email, and must_change_password flag.
create or replace function moderator_login(p_email text, p_password text)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_build_object(
    'id', id,
    'role', role,
    'email', email,
    'display_name', display_name,
    'must_change_password', must_change_password
  )
  into result
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  return result;
end;
$$;

-- RPC: Update moderator's display name (used by Profile modal when
-- signed in via moderator bridge, since user_profiles is gated on
-- auth.users and moderators don't have a Supabase Auth session).
drop function if exists moderator_update_display_name(text, text, text);
create or replace function moderator_update_display_name(
  p_email        text,
  p_password     text,
  p_display_name text
)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
  cleaned text;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  cleaned := nullif(trim(coalesce(p_display_name, '')), '');
  if cleaned is null then raise exception 'Display name is required'; end if;
  if length(cleaned) > 60 then raise exception 'Display name is too long'; end if;

  update moderators set display_name = cleaned where id = mod_id;
  return json_build_object('display_name', cleaned);
end;
$$;

grant execute on function moderator_update_display_name(text, text, text) to anon;

-- 4. RPC: Update a detection (rename species, adjust rarity,
--    optionally clear attached photo and/or video)
create or replace function moderator_update_detection(
  p_email        text,
  p_password     text,
  p_detection_id uuid,
  p_species      text    default null,
  p_rarity       text    default null,
  p_delete_image boolean default false,
  p_delete_video boolean default false
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
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
  p_email        text,
  p_password     text,
  p_detection_id uuid
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
  end if;

  delete from community_detections where id = p_detection_id;
  return found;
end;
$$;

-- 6. RPC: List all moderators (admin only)
create or replace function moderator_list_users(p_email text, p_password text)
returns json
language plpgsql security definer
as $$
declare
  admin_role text;
  result json;
begin
  select role into admin_role
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

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
  p_email         text,
  p_password      text,
  p_new_email     text,
  p_new_role      text default 'moderator'
)
returns json
language plpgsql security definer
as $$
declare
  admin_role  text;
  new_id      uuid;
  temp_pass   text;
begin
  select role into admin_role
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

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
  p_email      text,
  p_password   text,
  p_target_id  uuid
)
returns boolean
language plpgsql security definer
as $$
declare
  admin_id   uuid;
  admin_role text;
begin
  select id, role into admin_id, admin_role
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

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
  p_email        text,
  p_password     text,
  p_new_password text
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  if length(p_new_password) < 8 then
    raise exception 'Password must be at least 8 characters';
  end if;

  select id into mod_id
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid credentials';
  end if;

  update moderators
  set password_hash = crypt(p_new_password, gen_salt('bf')),
      must_change_password = false
  where id = mod_id;

  return true;
end;
$$;

-- 10. RPC: Request password reset (generates temp password, returns it)
--     Called by the send-temp-password edge function (service role).
--     Returns null if email not found (to avoid leaking user existence).
create or replace function moderator_reset_password(p_target_email text)
returns json
language plpgsql security definer
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

  return json_build_object('id', mod_id, 'temp_password', temp_pass);
end;
$$;

-- 11. Grant anon access to call the RPC functions
grant execute on function moderator_login(text, text) to anon;
grant execute on function moderator_update_detection(text, text, uuid, text, text, boolean, boolean) to anon;
grant execute on function moderator_delete_detection(text, text, uuid) to anon;
grant execute on function moderator_list_users(text, text) to anon;
grant execute on function moderator_add_user(text, text, text, text) to anon;
grant execute on function moderator_remove_user(text, text, uuid) to anon;
grant execute on function moderator_change_password(text, text, text) to anon;

-- moderator_reset_password should only be called by service role (via edge function)
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
revoke execute on function add_moderator(text, text, text) from anon;
revoke execute on function add_moderator(text, text, text) from authenticated;
