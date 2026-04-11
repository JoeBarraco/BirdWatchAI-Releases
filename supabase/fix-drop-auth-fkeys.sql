-- ============================================================
-- FIX: Drop auth.users foreign keys so moderators can use
-- community features (life lists, comments, follow feeders)
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- Find and drop FK constraints on user_id -> auth.users
-- for each community table

-- user_life_list
do $$
declare
  fk_name text;
begin
  select constraint_name into fk_name
  from information_schema.table_constraints
  where table_name = 'user_life_list'
    and constraint_type = 'FOREIGN KEY'
    and constraint_name like '%user_id%';
  if fk_name is not null then
    execute format('alter table user_life_list drop constraint %I', fk_name);
  end if;
end $$;

-- Also try the auto-generated name pattern
alter table user_life_list drop constraint if exists user_life_list_user_id_fkey;

-- feeder_follows
alter table feeder_follows drop constraint if exists feeder_follows_user_id_fkey;

-- detection_comments
alter table detection_comments drop constraint if exists detection_comments_user_id_fkey;

-- detection_flags
alter table detection_flags drop constraint if exists detection_flags_user_id_fkey;

-- Also ensure moderators can insert into these tables via security definer functions
-- by adding service_role policies
drop policy if exists "Service role full access life list" on user_life_list;
create policy "Service role full access life list" on user_life_list
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access comments" on detection_comments;
create policy "Service role full access comments" on detection_comments
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access follows" on feeder_follows;
create policy "Service role full access follows" on feeder_follows
  for all to service_role using (true) with check (true);
