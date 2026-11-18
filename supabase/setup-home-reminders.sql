-- ============================================================
-- BirdWatchAI Home Classroom — reminder emails for families
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-school-reminders.sql, setup-home-classroom.sql,
-- setup-home-trial-no-grace.sql and fix-school-reminder-grants.sql.
-- Then deploy the school-term-reminders edge function, which sends them;
-- it runs on the schools' existing daily schedule, so there is no new cron.
--
-- WHY (2026-11-18)
-- School renewal mail leaves Home Classrooms out (it talks about a school's
-- term and its classes; setup-home-trial-no-grace.sql). Families got
-- nothing at all, and a 7-day trial that ends without a word loses most of
-- the people it was meant to convert.
--
-- STAGES, ONE EMAIL EACH, ONLY THE CURRENT ONE (as for schools)
-- A trial (no code ever applied):
--   trial_t2      2 days or fewer left of the free week
--   trial_ended   the free week has ended (no grace for trials); sent only
--                 in the 14 days after, so an old lapsed trial is not mailed
--                 out of the blue when this first runs
-- A paying family: the school stages, worked out by the same function the
-- schools use (community_school_reminder_stage), because a paid Home
-- Classroom gets the school grace:
--   t30, t7, expired, stopped
--
-- Marked with school_reminder_mark in the same table, so a run that
-- crashes re-sends rather than skips, and two runs cannot both send.
-- Callable by the service role only.
-- ============================================================

begin;

alter table community_school_reminders drop constraint if exists community_school_reminders_stage_check;
alter table community_school_reminders add constraint community_school_reminders_stage_check
  check (stage in ('t30', 't7', 'expired', 'stopped', 'trial_t2', 'trial_ended'));

create or replace function home_reminder_stage(p_community_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select case
    when not c.is_home or c.school_perpetual or c.school_expires_at is null then null
    when not exists (select 1 from community_unlock_codes u
                      where u.community_id = c.id and u.redeemed_at is not null) then
      case
        when now() >= c.school_expires_at + interval '14 days'  then null
        when now() >= c.school_expires_at                       then 'trial_ended'
        when now() >= c.school_expires_at - interval '2 days'   then 'trial_t2'
        else null
      end
    else community_school_reminder_stage(c.id)
  end
  from communities c where c.id = p_community_id;
$$;

create or replace function home_terms_due_reminders()
returns json
language plpgsql security definer set search_path = public as $$
declare
  result json;
begin
  select json_agg(row_to_json(t) order by t.expires_at) into result
  from (
    select c.id                                         as community_id,
           c.slug,
           c.name,
           c.school_expires_at                          as expires_at,
           c.school_expires_at + community_school_grace_for(c.id) as grace_ends_at,
           home_reminder_stage(c.id)                    as stage,
           floor(extract(epoch from (c.school_expires_at - now())) / 86400)::int as days_left,
           u.email                                      as owner_email,
           coalesce(nullif(p.display_name, ''), '')     as owner_name,
           (select count(*) from classrooms r
             where r.community_id = c.id and r.archived_at is null) as child_count
      from communities c
      left join auth.users    u on u.id = c.owner_user_id
      left join user_profiles p on p.id = c.owner_user_id
     where c.is_home
       and home_reminder_stage(c.id) is not null
       and not exists (
             select 1 from community_school_reminders m
              where m.community_id    = c.id
                and m.stage           = home_reminder_stage(c.id)
                and m.term_expires_at = c.school_expires_at)
  ) t;
  return coalesce(result, '[]'::json);
end;
$$;

revoke execute on function home_reminder_stage(uuid)      from public, anon, authenticated;
revoke execute on function home_terms_due_reminders()     from public, anon, authenticated;
grant  execute on function home_reminder_stage(uuid)      to service_role;
grant  execute on function home_terms_due_reminders()     to service_role;

commit;
