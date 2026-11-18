-- Behaviour tests for setup-home-trial-no-grace.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-school-purchase.sql, setup-school-classroom-limits.sql, the
-- reminders schema (setup-school-reminders.sql up to its commit; see the
-- README), setup-home-classroom.sql, then setup-home-trial-no-grace.sql.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

do $$
declare
  mom  uuid := 'e1000000-0000-0000-0000-0000000000a1';
  dad  uuid := 'e1000000-0000-0000-0000-0000000000a2';
  head uuid := 'e1000000-0000-0000-0000-0000000000a3';
  trial uuid; paid uuid; school uuid; st json;
begin
  insert into auth.users (id, email) values (mom, 'mom@g.example'), (dad, 'dad@g.example'), (head, 'head@g.example')
  on conflict do nothing;

  -- A trial that ended yesterday.
  perform set_config('test.uid', mom::text, true);
  trial := (home_classroom_start('Trial family')->>'community_id')::uuid;
  update communities set school_expires_at = now() - interval '1 day' where id = trial;
  perform t_ok('A1 a home trial that has ended is lapsed at once, no grace', community_school_state(trial) = 'lapsed');
  perform t_ok('A2 and cannot start a lesson', not community_school_active(trial));
  st := community_school_status(trial);
  perform t_ok('A3 status agrees: cannot start, grace ends when the trial did',
               not (st->>'can_start')::boolean and (st->>'grace_ends_at')::timestamptz = (st->>'expires_at')::timestamptz);
  update communities set school_expires_at = now() + interval '3 days' where id = trial;
  perform t_ok('A4 a running trial is active as before', community_school_state(trial) = 'active' and community_school_active(trial));

  -- A family that paid, whose year ended yesterday.
  perform set_config('test.uid', dad::text, true);
  paid := (home_classroom_start('Paid family')->>'community_id')::uuid;
  insert into community_unlock_codes (code, product, school_months, classroom_limit, for_home, customer_email, source)
    values ('BWH-GGGG-HHHH-JJJJ', 'school', 12, 4, true, 'dad@g.example', 'manual');
  perform community_apply_school_code('BWH-GGGG-HHHH-JJJJ', paid);
  update communities set school_expires_at = now() - interval '1 day' where id = paid;
  perform t_ok('B1 a paid Home Classroom gets the grace like a school', community_school_state(paid) = 'grace' and community_school_active(paid));

  -- A school, unchanged.
  insert into communities (slug, name, kind, owner_user_id, school_expires_at, tier, feeder_limit)
    values ('grace-school', 'Grace School', 'school', head, now() - interval '1 day', 'large', 100) returning id into school;
  perform t_ok('C1 a school still gets its grace', community_school_state(school) = 'grace' and community_school_active(school));
  update communities set school_expires_at = now() - interval '31 days' where id = school;
  perform t_ok('C2 and still lapses after it', community_school_state(school) = 'lapsed');

  -- Reminders: schools yes, homes no.
  update communities set school_expires_at = now() + interval '5 days' where id in (trial, paid, school);
  perform t_ok('D1 school renewal emails leave Home Classrooms out',
               coalesce((select bool_and((r->>'community_id')::uuid not in (trial, paid))
                           from json_array_elements(school_terms_due_reminders()) r), true)
               and exists (select 1 from json_array_elements(school_terms_due_reminders()) r
                            where (r->>'community_id')::uuid = school));
end $$;
