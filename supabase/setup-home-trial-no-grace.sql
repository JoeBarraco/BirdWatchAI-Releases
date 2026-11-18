-- ============================================================
-- BirdWatchAI Home Classroom — no grace month on a free trial
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-home-classroom.sql.
--
-- WHY (decided 2026-11-18)
-- A school whose term ends keeps starting lessons for a grace period
-- (community_school_grace(), 30 days), so a late purchase order does not
-- stop a class mid-week. A Home Classroom trial inherited that, which made
-- a "30-day free trial" really sixty days. Decision: no grace for home
-- trials. A trial stops starting lessons the day it ends.
--
-- WHAT COUNTS AS A TRIAL
-- A Home Classroom that no code has ever been applied to. Once a family
-- has paid (a redeemed code points at the community), it gets the same
-- grace as a school when that paid year runs out: they are a customer
-- whose renewal is late, not a trial that ended.
--
-- WHAT CHANGES
--   community_school_grace_for(id)  the grace for one community: zero
--                                   for a home trial, the school grace
--                                   otherwise
--   community_school_active         \
--   community_school_state           > use it instead of the flat grace
--   community_school_status         /  (grace_ends_at too)
--   school_terms_due_reminders      leaves Home Classrooms out: its
--                                   emails are about a school's term
-- Nothing else reads the grace (checked against production's functions).
-- ============================================================

begin;

create or replace function community_school_grace_for(p_community_id uuid)
returns interval
language sql stable security definer
set search_path to 'public'
as $$
  select case
    when c.is_home and not exists (
           select 1 from community_unlock_codes u
            where u.community_id = c.id and u.redeemed_at is not null)
      then interval '0'
    else community_school_grace()
  end
  from communities c where c.id = p_community_id;
$$;
revoke execute on function community_school_grace_for(uuid) from public, anon, authenticated;

create or replace function community_school_active(p_community_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select coalesce((
    select c.kind = 'school'
       and (c.school_perpetual
            or (c.school_expires_at is not null
                and now() < c.school_expires_at + community_school_grace_for(c.id)))
      from communities c
     where c.id = p_community_id
  ), false);
$$;

create or replace function community_school_state(p_community_id uuid)
returns text
language sql stable security definer
set search_path to 'public'
as $$
  select case
    when c.kind <> 'school'                              then 'not_school'
    when c.school_perpetual                              then 'perpetual'
    when c.school_expires_at is null                     then 'lapsed'
    when now() < c.school_expires_at                     then 'active'
    when now() < c.school_expires_at
                 + community_school_grace_for(c.id)      then 'grace'
    else                                                      'lapsed'
  end
  from communities c where c.id = p_community_id;
$$;

CREATE OR REPLACE FUNCTION public.community_school_status(p_community_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  c  communities%rowtype;
  st text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  select * into c from communities where id = p_community_id;
  if c.id is null then
    raise exception 'Community not found';
  end if;

  st := community_school_state(p_community_id);

  return json_build_object(
    'community_id', c.id,
    'kind',         c.kind,
    'state',        st,
    'perpetual',    c.school_perpetual,
    'expires_at',   c.school_expires_at,
    'grace_ends_at', case
                       when c.school_expires_at is null then null
                       else c.school_expires_at + community_school_grace_for(c.id)
                     end,
    'days_left',    case
                      when c.school_perpetual or c.school_expires_at is null
                        then null
                      else floor(extract(epoch from
                             (c.school_expires_at - now())) / 86400)::int
                    end,
    'can_start',    st in ('perpetual', 'active', 'grace'),
    'classrooms',   community_classroom_usage(p_community_id),
    'is_owner',     c.owner_user_id = auth.uid());
end;
$$;

CREATE OR REPLACE FUNCTION public.school_terms_due_reminders()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
       -- Home Classrooms are not schools: these emails talk about "your
       -- school's subscription" and its classes. See setup-home-trial-no-grace.sql.
       and not c.is_home
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

commit;
