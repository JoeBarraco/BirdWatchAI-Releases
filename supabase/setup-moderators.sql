-- ============================================================
-- BirdWatchAI Community Moderator Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- Enable pgcrypto for password hashing
create extension if not exists pgcrypto;

-- 1. Create moderators table
create table if not exists moderators (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  password_hash text not null,
  role          text not null default 'moderator' check (role in ('admin', 'moderator')),
  created_at    timestamptz default now()
);

-- Add role column if table already exists without it
alter table moderators
  add column if not exists role text not null default 'moderator' check (role in ('admin', 'moderator'));

-- 2. Row-level security: no public access to moderators table
alter table moderators enable row level security;

drop policy if exists "Service role full access" on moderators;
create policy "Service role full access" on moderators
  to service_role using (true) with check (true);

-- 3. RPC: Validate moderator credentials
--    Returns the moderator's id and role if valid, null otherwise.
create or replace function moderator_login(p_username text, p_password text)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_build_object('id', id, 'role', role, 'username', username)
  into result
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);
  return result;
end;
$$;

-- 4. RPC: Update a detection (rename species, adjust rarity)
create or replace function moderator_update_detection(
  p_username     text,
  p_password     text,
  p_detection_id uuid,
  p_species      text default null,
  p_rarity       text default null
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
  end if;

  update community_detections
  set
    species = coalesce(p_species, species),
    rarity  = coalesce(p_rarity, rarity)
  where id = p_detection_id;

  return found;
end;
$$;

-- 5. RPC: Delete a detection
create or replace function moderator_delete_detection(
  p_username     text,
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
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
  end if;

  delete from community_detections where id = p_detection_id;
  return found;
end;
$$;

-- 6. RPC: List all moderators (admin only)
create or replace function moderator_list_users(p_username text, p_password text)
returns json
language plpgsql security definer
as $$
declare
  admin_role text;
  result json;
begin
  select role into admin_role
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  select json_agg(json_build_object(
    'id', id, 'username', username, 'role', role, 'created_at', created_at
  ) order by created_at)
  into result
  from moderators;

  return coalesce(result, '[]'::json);
end;
$$;

-- 7. RPC: Add a moderator (admin only, via GUI)
create or replace function moderator_add_user(
  p_username      text,
  p_password      text,
  p_new_username  text,
  p_new_password  text,
  p_new_role      text default 'moderator'
)
returns uuid
language plpgsql security definer
as $$
declare
  admin_role text;
  new_id uuid;
begin
  select role into admin_role
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  if p_new_role not in ('admin', 'moderator') then
    raise exception 'Invalid role. Must be admin or moderator.';
  end if;

  insert into moderators (username, password_hash, role)
  values (p_new_username, crypt(p_new_password, gen_salt('bf')), p_new_role)
  returning id into new_id;

  return new_id;
end;
$$;

-- 8. RPC: Remove a moderator (admin only, via GUI)
create or replace function moderator_remove_user(
  p_username     text,
  p_password     text,
  p_target_id    uuid
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
  where username = p_username
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

-- 9. Grant anon access to call the RPC functions
grant execute on function moderator_login(text, text) to anon;
grant execute on function moderator_update_detection(text, text, uuid, text, text) to anon;
grant execute on function moderator_delete_detection(text, text, uuid) to anon;
grant execute on function moderator_list_users(text, text) to anon;
grant execute on function moderator_add_user(text, text, text, text, text) to anon;
grant execute on function moderator_remove_user(text, text, uuid) to anon;

-- ============================================================
-- 10. Bootstrap: Create the first admin account
--     Run this ONCE in SQL Editor to create your admin user,
--     then manage all other users from the GUI.
--
--     Usage:
--       select add_moderator('joe', 'secure-password-here', 'admin');
-- ============================================================

-- Drop old 2-parameter version if it exists (from previous setup)
drop function if exists add_moderator(text, text);

create or replace function add_moderator(p_username text, p_password text, p_role text default 'moderator')
returns uuid
language plpgsql security definer
as $$
declare
  new_id uuid;
begin
  insert into moderators (username, password_hash, role)
  values (p_username, crypt(p_password, gen_salt('bf')), p_role)
  returning id into new_id;
  return new_id;
end;
$$;

-- Only service_role should call add_moderator (run from SQL Editor)
revoke execute on function add_moderator(text, text, text) from anon;
revoke execute on function add_moderator(text, text, text) from authenticated;
