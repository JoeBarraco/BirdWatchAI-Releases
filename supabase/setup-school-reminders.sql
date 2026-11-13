-- ════════════════════════════════════════════════════════════════════
--  Renewal reminders for school subscriptions
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-school-subscription.sql and setup-school-purchase.sql.
--
--  WHY
--  An annual term bought in November falls due in November, and the
--  warning lands in a school inbox during a week nobody is reading
--  mail. The 30-day grace window was built for exactly that, but grace
--  is a safety net, not a notification: a school that uses up its grace
--  without ever being told has still been surprised, just later.
--
--  FOUR STAGES, ONE EMAIL EACH
--
--    t30      30 days left        "this is coming, here is the cost"
--    t7        7 days left        "this is next week"
--    expired   term ended         "lessons still run until <date>"
--    stopped   grace ended        "lessons have stopped; nothing lost"
--
--  Only the CURRENT stage is ever sent. Stages are monotonic in time,
--  so a school that is already in grace when this first runs gets the
--  'expired' mail and not a backlog of the three it missed. That
--  matters on the very first run, which is the one most likely to find
--  a term already past its date.
--
--  ONCE PER TERM, NOT ONCE PER COMMUNITY. The sent-marker is keyed on
--  the expiry date as well as the stage, so renewing re-arms the whole
--  cycle automatically: a new expiry is a new term, and next year's
--  reminders are not suppressed by this year's.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. What has been said, and about which term ─────────────────────

create table if not exists community_school_reminders (
    id            uuid primary key default gen_random_uuid(),
    community_id  uuid not null references communities(id) on delete cascade,

    -- t30 | t7 | expired | stopped
    stage         text not null,

    -- The term this was about. Part of the key, so a renewal starts a
    -- fresh cycle rather than inheriting last year's "already told
    -- them". Null is impossible here: a perpetual community has no
    -- term and is never reminded.
    term_expires_at timestamptz not null,

    sent_to       text,
    sent_at       timestamptz not null default now()
);

alter table community_school_reminders
  drop constraint if exists community_school_reminders_stage_check;
alter table community_school_reminders
  add  constraint community_school_reminders_stage_check
  check (stage in ('t30', 't7', 'expired', 'stopped'));

-- The guarantee that one stage of one term is mailed once, however
-- many times the job runs or overlaps with itself.
create unique index if not exists idx_school_reminders_once
  on community_school_reminders (community_id, stage, term_expires_at);

comment on table community_school_reminders is
  'One row per reminder email sent about one school term. Keyed on the '
  'expiry date so a renewal re-arms the cycle. See setup-school-reminders.sql.';

alter table community_school_reminders enable row level security;

-- No anon or authenticated policy at all. Nothing in the app reads
-- this; it exists so the cron job does not mail the same school twice.
drop policy if exists "Service role full access school reminders"
  on community_school_reminders;
create policy "Service role full access school reminders"
  on community_school_reminders
  for all to service_role using (true) with check (true);


-- ── 2. Which stage is a term in right now? ──────────────────────────
--
-- Returns null when there is nothing to say: not a school, perpetual,
-- no term, or more than 30 days left.
--
-- The boundaries are half-open and deliberately ordered so that every
-- instant belongs to exactly one stage. An off-by-one here does not
-- produce a wrong email, it produces two.

create or replace function community_school_reminder_stage(p_community_id uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when c.kind <> 'school'            then null
    when c.school_perpetual            then null
    when c.school_expires_at is null   then null
    when now() >= c.school_expires_at
                  + community_school_grace()            then 'stopped'
    when now() >= c.school_expires_at                   then 'expired'
    when now() >= c.school_expires_at - interval '7 days'  then 't7'
    when now() >= c.school_expires_at - interval '30 days' then 't30'
    else null
  end
  from communities c where c.id = p_community_id;
$$;

grant execute on function community_school_reminder_stage(uuid) to service_role;


-- ── 3. Who needs mailing today ──────────────────────────────────────
--
-- Everything the edge function needs to write the email, in one query,
-- including the owner's address out of auth.users — communities only
-- stores the owner's id, and an edge function should not be making a
-- second round trip per school to turn one into the other.
--
-- Rows already recorded in community_school_reminders are excluded
-- here rather than filtered in the function, so a job that crashes
-- half way through resumes correctly on the next run: what was sent is
-- what was marked.

create or replace function school_terms_due_reminders()
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  select json_agg(row_to_json(t) order by t.expires_at) into result
  from (
    select c.id            as community_id,
           c.slug,
           c.name,
           c.school_expires_at                          as expires_at,
           c.school_expires_at + community_school_grace() as grace_ends_at,
           community_school_reminder_stage(c.id)        as stage,
           floor(extract(epoch from
             (c.school_expires_at - now())) / 86400)::int as days_left,
           u.email                                      as owner_email,
           coalesce(nullif(p.display_name, ''), '')     as owner_name,
           (select count(*) from classrooms r
             where r.community_id = c.id and r.archived_at is null) as classroom_count
      from communities c
      left join auth.users    u on u.id = c.owner_user_id
      left join user_profiles p on p.id = c.owner_user_id
     where c.kind = 'school'
       and not c.school_perpetual
       and c.school_expires_at is not null
       and community_school_reminder_stage(c.id) is not null
       and not exists (
             select 1 from community_school_reminders m
              where m.community_id    = c.id
                and m.stage           = community_school_reminder_stage(c.id)
                and m.term_expires_at = c.school_expires_at)
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;

grant execute on function school_terms_due_reminders() to service_role;


-- ── 4. Recording that it went out ───────────────────────────────────
--
-- Called by the edge function AFTER Resend accepts the message, one
-- school at a time. On conflict it does nothing and reports false, so
-- two overlapping runs cannot both mail the same school: the second
-- insert loses the race and its caller knows not to send.
--
-- Marking after sending rather than before means a crash between the
-- two re-sends tomorrow. That is the right way round — a duplicate
-- reminder is a minor annoyance, a silently skipped one is the whole
-- failure this file exists to prevent.

create or replace function school_reminder_mark(
  p_community_id   uuid,
  p_stage          text,
  p_term_expires_at timestamptz,
  p_sent_to        text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  insert into community_school_reminders
    (community_id, stage, term_expires_at, sent_to)
  values (p_community_id, p_stage, p_term_expires_at, p_sent_to)
  on conflict (community_id, stage, term_expires_at) do nothing;
  return found;
end;
$$;

grant execute on function school_reminder_mark(uuid, text, timestamptz, text) to service_role;


commit;


-- ════════════════════════════════════════════════════════════════════
--  THE SCHEDULE
--
--  Run this part only once the edge function is deployed — a job that
--  posts to a function that does not exist gets back 200 and an empty
--  body, which looks exactly like "nothing to send".
--
--    npx supabase@latest functions deploy school-term-reminders \
--        --project-ref lsamggztfizmkyljdgwq
--
--  13:00 UTC, an hour after the feedback digest, so the two are not
--  competing for the same minute and a failure in the logs is
--  attributable to one of them.
--
--  Needs the same vault secret the feedback digest needs. If
--  `select name from vault.secrets` already lists service_role_key,
--  there is nothing more to do.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('school-term-reminders') where exists (
  select 1 from cron.job where jobname = 'school-term-reminders'
);

select cron.schedule(
  'school-term-reminders',
  '0 13 * * *',
  $$
    select net.http_post(
      url     := 'https://lsamggztfizmkyljdgwq.supabase.co/functions/v1/school-term-reminders',
      body    := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      )
    );
  $$
);
