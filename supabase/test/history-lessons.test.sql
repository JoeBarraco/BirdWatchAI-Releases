-- Behaviour tests for setup-classroom-history-lessons.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql AND
-- setup-classroom-history-lessons.sql.
--
-- The point of the migration is that the LIMIT should count lessons, not
-- sessions. A class with a habit of abandoned boards was spending its fifty
-- rows on them and losing real lessons off the end of its history with
-- nothing saying so, which is why section C seeds more empties than the
-- limit and checks the lessons survive.

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

do $$
declare
  owner_id uuid := 'f0000000-0000-0000-0000-000000000001';
  other_id uuid := 'f0000000-0000-0000-0000-000000000002';
  cid      uuid;
  room     uuid;
  sid      uuid;
  res      json;
begin
  insert into auth.users (id, email) values
    (owner_id,'head@h.example'), (other_id,'nobody@h.example')
  on conflict (id) do nothing;

  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('hist-school','History School','school',owner_id, now() + interval '6 months')
    returning id into cid;
  insert into community_members (community_id, user_id, role)
    values (cid, owner_id, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room A','k-2',owner_id) returning id into room;

  perform set_config('test.uid', owner_id::text, false);

  raise notice '';
  raise notice '── A. Nothing at all ──';
  res := classroom_session_history(room, 50);
  -- ? is a jsonb operator; json has no such thing. Same family of trap as
  -- json having no equality operator, which cost this project a migration
  -- once already.
  perform t_ok('the new shape is an object with both keys',
    (res::jsonb) ? 'lessons' and (res::jsonb) ? 'empty_count');
  perform t_ok('no lessons', json_array_length(res->'lessons') = 0);
  perform t_ok('no empties either', (res->>'empty_count')::int = 0);

  raise notice '';
  raise notice '── B. Two lessons, three abandoned boards ──';
  for i in 1..2 loop
    insert into classroom_sessions (classroom_id, started_by, started_at)
      values (room, owner_id, now() - (i || ' hours')::interval) returning id into sid;
    insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
      values (sid, 't', 'counting', 'k-2', 'q', true);
  end loop;
  for i in 1..3 loop
    insert into classroom_sessions (classroom_id, started_by, started_at)
      values (room, owner_id, now() - (i || ' days')::interval);
  end loop;

  res := classroom_session_history(room, 50);
  perform t_ok('only the two lessons come back',
    json_array_length(res->'lessons') = 2);
  perform t_ok('the three abandoned boards are counted, not listed',
    (res->>'empty_count')::int = 3);
  perform t_ok('every row returned has questions in it',
    not exists (select 1 from json_array_elements(res->'lessons') e
                 where json_array_length(e->'questions') = 0));

  raise notice '';
  raise notice '── C. The limit counts LESSONS ──';
  -- 60 abandoned boards, newer than every real lesson. Before this
  -- migration they would have filled the window and pushed both lessons out.
  for i in 1..60 loop
    insert into classroom_sessions (classroom_id, started_by, started_at)
      values (room, owner_id, now() - (i || ' minutes')::interval);
  end loop;

  res := classroom_session_history(room, 50);
  perform t_ok('the two lessons survive 60 newer abandoned boards',
    json_array_length(res->'lessons') = 2);
  perform t_ok('and all 63 empties are counted',
    (res->>'empty_count')::int = 63);

  raise notice '';
  raise notice '── D. The limit still applies to real lessons ──';
  for i in 1..70 loop
    insert into classroom_sessions (classroom_id, started_by, started_at)
      values (room, owner_id, now() - (i || ' seconds')::interval) returning id into sid;
    insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
      values (sid, 't', 'counting', 'k-2', 'q', true);
  end loop;
  perform t_ok('capped at 50',
    json_array_length(classroom_session_history(room, 50)->'lessons') = 50);
  perform t_ok('a smaller limit is honoured',
    json_array_length(classroom_session_history(room, 5)->'lessons') = 5);
  perform t_ok('an absurd limit is clamped, not obeyed',
    json_array_length(classroom_session_history(room, 9999)->'lessons') = 50);

  raise notice '';
  raise notice '── E. Still only people who may manage the class ──';
  perform set_config('test.uid', other_id::text, false);
  perform t_raises('a stranger is refused',
    format('select classroom_session_history(%L, 10)', room));
end $$;
