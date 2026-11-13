-- ════════════════════════════════════════════════════════════════════
-- Classroom feedback: a daily digest by email
--
-- Run after setup-classroom-feedback.sql. Safe to re-run.
--
-- WHY
-- Teachers flag questions mid-lesson. Until now the only way to find out
-- was to go and look — either by opening the review panel, or by a
-- scheduled task on a laptop that had to be switched on, with the app
-- open, holding a live browser session. All of those are ways of saying
-- "someone remembers to check". Roland Park is about to put four
-- teachers in front of this, and a flag that nobody reads for a week is
-- the same as no flag at all.
--
-- This runs in the database, on Supabase's clock, and mails whatever is
-- new. No laptop, no browser session, nothing to remember.
--
-- WHAT "NEW" MEANS
-- notified_at, below. Without it the only available filter would be
-- "unresolved", which means every morning re-sends everything still
-- open until it is dealt with — which trains you to ignore the mail. A
-- row is mailed once, when it first appears. Resolving it stays an
-- entirely separate thing from having been told about it, which is why
-- this is a new column and not a reuse of resolved_at.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. The marker
-- ────────────────────────────────────────────────────────────────────

alter table classroom_question_feedback
  add column if not exists notified_at timestamptz;

comment on column classroom_question_feedback.notified_at is
  'When this row was included in a feedback digest email. NULL means it '
  'has never been mailed. Deliberately separate from resolved_at: being '
  'told about a flag and dealing with it are different events.';

-- The digest's only query: everything never mailed, newest first.
create index if not exists idx_feedback_unnotified
  on classroom_question_feedback (created_at desc)
  where notified_at is null;


-- ────────────────────────────────────────────────────────────────────
-- 2. Backfill
--
-- Everything that exists today has already been seen and acted on, in
-- the session this was written in. Without this the first digest would
-- arrive carrying the entire history as though it were news.
-- ────────────────────────────────────────────────────────────────────

update classroom_question_feedback
   set notified_at = now()
 where notified_at is null;


-- ────────────────────────────────────────────────────────────────────
-- 3. The schedule — daily at 12:00 UTC (7am EST / 8am EDT)
--
-- Before the school day, so a flag raised in yesterday's lesson is in
-- the inbox before today's. Same vault secrets as the weekly digest,
-- which is already running on this pattern.
--
-- The function sends NOTHING when there is nothing new, so a quiet day
-- is a silent one rather than an empty email.
-- ────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('classroom-feedback-digest') where exists (
  select 1 from cron.job where jobname = 'classroom-feedback-digest'
);

select cron.schedule(
  'classroom-feedback-digest',
  '0 12 * * *',
  $$
    select net.http_post(
      url    := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_functions_url') || '/classroom-feedback-digest',
      body   := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      )
    );
  $$
);
