-- ════════════════════════════════════════════════════════════════════
--  Tell the teacher when their note is dealt with
-- ════════════════════════════════════════════════════════════════════
--
--  A teacher flags a question mid-lesson, and until now the only way to
--  learn it was fixed was to stumble on the fixed question weeks later.
--  That teaches people that flagging goes nowhere, which is the one
--  lesson this feature cannot afford to teach. So when a note is resolved,
--  the person who filed it gets one short email saying what changed.
--
--  Goes with supabase/functions/classroom-feedback-resolved, which does
--  the sending. Follows setup-classroom-feedback-instant.sql: same trigger
--  shape, same Vault key, same daily backstop, for the same reasons.
--
--  WHICH RESOLUTIONS MAIL. ⚠
--  Only ones with resolved_by NULL, meaning resolved by BirdWatchAI itself
--  (the review task resolves with the service role, so auth.uid() is null).
--  A school's own owner or moderator can also "✓ Mark closed" a note in the
--  Review list (classroom_feedback_resolve), which records who did it and
--  takes no reason. Mailing a teacher "closed" with no explanation, about a
--  decision their own school made, is noise, so those stay silent, as they
--  always have been.
--
--  WHAT IT SAYS COMES FROM resolved_note. The review task writes it as
--  "Fixed in <hash>: <a sentence a teacher can read>" for a fix and
--  "Not changing: <the reason>" for a decision against. The function strips
--  the hash, since a commit id means nothing to a teacher, and words the
--  email for whichever of the two it is.
--
--  ONE EMAIL PER ROW, EVER: resolved_notified_at, claimed BEFORE sending. ⚠
--  The instant digest marks rows after sending and lives with the odd
--  duplicate. That is fine for one inbox that belongs to us and not fine
--  for a teacher's. Three resolves in a row fire three triggers whose calls
--  overlap, so the edge function claims rows through
--  classroom_feedback_claim_resolved, which stamps them under SKIP LOCKED:
--  two overlapping calls can never both get the same row. A send that
--  fails hands its rows back (classroom_feedback_unclaim_resolved) for the
--  daily sweep to retry.
--
--  NOTHING ALREADY RESOLVED MAILS. The backfill below stamps every row that
--  is resolved now, so switching this on does not send a pile of emails
--  about fixes from last week.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq)
--  AFTER deploying the function. Idempotent, so safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;

create extension if not exists pg_net;

alter table classroom_question_feedback
  add column if not exists resolved_notified_at timestamptz;

comment on column classroom_question_feedback.resolved_notified_at is
  'When the submitter was emailed that this note was resolved. Set (claimed) '
  'just before sending; cleared again if the send fails. See '
  'setup-classroom-feedback-resolved.sql.';

-- The backfill. Only rows still unstamped, so a re-run cannot touch a
-- stamp the function has written.
update classroom_question_feedback
   set resolved_notified_at = resolved_at
 where resolved_at is not null
   and resolved_notified_at is null;

-- What the sweep looks for, kept small: only rows awaiting an email.
create index if not exists classroom_feedback_resolved_unsent
  on classroom_question_feedback (resolved_at)
  where resolved_at is not null and resolved_notified_at is null and resolved_by is null;


-- ── Claim and unclaim ───────────────────────────────────────────────

create or replace function classroom_feedback_claim_resolved(p_limit int default 50)
returns setof classroom_question_feedback
language sql security definer
set search_path = public
as $$
  with pick as (
    select id from classroom_question_feedback
     where resolved_at is not null
       and resolved_notified_at is null
       and resolved_by is null
     order by resolved_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  )
  update classroom_question_feedback f
     set resolved_notified_at = now()
    from pick
   where f.id = pick.id
  returning f.*;
$$;

create or replace function classroom_feedback_unclaim_resolved(p_ids uuid[])
returns void
language sql security definer
set search_path = public
as $$
  update classroom_question_feedback
     set resolved_notified_at = null
   where id = any(p_ids);
$$;

-- Service role only. These hand out teachers' notes and decide who gets
-- mailed; nobody signed in to the site has any business calling them.
revoke all on function classroom_feedback_claim_resolved(int)    from public, anon, authenticated;
revoke all on function classroom_feedback_unclaim_resolved(uuid[]) from public, anon, authenticated;
grant execute on function classroom_feedback_claim_resolved(int)    to service_role;
grant execute on function classroom_feedback_unclaim_resolved(uuid[]) to service_role;


-- ── The trigger ─────────────────────────────────────────────────────

create or replace function classroom_feedback_resolved_notify()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  key text;
begin
  select decrypted_secret into key
    from vault.decrypted_secrets where name = 'service_role_key';
  if key is null then
    return null;                    -- the daily sweep carries it later
  end if;

  perform net.http_post(
    url     := 'https://lsamggztfizmkyljdgwq.supabase.co/functions/v1/classroom-feedback-resolved',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || key
    )
  );
  return null;
exception when others then
  -- Never take the resolve down with it. A fix that cannot be marked
  -- resolved because the mail queue is unhappy helps nobody.
  raise warning 'classroom_feedback_resolved_notify: %', sqlerrm;
  return null;
end;
$$;

drop trigger if exists trg_classroom_feedback_resolved_notify on classroom_question_feedback;

-- Row level with a WHEN, so only a real null -> resolved change by
-- BirdWatchAI pokes the function, not every edit of a resolved row.
create trigger trg_classroom_feedback_resolved_notify
  after update of resolved_at on classroom_question_feedback
  for each row
  when (old.resolved_at is null and new.resolved_at is not null and new.resolved_by is null)
  execute function classroom_feedback_resolved_notify();


-- ── The backstop ────────────────────────────────────────────────────
--
-- Half an hour after the morning digest. Silent when there is nothing to
-- send, and it catches anything the trigger dropped or a failed send
-- handed back.

select cron.unschedule('classroom-feedback-resolved')
 where exists (select 1 from cron.job where jobname = 'classroom-feedback-resolved');

select cron.schedule(
  'classroom-feedback-resolved',
  '30 12 * * *',
  $$
    select net.http_post(
      url    := 'https://lsamggztfizmkyljdgwq.supabase.co/functions/v1/classroom-feedback-resolved',
      body   := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      )
    );
  $$
);

commit;
