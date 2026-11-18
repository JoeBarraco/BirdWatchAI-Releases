-- ============================================================
-- BirdWatchAI Home Classroom — a 7-day trial
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-home-classroom.sql and setup-home-trial-no-grace.sql.
--
-- Decided 2026-11-18: the free trial is 7 days, not 30, and (per
-- setup-home-trial-no-grace.sql) it stops on day 7 with no grace after it.
-- home_classroom_start reads its length from this one function, so this
-- is the whole change. Home Classrooms already started keep the end date
-- they were given.
-- ============================================================

begin;
create or replace function home_classroom_trial_days() returns int
language sql immutable as $$ select 7 $$;
revoke execute on function home_classroom_trial_days() from public, anon, authenticated;
commit;
