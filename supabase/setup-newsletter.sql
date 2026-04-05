-- ============================================================
-- BirdWatchAI Newsletter Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. Create newsletter_signups table (if it doesn't exist yet)
create table if not exists newsletter_signups (
  id                uuid primary key default gen_random_uuid(),
  email             text unique not null,
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at        timestamptz default now()
);

-- 2. Add unsubscribe_token column if table already exists without it
alter table newsletter_signups
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();

-- 3. Row-level security: allow public (anon) inserts only
alter table newsletter_signups enable row level security;

drop policy if exists "Allow public inserts" on newsletter_signups;
create policy "Allow public inserts" on newsletter_signups
  for insert to anon with check (true);

-- Service role can read/delete (for the edge functions)
drop policy if exists "Service role full access" on newsletter_signups;
create policy "Service role full access" on newsletter_signups
  to service_role using (true) with check (true);


-- ============================================================
-- 4. Schedule the weekly digest — every Sunday at 9 AM ET
--    (14:00 UTC covers EST; shift to 13:00 UTC in summer/EDT)
-- ============================================================

-- Enable pg_cron and pg_net extensions (if not already enabled)
-- You can also enable these in: Dashboard → Database → Extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove old job if re-running this script
select cron.unschedule('weekly-bird-digest') where exists (
  select 1 from cron.job where jobname = 'weekly-bird-digest'
);

-- Schedule: every Sunday at 14:00 UTC (= 9 AM EST / 10 AM EDT)
select cron.schedule(
  'weekly-bird-digest',
  '0 14 * * 0',
  $$
    select net.http_post(
      url    := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_functions_url') || '/weekly-digest',
      body   := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      )
    );
  $$
);
