-- ────────────────────────────────────────────────────────────────────────────
-- One-shot grandfather migration. RUN ONCE on go-live day.
-- ────────────────────────────────────────────────────────────────────────────
--
-- WHY:
-- Subscription tiers are about to go live. Every existing feeder is
-- currently `free` (the column default from setup-subscriptions.sql) and
-- has never had a chance to subscribe. If we flipped the cron on now,
-- everything older than 7 days would soft-expire the next morning and
-- 30 days later all those photos would be permanently gone — without the
-- owner ever knowing the tier system existed. That's the disruption we're
-- avoiding.
--
-- WHAT:
-- Grant every existing feeder `pro` (365-day retention) for one year,
-- granted_by = 'launch-grandfather'. The renewal cron picks this up the
-- usual way: ~30 days before renews_at, an email goes to contact_email
-- with the choice — subscribe to keep the long retention, downgrade to
-- plus, or accept fall-back to free. After the year, the feeder drops to
-- free and any photos older than 7 days enter the normal media grace
-- (30 days) before hard delete. So nothing is suddenly deleted — owners
-- get at least 13 months of notice from this script's execution date.
--
-- Privacy is intentionally NOT grandfathered. Turning every existing
-- feeder private would empty the community feed overnight, which is the
-- opposite of what the community page is for. Privacy buyers opt in.
--
-- IDEMPOTENCY:
-- This script ONLY touches feeders where granted_by is null. Re-running
-- it is a no-op after the first run. Manually-granted tiers (admin
-- comp accounts) keep their existing granted_by and are not stomped.
--
-- HOW TO RUN:
-- 1. Edit the LAUNCH_DATE below to today's date (YYYY-MM-DD).
-- 2. Apply this file via the Supabase SQL editor.
-- 3. Verify: select count(*) from feeders where subscription_granted_by='launch-grandfather';
--    should equal the pre-migration row count.
-- ────────────────────────────────────────────────────────────────────────────

-- ⬇⬇⬇ EDIT THIS BEFORE RUNNING ⬇⬇⬇
\set launch_date '\'2026-07-01\''
-- ⬆⬆⬆ EDIT THIS BEFORE RUNNING ⬆⬆⬆

begin;

with grandfathered as (
    update feeders
       set subscription_tier        = 'pro',
           subscription_renews_at   = (date :launch_date + interval '1 year')::timestamptz,
           subscription_granted_by  = 'launch-grandfather',
           subscription_granted_at  = now()
     where subscription_granted_by is null  -- only untouched rows
       and subscription_tier = 'free'        -- belt-and-suspenders
    returning id, display_name
)
select 'grandfathered ' || count(*)::text || ' feeders to pro until '
       || (date :launch_date + interval '1 year')::date as result
  from grandfathered;

commit;

-- Sanity:
--   select subscription_tier, subscription_granted_by, count(*)
--     from feeders group by 1,2 order by 3 desc;
--
-- Expected immediately after running this:
--   pro  | launch-grandfather | N    ← every previously-untouched feeder
--   <whatever existing admin grants were>
