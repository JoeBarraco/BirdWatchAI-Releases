-- ============================================================
-- BirdWatchAI Detection Reactions Setup
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Allows community users to react to detections with emojis.
-- Reactions are shared across all users (visible to everyone).
-- Users are identified by an anonymous device UUID stored in
-- their browser's localStorage.
-- ============================================================

-- 1. Create reactions table
create table if not exists detection_reactions (
  id            uuid primary key default gen_random_uuid(),
  detection_id  uuid not null references community_detections(id) on delete cascade,
  user_id       text not null,          -- anonymous UUID from client localStorage
  emoji         text not null,          -- one of: liked, wow, celebrate, bird
  created_at    timestamptz default now(),
  unique(detection_id, user_id, emoji)  -- one reaction per emoji per user per detection
);

-- 2. Indexes for fast lookups
create index if not exists idx_reactions_detection on detection_reactions(detection_id);
create index if not exists idx_reactions_user      on detection_reactions(user_id);

-- 3. Row-level security
alter table detection_reactions enable row level security;

-- Allow anyone to read all reactions (they're public)
drop policy if exists "Anyone can read reactions" on detection_reactions;
create policy "Anyone can read reactions" on detection_reactions
  for select to anon using (true);

-- Allow anyone to insert reactions (identified by user_id in the row)
drop policy if exists "Anyone can insert reactions" on detection_reactions;
create policy "Anyone can insert reactions" on detection_reactions
  for insert to anon with check (true);

-- Allow anyone to delete their own reactions
drop policy if exists "Anyone can delete own reactions" on detection_reactions;
create policy "Anyone can delete own reactions" on detection_reactions
  for delete to anon using (true);

-- 4. RPC: Toggle a reaction (insert if missing, delete if exists)
--    Returns the new state: true = reacted, false = un-reacted
drop function if exists toggle_reaction(uuid, text, text);
create or replace function toggle_reaction(
  p_detection_id uuid,
  p_user_id      text,
  p_emoji        text
)
returns json
language plpgsql security definer
as $$
declare
  existing_id uuid;
  new_counts  json;
begin
  -- Check if reaction already exists
  select id into existing_id
  from detection_reactions
  where detection_id = p_detection_id
    and user_id = p_user_id
    and emoji = p_emoji;

  if existing_id is not null then
    -- Remove existing reaction
    delete from detection_reactions where id = existing_id;
  else
    -- Add new reaction
    insert into detection_reactions (detection_id, user_id, emoji)
    values (p_detection_id, p_user_id, p_emoji);
  end if;

  -- Return updated counts for this detection + whether current user reacted
  select json_object_agg(emoji, info) into new_counts
  from (
    select
      dr.emoji,
      json_build_object(
        'count', count(*),
        'reacted', bool_or(dr.user_id = p_user_id)
      ) as info
    from detection_reactions dr
    where dr.detection_id = p_detection_id
    group by dr.emoji
  ) sub;

  return coalesce(new_counts, '{}'::json);
end;
$$;

-- 5. RPC: Get reaction counts for multiple detections at once
--    Returns { detection_id: { emoji: { count, reacted } } }
drop function if exists get_reaction_counts(uuid[], text);
create or replace function get_reaction_counts(
  p_detection_ids uuid[],
  p_user_id       text
)
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_object_agg(detection_id, emojis) into result
  from (
    select
      dr.detection_id,
      json_object_agg(dr.emoji, json_build_object(
        'count', dr.cnt,
        'reacted', dr.user_reacted
      )) as emojis
    from (
      select
        detection_id,
        emoji,
        count(*)::int as cnt,
        bool_or(user_id = p_user_id) as user_reacted
      from detection_reactions
      where detection_id = any(p_detection_ids)
      group by detection_id, emoji
    ) dr
    group by dr.detection_id
  ) grouped;

  return coalesce(result, '{}'::json);
end;
$$;

-- 6. RPC: Get total reaction count per detection (for sorting by most liked)
--    Returns array of { detection_id, total_reactions }
drop function if exists get_reaction_totals();
create or replace function get_reaction_totals()
returns json
language plpgsql security definer
as $$
declare
  result json;
begin
  select json_object_agg(detection_id, total) into result
  from (
    select detection_id, count(*)::int as total
    from detection_reactions
    group by detection_id
  ) sub;

  return coalesce(result, '{}'::json);
end;
$$;

-- 7. Grant anon access to call the RPC functions
grant execute on function toggle_reaction(uuid, text, text) to anon;
grant execute on function get_reaction_counts(uuid[], text) to anon;
grant execute on function get_reaction_totals() to anon;

-- 8. Migration: Convert is_favorite detections into ❤️ reactions
--    Attributes the like to 'feeder-owner' so it's clear these came
--    from the original feeder upload. Safe to run multiple times
--    (uses ON CONFLICT to skip duplicates).
insert into detection_reactions (detection_id, user_id, emoji)
select id, 'feeder-owner', 'liked'
from community_detections
where is_favorite = true
on conflict (detection_id, user_id, emoji) do nothing;
