-- Behaviour tests for setup-school-reminders.sql.
-- Needs stub-schema.sql, setup-school-subscription.sql and this file's
-- migration already applied. Reuses t_ok/t_raises/t_runs from
-- school-subscription.test.sql, and defines them if run alone.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

do $$
declare
  owner_id uuid := '33333333-3333-3333-3333-333333333333';
  far      uuid;
  t30      uuid;
  t7       uuid;
  gone     uuid;
  dead     uuid;
  perp     uuid;
  plain    uuid;
  due      json;
  n        int;
  marked   boolean;
  new_exp  timestamptz;
begin
  insert into auth.users (id, email) values (owner_id, 'head@example.com')
    on conflict (id) do nothing;
  insert into user_profiles (id, display_name) values (owner_id, 'Head Teacher')
    on conflict (id) do nothing;

  -- One community per stage, so every boundary is exercised at once.
  insert into communities (slug, name, kind, owner_user_id, school_expires_at) values
    ('r-far',  'Far School',     'school', owner_id, now() + interval '60 days'),
    ('r-t30',  'Thirty School',  'school', owner_id, now() + interval '25 days'),
    ('r-t7',   'Seven School',   'school', owner_id, now() + interval '5 days'),
    ('r-gone', 'Expired School', 'school', owner_id, now() - interval '3 days'),
    ('r-dead', 'Stopped School', 'school', owner_id, now() - interval '40 days'),
    ('r-plain','Birding Group',  'general',owner_id, null);
  insert into communities (slug, name, kind, owner_user_id, school_perpetual)
    values ('r-perp', 'Comped School', 'school', owner_id, true);

  select id into far   from communities where slug = 'r-far';
  select id into t30   from communities where slug = 'r-t30';
  select id into t7    from communities where slug = 'r-t7';
  select id into gone  from communities where slug = 'r-gone';
  select id into dead  from communities where slug = 'r-dead';
  select id into perp  from communities where slug = 'r-perp';
  select id into plain from communities where slug = 'r-plain';

  insert into community_members (community_id, user_id, role)
    select id, owner_id, 'owner' from communities where slug like 'r-%';

  raise notice '';
  raise notice '── A. Which stage is each term in ──';
  perform t_ok('60 days out: nothing to say',
    community_school_reminder_stage(far) is null);
  perform t_ok('25 days out: t30',
    community_school_reminder_stage(t30) = 't30');
  perform t_ok('5 days out: t7',
    community_school_reminder_stage(t7) = 't7');
  perform t_ok('3 days past expiry: expired',
    community_school_reminder_stage(gone) = 'expired');
  perform t_ok('40 days past expiry (grace over): stopped',
    community_school_reminder_stage(dead) = 'stopped');
  perform t_ok('perpetual school: never',
    community_school_reminder_stage(perp) is null);
  perform t_ok('non-school: never',
    community_school_reminder_stage(plain) is null);

  raise notice '';
  raise notice '── B. The stages agree with the gate ──';
  -- The thing that must never drift: a term the gate still allows must not
  -- be described as stopped, and one the gate blocks must not read as live.
  perform t_ok('expired term still starts lessons (grace)',
    community_school_active(gone));
  perform t_ok('stopped term does not',
    not community_school_active(dead));
  perform t_ok('t7 term is active', community_school_active(t7));
  perform t_ok('state and reminder stage agree on grace',
    community_school_state(gone) = 'grace'
      and community_school_reminder_stage(gone) = 'expired');
  perform t_ok('state and reminder stage agree on lapsed',
    community_school_state(dead) = 'lapsed'
      and community_school_reminder_stage(dead) = 'stopped');

  raise notice '';
  raise notice '── C. The due list ──';
  due := school_terms_due_reminders();
  select count(*) into n from json_array_elements(due);
  perform t_ok('four schools are due, not seven', n = 4);
  perform t_ok('the 60-day school is not in it',
    not exists (select 1 from json_array_elements(due) e
                 where e->>'slug' = 'r-far'));
  perform t_ok('the perpetual school is not in it',
    not exists (select 1 from json_array_elements(due) e
                 where e->>'slug' = 'r-perp'));
  perform t_ok('the birding group is not in it',
    not exists (select 1 from json_array_elements(due) e
                 where e->>'slug' = 'r-plain'));
  perform t_ok('owner email came through',
    (select e->>'owner_email' from json_array_elements(due) e
      where e->>'slug' = 'r-t7') = 'head@example.com');
  perform t_ok('owner name came through',
    (select e->>'owner_name' from json_array_elements(due) e
      where e->>'slug' = 'r-t7') = 'Head Teacher');
  perform t_ok('days_left is positive before expiry',
    (select (e->>'days_left')::int from json_array_elements(due) e
      where e->>'slug' = 'r-t7') between 4 and 5);
  perform t_ok('grace_ends_at is 30 days past expiry',
    (select (e->>'grace_ends_at')::timestamptz - (e->>'expires_at')::timestamptz
       from json_array_elements(due) e where e->>'slug' = 'r-gone')
     = interval '30 days');

  raise notice '';
  raise notice '── D. Mailed once, not every morning ──';
  marked := school_reminder_mark(t7, 't7',
             (select school_expires_at from communities where id = t7),
             'head@example.com');
  perform t_ok('first mark wins', marked);
  marked := school_reminder_mark(t7, 't7',
             (select school_expires_at from communities where id = t7),
             'head@example.com');
  perform t_ok('second mark loses (no duplicate email)', not marked);

  due := school_terms_due_reminders();
  select count(*) into n from json_array_elements(due);
  perform t_ok('the marked school drops off the due list', n = 3);
  perform t_ok('…and it is specifically the right one',
    not exists (select 1 from json_array_elements(due) e
                 where e->>'slug' = 'r-t7'));

  raise notice '';
  raise notice '── E. A later stage of the same term still fires ──';
  -- Being told at 7 days must not suppress being told when it stops.
  update communities set school_expires_at = now() - interval '40 days'
   where id = t7;
  perform t_ok('now reads as stopped',
    community_school_reminder_stage(t7) = 'stopped');
  -- The term date changed, so this is a different term as far as the
  -- marker is concerned; either way it must be due again.
  due := school_terms_due_reminders();
  perform t_ok('it is due again at the new stage',
    exists (select 1 from json_array_elements(due) e
             where e->>'slug' = 'r-t7' and e->>'stage' = 'stopped'));

  raise notice '';
  raise notice '── F. Renewing re-arms next year ──';
  --
  -- ⚠ now() is the TRANSACTION timestamp, and this whole block is one
  -- transaction, so every now() below is the same instant. Writing
  -- "now() + interval '25 days'" again further down would reproduce the
  -- seeded expiry EXACTLY, which is the same term and correctly stays
  -- suppressed — it reads like next year and is not. The renewed term is
  -- therefore given a visibly different date.
  perform school_reminder_mark(t30, 't30',
            (select school_expires_at from communities where id = t30), 'x@y.z');
  due := school_terms_due_reminders();
  perform t_ok('this year is quiet once mailed',
    not exists (select 1 from json_array_elements(due) e
                 where e->>'slug' = 'r-t30'));

  update communities
     set school_expires_at = school_expires_at + interval '12 months'
   where id = t30;
  perform t_ok('a renewed term says nothing yet',
    community_school_reminder_stage(t30) is null);

  -- A year on: inside the t30 window again, but a different term date.
  new_exp := now() + interval '20 days';
  update communities set school_expires_at = new_exp where id = t30;
  perform t_ok('the renewed term is a different date',
    new_exp <> (select m.term_expires_at from community_school_reminders m
                 where m.community_id = t30 and m.stage = 't30'));
  due := school_terms_due_reminders();
  perform t_ok('next year''s t30 is NOT suppressed by this year''s',
    exists (select 1 from json_array_elements(due) e
             where e->>'slug' = 'r-t30' and e->>'stage' = 't30'));

  raise notice '';
  raise notice '── G. Boundaries ──';
  update communities set school_expires_at = now() + interval '30 days' - interval '1 minute'
   where id = far;
  perform t_ok('just inside 30 days: t30',
    community_school_reminder_stage(far) = 't30');
  update communities set school_expires_at = now() + interval '30 days' + interval '1 minute'
   where id = far;
  perform t_ok('just outside 30 days: nothing',
    community_school_reminder_stage(far) is null);
  update communities set school_expires_at = now() + interval '7 days' - interval '1 minute'
   where id = far;
  perform t_ok('just inside 7 days: t7',
    community_school_reminder_stage(far) = 't7');
  update communities set school_expires_at = now() + interval '1 minute'
   where id = far;
  perform t_ok('a minute before expiry: still t7',
    community_school_reminder_stage(far) = 't7');
  update communities set school_expires_at = now() - interval '1 minute'
   where id = far;
  perform t_ok('a minute after expiry: expired',
    community_school_reminder_stage(far) = 'expired');
  update communities set school_expires_at = now() - interval '30 days' + interval '1 minute'
   where id = far;
  perform t_ok('a minute before grace ends: still expired',
    community_school_reminder_stage(far) = 'expired');
  update communities set school_expires_at = now() - interval '30 days' - interval '1 minute'
   where id = far;
  perform t_ok('a minute after grace ends: stopped',
    community_school_reminder_stage(far) = 'stopped');
end $$;
