-- Behaviour tests for setup-home-reminders.sql.
-- Needs the chain in home-trial-grace.test.sql's header, then
-- setup-home-trial-no-grace.sql, fix-school-reminder-grants.sql and
-- setup-home-reminders.sql.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

do $$
declare
  u1 uuid := 'e3000000-0000-0000-0000-0000000000a1'; u2 uuid := 'e3000000-0000-0000-0000-0000000000a2';
  u3 uuid := 'e3000000-0000-0000-0000-0000000000a3'; u4 uuid := 'e3000000-0000-0000-0000-0000000000a4';
  u5 uuid := 'e3000000-0000-0000-0000-0000000000a5'; hd uuid := 'e3000000-0000-0000-0000-0000000000a6';
  soon uuid; ended uuid; old uuid; early uuid; paid uuid; school uuid; due json;
  stage_of text;
begin
  insert into auth.users (id, email) values (u1,'a@r.example'),(u2,'b@r.example'),(u3,'c@r.example'),(u4,'d@r.example'),(u5,'e@r.example'),(hd,'h@r.example') on conflict do nothing;
  perform set_config('test.uid', u1::text, true); soon  := (home_classroom_start('Soon')->>'community_id')::uuid;
  perform set_config('test.uid', u2::text, true); ended := (home_classroom_start('Ended')->>'community_id')::uuid;
  perform set_config('test.uid', u3::text, true); old   := (home_classroom_start('Old')->>'community_id')::uuid;
  perform set_config('test.uid', u4::text, true); early := (home_classroom_start('Early')->>'community_id')::uuid;
  perform set_config('test.uid', u5::text, true); paid  := (home_classroom_start('Paid')->>'community_id')::uuid;
  insert into community_unlock_codes (code, product, school_months, classroom_limit, for_home, customer_email, source)
    values ('BWH-RRRR-SSSS-TTTT', 'school', 12, 4, true, 'e@r.example', 'manual');
  perform community_apply_school_code('BWH-RRRR-SSSS-TTTT', paid);
  update communities set school_expires_at = now() + interval '1 day'  where id = soon;
  update communities set school_expires_at = now() - interval '3 days' where id = ended;
  update communities set school_expires_at = now() - interval '20 days' where id = old;
  update communities set school_expires_at = now() + interval '5 days' where id = early;
  update communities set school_expires_at = now() + interval '5 days' where id = paid;
  insert into communities (slug, name, kind, owner_user_id, school_expires_at, tier, feeder_limit)
    values ('rem-school', 'Rem School', 'school', hd, now() + interval '5 days', 'large', 100) returning id into school;

  perform t_ok('A1 a trial with a day left: trial_t2', home_reminder_stage(soon) = 'trial_t2');
  perform t_ok('A2 a trial that ended 3 days ago: trial_ended', home_reminder_stage(ended) = 'trial_ended');
  perform t_ok('A3 a trial that ended 20 days ago: nothing', home_reminder_stage(old) is null);
  perform t_ok('A4 a trial with 5 days left: nothing yet', home_reminder_stage(early) is null);
  perform t_ok('A5 a paying family a week from renewal: t7, like a school', home_reminder_stage(paid) = 't7');
  perform t_ok('A6 a school is not a home', home_reminder_stage(school) is null);

  due := home_terms_due_reminders();
  perform t_ok('B1 due: the three that need mail, with the owner''s address',
               json_array_length(due) = 3
               and exists (select 1 from json_array_elements(due) r where (r->>'community_id')::uuid = soon and r->>'owner_email' = 'a@r.example'));
  perform school_reminder_mark(soon, 'trial_t2', (select school_expires_at from communities where id = soon), 'a@r.example');
  perform t_ok('B2 once sent, not again', json_array_length(home_terms_due_reminders()) = 2);
  perform t_ok('B3 the school list still has only the school',
               (select bool_and((r->>'community_id')::uuid = school) from json_array_elements(school_terms_due_reminders()) r));
end $$;

-- Grants: the reminder functions are the server's alone.
select t_ok('C1 not callable by signed-in users',
  not has_function_privilege('authenticated', 'home_terms_due_reminders()', 'execute')
  and not has_function_privilege('anon', 'home_reminder_stage(uuid)', 'execute')
  and has_function_privilege('service_role', 'home_terms_due_reminders()', 'execute'));
