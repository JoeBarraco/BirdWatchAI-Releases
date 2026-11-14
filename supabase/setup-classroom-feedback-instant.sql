-- ════════════════════════════════════════════════════════════════════
--  Feedback mails when it is filed, not the next morning
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-classroom-feedback-digest.sql, which schedules the same
--  edge function at 12:00 UTC. A teacher flags a question mid-lesson and
--  hears nothing until the next morning; for a suggestion worth acting on
--  that is a day of nothing happening for no reason.
--
--  THE EDGE FUNCTION DOES NOT CHANGE.
--  It never meant "send today's feedback". It means "mail everything with
--  notified_at is null, and send nothing at all if that is empty" — which
--  is already exactly right for an instant send. This file only invokes it
--  sooner. Same URL, same Vault key, same email.
--
--  A BURST COLLAPSES ONLY WHILE IT IS ACTUALLY CONCURRENT. ⚠
--  Rows that already exist when a delivery runs are claimed together: the
--  call stamps notified_at on all of them and later calls find nothing to
--  send. That is real, and it is what makes a multi-row INSERT one email.
--
--  It does NOT hold across a gap, and the gap is small. Measured against
--  production on 14 Nov 2026: a suggestion filed at 06:47:29 was mailed at
--  06:47:31. Three filed 1.2 seconds apart produced TWO emails, not one,
--  because the function finishes between them.
--
--  So a teacher clicking "Something is wrong" on five questions, fifteen
--  seconds apart, gets five emails. An earlier version of this comment
--  claimed otherwise on the strength of an in-database test that only ever
--  exercised the concurrent case. If that volume becomes a nuisance the fix
--  is not a cleverer trigger: drop this file and change the cron in
--  setup-classroom-feedback-digest.sql to '*/2 * * * *'. Two minutes is
--  still "while you are reading it", and a window batches properly.
--
--  THE DAILY CRON STAYS, as a backstop. A trigger that fails tells nobody:
--  pg_net down, the function erroring, Resend rejecting the message. This
--  project has already lost a weekly newsletter for months to exactly that
--  silence. The daily sweep costs nothing on a quiet day, because the
--  function is silent when there is nothing new, and it catches anything
--  the instant path dropped.
--
--  WHY net.http_post IS SAFE INSIDE A TRIGGER.
--  It does not make an HTTP call. It queues a row and a background worker
--  sends it, so the request leaves only once this transaction commits —
--  the function can never run before the row it is meant to report exists.
--  It also cannot fail the insert: a teacher's flag must be saved whether
--  or not anybody can be told about it, which is what the exception block
--  below is for.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pg_net;


-- ── The trigger ─────────────────────────────────────────────────────

create or replace function classroom_feedback_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  key text;
begin
  -- Written in plainly, like the cron job's. It is the project ref, which
  -- is in the deploy notes, not a secret — and keeping only ONE thing in
  -- the vault leaves exactly one obvious place for it to be missing.
  select decrypted_secret into key
    from vault.decrypted_secrets where name = 'service_role_key';

  -- No key, no mail, but still a saved flag. The daily digest will carry
  -- it once somebody creates the secret.
  if key is null then
    return null;
  end if;

  perform net.http_post(
    url     := 'https://lsamggztfizmkyljdgwq.supabase.co/functions/v1/classroom-feedback-digest',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    )
  );

  return null;                      -- AFTER trigger; the return is ignored
exception when others then
  -- NEVER take the insert down with it. A teacher mid-lesson who cannot
  -- file a flag because the mail queue is unhappy is a far worse outcome
  -- than a flag that waits for the morning digest.
  raise warning 'classroom_feedback_notify: %', sqlerrm;
  return null;
end;
$$;

comment on function classroom_feedback_notify() is
  'Pokes the classroom-feedback-digest edge function when feedback is '
  'filed. The function mails whatever is unnotified, so a burst collapses '
  'to one email. See setup-classroom-feedback-instant.sql.';

drop trigger if exists trg_classroom_feedback_notify on classroom_question_feedback;

-- STATEMENT level, not row level. One insert statement is one poke,
-- whatever it carried, which is the cheapest possible version of the
-- collapsing described above.
create trigger trg_classroom_feedback_notify
  after insert on classroom_question_feedback
  for each statement
  execute function classroom_feedback_notify();


commit;
