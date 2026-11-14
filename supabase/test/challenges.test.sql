-- Behaviour tests for setup-classroom-challenges.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql AND
-- setup-classroom-challenges.sql applied. The subscription one is not
-- optional: its trigger refuses to create a classroom in a school with no
-- live term, so this suite gives its community one. Run without it and the
-- seed fails on a missing school_expires_at column.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

create or replace function t_raises(label text, sql text) returns void
language plpgsql as $$
begin
  execute sql;
  raise notice 'FAIL *** % (expected an error, got none)', label;
exception when others then
  raise notice 'PASS % [%]', label, left(sqlerrm, 56);
end $$;

create or replace function t_runs(label text, sql text) returns void
language plpgsql as $$
begin
  execute sql;
  raise notice 'PASS %', label;
exception when others then
  raise notice 'FAIL *** % [%]', label, left(sqlerrm, 80);
end $$;

do $$
declare
  owner_id uuid := 'c0000000-0000-0000-0000-000000000001';
  mod_id   uuid := 'c0000000-0000-0000-0000-000000000002';
  t1_id    uuid := 'c0000000-0000-0000-0000-000000000003';
  view_id  uuid := 'c0000000-0000-0000-0000-000000000004';
  cid      uuid;
  rA uuid; rB uuid; rC uuid; rD uuid;
  ch       uuid;
  st       json;
  row_a    json;
begin
  insert into auth.users (id, email) values
    (owner_id,'head@s.example'), (mod_id,'dep@s.example'),
    (t1_id,'tina@s.example'),    (view_id,'parent@s.example')
  on conflict (id) do nothing;
  insert into user_profiles (id, display_name) values
    (t1_id, 'Tina Teacher'), (mod_id, 'Deputy')
  on conflict (id) do nothing;

  -- A paid-up school. Without a live term the trigger from
  -- setup-school-subscription.sql refuses to create any classroom at all,
  -- which is correct behaviour and would otherwise fail this suite for a
  -- reason that has nothing to do with challenges.
  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('chal-school','Challenge School','school',owner_id, now() + interval '6 months')
    returning id into cid;
  insert into community_members (community_id, user_id, role) values
    (cid, owner_id,'owner'), (cid, mod_id,'moderator'),
    (cid, t1_id,'teacher'),  (cid, view_id,'viewer');

  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room A','k-2',t1_id) returning id into rA;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room B','3-5',t1_id) returning id into rB;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room C','6-8',null)  returning id into rC;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room D','k-2',null)  returning id into rD;

  raise notice '';
  raise notice '── A. Who may create one ──';
  perform set_config('test.uid', t1_id::text, false);
  perform t_raises('a teacher cannot create a challenge',
    format('select classroom_challenge_create(%L, ''Week 1'', current_date, current_date + 4)', cid));
  perform set_config('test.uid', view_id::text, false);
  perform t_raises('a viewer cannot either',
    format('select classroom_challenge_create(%L, ''Week 1'', current_date, current_date + 4)', cid));

  perform set_config('test.uid', mod_id::text, false);
  perform t_raises('an empty name is refused',
    format('select classroom_challenge_create(%L, ''   '', current_date, current_date + 4)', cid));
  perform t_raises('ending before starting is refused',
    format('select classroom_challenge_create(%L, ''Backwards'', current_date, current_date - 1)', cid));
  perform t_raises('a window longer than six months is refused',
    format('select classroom_challenge_create(%L, ''Forever'', current_date, current_date + 400)', cid));

  select (classroom_challenge_create(cid, 'Bird Week', current_date - 2, current_date + 2)->>'id')::uuid
    into ch;
  perform t_ok('a moderator can create one', ch is not null);

  raise notice '';
  raise notice '── B. Lessons inside and outside the window ──';
  -- Room A: 3 answered in window, 2 right.
  insert into classroom_sessions (id, classroom_id, started_by, started_at)
    values (gen_random_uuid(), rA, t1_id, now());
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
    select id, 't','counting','k-2','q', v from classroom_sessions s,
      (values (true),(true),(false)) as x(v) where s.classroom_id = rA;

  -- Room B: 4 answered in window, 4 right -> should lead.
  insert into classroom_sessions (id, classroom_id, started_by, started_at)
    values (gen_random_uuid(), rB, t1_id, now() - interval '1 day');
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
    select s.id, 't','counting','3-5','q', true from classroom_sessions s,
      generate_series(1,4) where s.classroom_id = rB;

  -- Room C: a lesson OUTSIDE the window.
  insert into classroom_sessions (id, classroom_id, started_by, started_at)
    values (gen_random_uuid(), rC, null, now() - interval '30 days');
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
    select s.id, 't','counting','6-8','q', true from classroom_sessions s,
      generate_series(1,5) where s.classroom_id = rC;

  -- Room D: in the window but every question still pending.
  insert into classroom_sessions (id, classroom_id, started_by, started_at)
    values (gen_random_uuid(), rD, null, now());
  insert into classroom_session_answers
      (session_id, template_id, category, grade_band, prompt, is_correct, pending_check)
    select s.id, 't','prediction','k-2','q', null, '{"k":1}'::jsonb
      from classroom_sessions s, generate_series(1,3) where s.classroom_id = rD;

  st := classroom_challenge_standings(ch);
  perform t_ok('two classrooms on the board, not four',
    (select count(*) from json_array_elements(st->'standings')) = 2);
  perform t_ok('the out-of-window class is absent',
    not exists (select 1 from json_array_elements(st->'standings') e where e->>'name' = 'Room C'));
  perform t_ok('the all-pending class is absent, not shown on zero',
    not exists (select 1 from json_array_elements(st->'standings') e where e->>'name' = 'Room D'));

  select e into row_a from json_array_elements(st->'standings') e where e->>'name' = 'Room A';
  perform t_ok('Room A: 3 answered, 2 correct, 67%',
    (row_a->>'answered')::int = 3 and (row_a->>'correct')::int = 2 and (row_a->>'pct')::int = 67);
  perform t_ok('Room A carries its band and teacher',
    row_a->>'grade_band' = 'k-2' and row_a->>'teacher_label' = 'Tina Teacher');

  perform t_ok('the board is ordered best first',
    (select (json_array_elements(st->'standings')->>'name') limit 1) = 'Room B');

  raise notice '';
  raise notice '── B2. An abandoned session is not a lesson ──';
  -- The board went up and nothing was asked. Room A should still read 1.
  insert into classroom_sessions (classroom_id, started_by, started_at)
    values (rA, t1_id, now());
  insert into classroom_sessions (classroom_id, started_by, started_at)
    values (rA, t1_id, now());
  st := classroom_challenge_standings(ch);
  select e into row_a from json_array_elements(st->'standings') e where e->>'name' = 'Room A';
  perform t_ok('two abandoned sessions do not become two lessons',
    (row_a->>'lessons')::int = 1);
  perform t_ok('…and the score is unchanged',
    (row_a->>'answered')::int = 3 and (row_a->>'pct')::int = 67);

  raise notice '';
  raise notice '── C. Pending never counts against a class ──';
  -- Give Room D one settled right answer; it should now appear on 100%.
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
    select s.id,'t','counting','k-2','q', true from classroom_sessions s where s.classroom_id = rD;
  st := classroom_challenge_standings(ch);
  select e into row_a from json_array_elements(st->'standings') e where e->>'name' = 'Room D';
  perform t_ok('Room D now appears', row_a is not null);
  perform t_ok('…on 100%, with the three pending counted separately',
    (row_a->>'pct')::int = 100 and (row_a->>'answered')::int = 1 and (row_a->>'waiting')::int = 3);

  raise notice '';
  raise notice '── D. Reading it ──';
  perform set_config('test.uid', t1_id::text, false);
  perform t_ok('a teacher can read the standings',
    (classroom_challenge_standings(ch)->'standings') is not null);
  perform t_ok('a teacher sees can_manage false',
    (classroom_challenge_list(cid)->>'can_manage')::boolean = false);
  perform set_config('test.uid', mod_id::text, false);
  perform t_ok('a moderator sees can_manage true',
    (classroom_challenge_list(cid)->>'can_manage')::boolean);
  perform t_ok('the challenge reads as current',
    (select (e->>'is_current')::boolean from json_array_elements(classroom_challenge_list(cid)->'items') e limit 1));

  perform set_config('test.uid', view_id::text, false);
  perform t_raises('a viewer cannot read the list',
    format('select classroom_challenge_list(%L)', cid));

  raise notice '';
  raise notice '── E. Deleting removes the window, not the lessons ──';
  perform set_config('test.uid', t1_id::text, false);
  perform t_raises('a teacher cannot delete a challenge',
    format('select classroom_challenge_delete(%L)', ch));
  perform set_config('test.uid', mod_id::text, false);
  perform t_runs('a moderator can',
    format('select classroom_challenge_delete(%L)', ch));
  perform t_ok('the lessons are untouched',
    (select count(*) from classroom_session_answers a
       join classroom_sessions s on s.id = a.session_id
       join classrooms r on r.id = s.classroom_id
      where r.community_id = cid) > 0);
end $$;
