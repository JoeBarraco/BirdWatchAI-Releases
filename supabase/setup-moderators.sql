-- ============================================================
-- BirdWatchAI Community Moderator Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- Enable pgcrypto for password hashing
create extension if not exists pgcrypto;

-- 1. Create moderators table
create table if not exists moderators (
  id         uuid primary key default gen_random_uuid(),
  username   text unique not null,
  password_hash text not null,
  created_at timestamptz default now()
);

-- 2. Row-level security: no public access to moderators table
alter table moderators enable row level security;

drop policy if exists "Service role full access" on moderators;
create policy "Service role full access" on moderators
  to service_role using (true) with check (true);

-- 3. RPC: Validate moderator credentials
--    Returns the moderator's id if valid, null otherwise.
--    Called from the frontend with anon key.
create or replace function moderator_login(p_username text, p_password text)
returns uuid
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);
  return mod_id;
end;
$$;

-- 4. RPC: Update a detection (rename species, adjust rarity)
--    Validates moderator credentials before performing the update.
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
  -- Validate moderator
  select id into mod_id
  from moderators
  where username = p_username
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
  end if;

  -- Build dynamic update
  update community_detections
  set
    species = coalesce(p_species, species),
    rarity  = coalesce(p_rarity, rarity)
  where id = p_detection_id;

  return found;
end;
$$;

-- 5. RPC: Delete a detection
--    Validates moderator credentials before deleting.
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
  -- Validate moderator
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

-- 6. Grant anon access to call the RPC functions
grant execute on function moderator_login(text, text) to anon;
grant execute on function moderator_update_detection(text, text, uuid, text, text) to anon;
grant execute on function moderator_delete_detection(text, text, uuid) to anon;

-- ============================================================
-- 7. Helper: Add a moderator
--    Usage (run in SQL Editor):
--      select add_moderator('joe', 'secure-password-here');
-- ============================================================
create or replace function add_moderator(p_username text, p_password text)
returns uuid
language plpgsql security definer
as $$
declare
  new_id uuid;
begin
  insert into moderators (username, password_hash)
  values (p_username, crypt(p_password, gen_salt('bf')))
  returning id into new_id;
  return new_id;
end;
$$;

-- Only service_role should call add_moderator (run from SQL Editor)
revoke execute on function add_moderator(text, text) from anon;
revoke execute on function add_moderator(text, text) from authenticated;
