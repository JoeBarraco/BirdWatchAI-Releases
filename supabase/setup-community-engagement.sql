-- ============================================================
-- BirdWatchAI Community Engagement Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Features:
--   1. User accounts (magic link auth via Supabase Auth)
--   2. Per-user life lists with shareable links
--   3. Follow a Feeder (with rare-bird notifications)
--   4. Comments / threads on detections
--   5. Community flagging / reporting with moderation queue
-- ============================================================

-- ── 1. User profiles (extends Supabase Auth) ─────────────────
-- Supabase Auth handles signup / magic-link / sessions.
-- This table stores the public profile that other users can see.
create table if not exists user_profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url   text,
  bio          text default '',
  created_at   timestamptz default now()
);

alter table user_profiles enable row level security;

-- Anyone can view profiles (they're public)
drop policy if exists "Public profiles are viewable" on user_profiles;
create policy "Public profiles are viewable" on user_profiles
  for select using (true);

-- Users can insert their own profile
drop policy if exists "Users can create own profile" on user_profiles;
create policy "Users can create own profile" on user_profiles
  for insert with check (auth.uid() = id);

-- Users can update their own profile
drop policy if exists "Users can update own profile" on user_profiles;
create policy "Users can update own profile" on user_profiles
  for update using (auth.uid() = id);

-- Auto-create a profile row when a new user signs up
-- NOTE: If this trigger causes "Database error saving new user",
-- drop it and let the app handle profile creation instead:
--   drop trigger if exists on_auth_user_created on auth.users;
-- The app will auto-create the profile on first login.
create or replace function handle_new_user()
returns trigger
language plpgsql security definer
as $$
begin
  insert into user_profiles (id, display_name)
  values (new.id, coalesce(split_part(new.email, '@', 1), 'Birder'))
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Disabled by default — uncomment if your Supabase instance supports it.
-- Some configurations block triggers on auth.users.
-- drop trigger if exists on_auth_user_created on auth.users;
-- create trigger on_auth_user_created
--   after insert on auth.users
--   for each row execute function handle_new_user();

-- Also allow service role to insert profiles (for app-side creation)
drop policy if exists "Service role can create profiles" on user_profiles;
create policy "Service role can create profiles" on user_profiles
  for insert to service_role with check (true);


-- ── 2. Life lists (species a user has seen) ──────────────────
create table if not exists user_life_list (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  species      text not null,
  first_seen   timestamptz not null default now(),
  detection_id uuid references community_detections(id) on delete set null,
  notes        text default '',
  created_at   timestamptz default now(),
  unique(user_id, species)
);

create index if not exists idx_life_list_user on user_life_list(user_id);

alter table user_life_list enable row level security;

-- Anyone can view life lists (they're public / shareable)
drop policy if exists "Life lists are public" on user_life_list;
create policy "Life lists are public" on user_life_list
  for select using (true);

-- Users can manage their own list
drop policy if exists "Users manage own life list" on user_life_list;
create policy "Users manage own life list" on user_life_list
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users update own life list" on user_life_list;
create policy "Users update own life list" on user_life_list
  for update using (auth.uid() = user_id);

drop policy if exists "Users delete own life list" on user_life_list;
create policy "Users delete own life list" on user_life_list
  for delete using (auth.uid() = user_id);

-- RPC: Add species to life list (idempotent)
drop function if exists add_to_life_list(text, uuid, text);
create or replace function add_to_life_list(
  p_species      text,
  p_detection_id uuid default null,
  p_notes        text default ''
)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  insert into user_life_list (user_id, species, detection_id, notes, first_seen)
  values (auth.uid(), p_species, p_detection_id, p_notes, now())
  on conflict (user_id, species) do nothing;

  select json_build_object(
    'species', species,
    'first_seen', first_seen,
    'detection_id', detection_id,
    'notes', notes
  ) into result
  from user_life_list
  where user_id = auth.uid() and species = p_species;

  return result;
end;
$$;

-- RPC: Remove species from life list
drop function if exists remove_from_life_list(text);
create or replace function remove_from_life_list(p_species text)
returns boolean
language plpgsql security definer
as $$
begin
  delete from user_life_list
  where user_id = auth.uid() and species = p_species;
  return found;
end;
$$;

-- RPC: Get a user's full life list
drop function if exists get_life_list(uuid);
create or replace function get_life_list(p_user_id uuid)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_agg(json_build_object(
    'species', species,
    'first_seen', first_seen,
    'detection_id', detection_id,
    'notes', notes
  ) order by species)
  into result
  from user_life_list
  where user_id = p_user_id;

  return coalesce(result, '[]'::json);
end;
$$;

grant execute on function add_to_life_list(text, uuid, text) to authenticated;
grant execute on function remove_from_life_list(text) to authenticated;
grant execute on function get_life_list(uuid) to anon, authenticated;


-- ── 3. Follow a Feeder ───────────────────────────────────────
create table if not exists feeder_follows (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  feeder_id  uuid not null references feeders(id) on delete cascade,
  notify_rare boolean not null default true,
  created_at timestamptz default now(),
  unique(user_id, feeder_id)
);

create index if not exists idx_feeder_follows_user   on feeder_follows(user_id);
create index if not exists idx_feeder_follows_feeder on feeder_follows(feeder_id);

alter table feeder_follows enable row level security;

-- Users can see their own follows
drop policy if exists "Users see own follows" on feeder_follows;
create policy "Users see own follows" on feeder_follows
  for select using (auth.uid() = user_id);

drop policy if exists "Users manage own follows" on feeder_follows;
create policy "Users manage own follows" on feeder_follows
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users update own follows" on feeder_follows;
create policy "Users update own follows" on feeder_follows
  for update using (auth.uid() = user_id);

drop policy if exists "Users delete own follows" on feeder_follows;
create policy "Users delete own follows" on feeder_follows
  for delete using (auth.uid() = user_id);

-- Service role full access (for notification edge functions)
drop policy if exists "Service role full access follows" on feeder_follows;
create policy "Service role full access follows" on feeder_follows
  to service_role using (true) with check (true);

-- RPC: Toggle follow a feeder
drop function if exists toggle_feeder_follow(uuid);
create or replace function toggle_feeder_follow(p_feeder_id uuid)
returns json
language plpgsql security definer
as $$
declare
  existing_id uuid;
begin
  select id into existing_id
  from feeder_follows
  where user_id = auth.uid() and feeder_id = p_feeder_id;

  if existing_id is not null then
    delete from feeder_follows where id = existing_id;
    return json_build_object('following', false);
  else
    insert into feeder_follows (user_id, feeder_id)
    values (auth.uid(), p_feeder_id);
    return json_build_object('following', true);
  end if;
end;
$$;

-- RPC: Get user's followed feeders
drop function if exists get_followed_feeders();
create or replace function get_followed_feeders()
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_agg(json_build_object(
    'feeder_id', ff.feeder_id,
    'display_name', f.display_name,
    'notify_rare', ff.notify_rare,
    'followed_at', ff.created_at
  ) order by ff.created_at desc)
  into result
  from feeder_follows ff
  join feeders f on f.id = ff.feeder_id
  where ff.user_id = auth.uid();

  return coalesce(result, '[]'::json);
end;
$$;

-- RPC: Get follower count for a feeder (public)
drop function if exists get_feeder_follower_count(uuid);
create or replace function get_feeder_follower_count(p_feeder_id uuid)
returns int
language plpgsql security definer
as $$
begin
  return (select count(*) from feeder_follows where feeder_id = p_feeder_id);
end;
$$;

grant execute on function toggle_feeder_follow(uuid) to authenticated;
grant execute on function get_followed_feeders() to authenticated;
grant execute on function get_feeder_follower_count(uuid) to anon, authenticated;


-- ── 4. Comments / threads on detections ──────────────────────
create table if not exists detection_comments (
  id            uuid primary key default gen_random_uuid(),
  detection_id  uuid not null references community_detections(id) on delete cascade,
  user_id       uuid not null,
  parent_id     uuid references detection_comments(id) on delete cascade,
  body          text not null check (length(body) between 1 and 2000),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists idx_comments_detection on detection_comments(detection_id);
create index if not exists idx_comments_user      on detection_comments(user_id);
create index if not exists idx_comments_parent    on detection_comments(parent_id);

alter table detection_comments enable row level security;

-- Anyone can read comments
drop policy if exists "Comments are public" on detection_comments;
create policy "Comments are public" on detection_comments
  for select using (true);

-- Authenticated users can post comments
drop policy if exists "Authed users can comment" on detection_comments;
create policy "Authed users can comment" on detection_comments
  for insert with check (auth.uid() = user_id);

-- Users can edit their own comments
drop policy if exists "Users edit own comments" on detection_comments;
create policy "Users edit own comments" on detection_comments
  for update using (auth.uid() = user_id);

-- Users can delete their own comments
drop policy if exists "Users delete own comments" on detection_comments;
create policy "Users delete own comments" on detection_comments
  for delete using (auth.uid() = user_id);

-- Service role full access (for moderation)
drop policy if exists "Service role full access comments" on detection_comments;
create policy "Service role full access comments" on detection_comments
  to service_role using (true) with check (true);

-- RPC: Post a comment
drop function if exists post_comment(uuid, text, uuid);
create or replace function post_comment(
  p_detection_id uuid,
  p_body         text,
  p_parent_id    uuid default null
)
returns json
language plpgsql security definer
as $$
declare
  new_id uuid;
  result json;
begin
  insert into detection_comments (detection_id, user_id, body, parent_id)
  values (p_detection_id, auth.uid(), p_body, p_parent_id)
  returning id into new_id;

  select json_build_object(
    'id', c.id,
    'detection_id', c.detection_id,
    'user_id', c.user_id,
    'display_name', p.display_name,
    'body', c.body,
    'parent_id', c.parent_id,
    'created_at', c.created_at
  ) into result
  from detection_comments c
  join user_profiles p on p.id = c.user_id
  where c.id = new_id;

  return result;
end;
$$;

-- RPC: Get comments for a detection (threaded)
drop function if exists get_comments(uuid);
create or replace function get_comments(p_detection_id uuid)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_agg(json_build_object(
    'id', c.id,
    'detection_id', c.detection_id,
    'user_id', c.user_id,
    'display_name', p.display_name,
    'body', c.body,
    'parent_id', c.parent_id,
    'created_at', c.created_at
  ) order by c.created_at asc)
  into result
  from detection_comments c
  join user_profiles p on p.id = c.user_id
  where c.detection_id = p_detection_id;

  return coalesce(result, '[]'::json);
end;
$$;

-- RPC: Delete own comment
drop function if exists delete_comment(uuid);
create or replace function delete_comment(p_comment_id uuid)
returns boolean
language plpgsql security definer
as $$
begin
  delete from detection_comments
  where id = p_comment_id and user_id = auth.uid();
  return found;
end;
$$;

-- RPC: Get comment count per detection (for feed badges)
drop function if exists get_comment_counts(uuid[]);
create or replace function get_comment_counts(p_detection_ids uuid[])
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_object_agg(detection_id, cnt) into result
  from (
    select detection_id, count(*)::int as cnt
    from detection_comments
    where detection_id = any(p_detection_ids)
    group by detection_id
  ) sub;

  return coalesce(result, '{}'::json);
end;
$$;

grant execute on function post_comment(uuid, text, uuid) to authenticated;
grant execute on function get_comments(uuid) to anon, authenticated;
grant execute on function delete_comment(uuid) to authenticated;
grant execute on function get_comment_counts(uuid[]) to anon, authenticated;


-- ── 5. Flagging / reporting ──────────────────────────────────
create table if not exists detection_flags (
  id            uuid primary key default gen_random_uuid(),
  detection_id  uuid not null references community_detections(id) on delete cascade,
  user_id       uuid not null,
  reason        text not null check (reason in (
                  'wrong_species', 'inappropriate', 'duplicate', 'spam', 'other'
                )),
  details       text default '',
  status        text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  reviewed_by   uuid references moderators(id),
  reviewed_at   timestamptz,
  created_at    timestamptz default now(),
  unique(detection_id, user_id)  -- one flag per user per detection
);

create index if not exists idx_flags_detection on detection_flags(detection_id);
create index if not exists idx_flags_status    on detection_flags(status);

alter table detection_flags enable row level security;

-- Users can see their own flags
drop policy if exists "Users see own flags" on detection_flags;
create policy "Users see own flags" on detection_flags
  for select using (auth.uid() = user_id);

-- Authenticated users can create flags
drop policy if exists "Authed users can flag" on detection_flags;
create policy "Authed users can flag" on detection_flags
  for insert with check (auth.uid() = user_id);

-- Service role full access (for moderation queue)
drop policy if exists "Service role full access flags" on detection_flags;
create policy "Service role full access flags" on detection_flags
  to service_role using (true) with check (true);

-- RPC: Flag a detection
drop function if exists flag_detection(uuid, text, text);
create or replace function flag_detection(
  p_detection_id uuid,
  p_reason       text,
  p_details      text default ''
)
returns json
language plpgsql security definer
as $$
declare
  new_id uuid;
begin
  insert into detection_flags (detection_id, user_id, reason, details)
  values (p_detection_id, auth.uid(), p_reason, p_details)
  on conflict (detection_id, user_id) do update
    set reason = excluded.reason,
        details = excluded.details,
        status = 'pending',
        reviewed_by = null,
        reviewed_at = null;

  return json_build_object('flagged', true, 'detection_id', p_detection_id);
end;
$$;

-- RPC: Get moderation queue (moderator-only, uses existing moderator auth)
drop function if exists get_flag_queue(text, text);
create or replace function get_flag_queue(p_email text, p_password text)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
  result json;
begin
  select id into mod_id
  from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);

  if mod_id is null then
    raise exception 'Invalid moderator credentials';
  end if;

  select json_agg(json_build_object(
    'flag_id', f.id,
    'detection_id', f.detection_id,
    'species', d.species,
    'image_url', d.image_url,
    'reason', f.reason,
    'details', f.details,
    'reporter_name', p.display_name,
    'created_at', f.created_at,
    'flag_count', fc.cnt
  ) order by f.created_at desc)
  into result
  from detection_flags f
  join community_detections d on d.id = f.detection_id
  left join user_profiles p on p.id = f.user_id
  left join (
    select detection_id, count(*)::int as cnt
    from detection_flags
    where status = 'pending'
    group by detection_id
  ) fc on fc.detection_id = f.detection_id
  where f.status = 'pending';

  return coalesce(result, '[]'::json);
end;
$$;

-- RPC: Resolve a flag (moderator-only)
drop function if exists resolve_flag(text, text, uuid, text);
create or replace function resolve_flag(
  p_email    text,
  p_password text,
  p_flag_id  uuid,
  p_action   text  -- 'reviewed' or 'dismissed'
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

  update detection_flags
  set status = p_action,
      reviewed_by = mod_id,
      reviewed_at = now()
  where id = p_flag_id;

  return found;
end;
$$;

grant execute on function flag_detection(uuid, text, text) to authenticated;
grant execute on function get_flag_queue(text, text) to anon;
grant execute on function resolve_flag(text, text, uuid, text) to anon;


-- ── 6. Moderator-accessible community functions ─────────────
-- These allow moderators (who use a separate auth system) to use
-- community features without needing a Supabase Auth session.
-- They verify moderator credentials and accept a user_id parameter.

-- Mod: add to life list
drop function if exists mod_add_to_life_list(text, text, text, text, uuid, text);
create or replace function mod_add_to_life_list(
  p_email        text,
  p_password     text,
  p_user_id      text,
  p_species      text,
  p_detection_id uuid default null,
  p_notes        text default ''
)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  insert into user_life_list (user_id, species, detection_id, notes, first_seen)
  values (p_user_id::uuid, p_species, p_detection_id, p_notes, now())
  on conflict (user_id, species) do nothing;

  return json_build_object('species', p_species, 'added', true);
end;
$$;

-- Mod: remove from life list
drop function if exists mod_remove_from_life_list(text, text, text, text);
create or replace function mod_remove_from_life_list(
  p_email    text,
  p_password text,
  p_user_id  text,
  p_species  text
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  delete from user_life_list where user_id = p_user_id::uuid and species = p_species;
  return found;
end;
$$;

-- Mod: post comment
drop function if exists mod_post_comment(text, text, text, uuid, text, uuid);
create or replace function mod_post_comment(
  p_email        text,
  p_password     text,
  p_user_id      text,
  p_detection_id uuid,
  p_body         text,
  p_parent_id    uuid default null
)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
  new_id uuid;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  insert into detection_comments (detection_id, user_id, body, parent_id)
  values (p_detection_id, p_user_id::uuid, p_body, p_parent_id)
  returning id into new_id;

  return json_build_object(
    'id', new_id,
    'detection_id', p_detection_id,
    'user_id', p_user_id,
    'display_name', (select display_name from user_profiles where id = p_user_id::uuid),
    'body', p_body,
    'parent_id', p_parent_id,
    'created_at', now()
  );
end;
$$;

-- Mod: delete comment
drop function if exists mod_delete_comment(text, text, uuid);
create or replace function mod_delete_comment(
  p_email      text,
  p_password   text,
  p_comment_id uuid
)
returns boolean
language plpgsql security definer
as $$
declare
  mod_id uuid;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  delete from detection_comments where id = p_comment_id;
  return found;
end;
$$;

-- Mod: toggle follow feeder
drop function if exists mod_toggle_feeder_follow(text, text, text, uuid);
create or replace function mod_toggle_feeder_follow(
  p_email     text,
  p_password  text,
  p_user_id   text,
  p_feeder_id uuid
)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
  existing_id uuid;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  select id into existing_id from feeder_follows
  where user_id = p_user_id::uuid and feeder_id = p_feeder_id;

  if existing_id is not null then
    delete from feeder_follows where id = existing_id;
    return json_build_object('following', false);
  else
    insert into feeder_follows (user_id, feeder_id)
    values (p_user_id::uuid, p_feeder_id);
    return json_build_object('following', true);
  end if;
end;
$$;

-- Mod: global comment history across all detections (chronological)
drop function if exists mod_get_comment_history(text, text, int, int);
create or replace function mod_get_comment_history(
  p_email    text,
  p_password text,
  p_limit    int default 100,
  p_offset   int default 0
)
returns json
language plpgsql security definer
as $$
declare
  mod_id uuid;
  result json;
begin
  select id into mod_id from moderators
  where email = lower(trim(p_email))
    and password_hash = crypt(p_password, password_hash);
  if mod_id is null then raise exception 'Invalid moderator credentials'; end if;

  select json_agg(row_to_json(t)) into result
  from (
    select
      c.id            as comment_id,
      c.detection_id,
      c.user_id,
      p.display_name,
      c.body,
      c.parent_id,
      c.created_at,
      d.species,
      d.image_url
    from detection_comments c
    left join user_profiles p on p.id = c.user_id
    left join community_detections d on d.id = c.detection_id
    order by c.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

grant execute on function mod_add_to_life_list(text, text, text, text, uuid, text) to anon;
grant execute on function mod_remove_from_life_list(text, text, text, text) to anon;
grant execute on function mod_post_comment(text, text, text, uuid, text, uuid) to anon;
grant execute on function mod_delete_comment(text, text, uuid) to anon;
grant execute on function mod_toggle_feeder_follow(text, text, text, uuid) to anon;
grant execute on function mod_get_comment_history(text, text, int, int) to anon;
