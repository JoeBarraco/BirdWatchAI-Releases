-- Behaviour tests for setup-classroom-history-standards.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-classroom-history-lessons.sql AND
-- setup-classroom-history-standards.sql, applied in that order — the last
-- two define the same function, and applying them the other way round
-- would leave the OLD body installed with the tests passing for section 0
-- and failing for the one that matters.
--
-- What this is really guarding is a silent emptiness. The standards block
-- under each lesson is keyed by template_id; if the field is missing the
-- block renders with nothing in it and every question looks unaligned.
-- That is worse than the feature being absent, because it reads as a
-- finding rather than as a bug.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;


do $$
declare
  owner_id uuid := 'c0000000-0000-0000-0000-000000000001';
  cid      uuid;
  room     uuid;
  sid      uuid;
  res      json;
  q        json;
begin
  raise notice '';
  raise notice '── 0. The migration is actually applied ──';
  -- Without this the whole suite passes against the previous migration:
  -- every assertion below about OTHER fields is true of the old body too,
  -- and only the template_id ones would fail — which is exactly the sort
  -- of half-pass that gets read as flaky and ignored.
  perform t_ok('classroom_session_history exists',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'classroom_session_history'));

  perform t_ok('and has exactly one signature',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'classroom_session_history') = 1);

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'classroom_session_history'
                    and pg_get_functiondef(p.oid) like '%template_id%') then
    raise exception 'the installed classroom_session_history does not mention '
                    'template_id — apply setup-classroom-history-standards.sql';
  end if;
  perform t_ok('…and its body returns template_id', true);

  insert into auth.users (id, email) values (owner_id, 'head@std.example')
    on conflict (id) do nothing;
  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('std-school', 'Standards School', 'school', owner_id, now() + interval '6 months')
    returning id into cid;
  insert into community_members (community_id, user_id, role)
    values (cid, owner_id, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid, 'Room S', '3-5', owner_id) returning id into room;

  perform set_config('test.uid', owner_id::text, false);

  raise notice '';
  raise notice '── A. A lesson carries the id of every question asked ──';
  insert into classroom_sessions (classroom_id, started_by, started_at)
    values (room, owner_id, now() - interval '1 hour') returning id into sid;
  insert into classroom_session_answers
    (session_id, template_id, category, grade_band, prompt, choices, correct_index, is_correct)
  values
    (sid, 'box-quartile',  'math',    '3-5', 'q1', '[]'::jsonb, 0, true),
    (sid, 'scatter-temp',  'analysis','3-5', 'q2', '[]'::jsonb, 1, false),
    (sid, 'word-jumble',   'puzzle',  '3-5', 'q3', '[]'::jsonb, 0, true);

  res := classroom_session_history(room, 50);
  perform t_ok('one lesson came back',
    json_array_length(res->'lessons') = 1);

  q := (res->'lessons')->0;
  perform t_ok('with all three questions',
    json_array_length(q->'questions') = 3);

  perform t_ok('every question has a template_id',
    not exists (select 1 from json_array_elements(q->'questions') e
                 where e->>'template_id' is null));

  perform t_ok('and they are the ids that were stored',
    (select array_agg(e->>'template_id' order by e->>'template_id')
       from json_array_elements(q->'questions') e)
    = array['box-quartile','scatter-temp','word-jumble']);

  raise notice '';
  raise notice '── B. Nothing else about the shape moved ──';
  -- The client reads all of these. A replacement that quietly dropped one
  -- would break Previous Lessons in a way no standards test would catch.
  perform t_ok('the envelope still has both keys',
    (res::jsonb) ? 'lessons' and (res::jsonb) ? 'empty_count');

  -- ? is a jsonb operator and json has not got one, which has cost this
  -- project a migration before. Every membership test here casts first.
  perform t_ok('a question still carries prompt, choices and correctness',
    (((q->'questions')->0)::jsonb) ?& array['prompt','choices','correct_index',
                                            'class_index','is_correct','pending',
                                            'resolved_actual']);

  perform t_ok('and the lesson still carries its timings',
    (q::jsonb) ?& array['started_at','ended_at','asked_count']);

  raise notice '';
  raise notice '── C. Abandoned boards are still counted, not listed ──';
  insert into classroom_sessions (classroom_id, started_by, started_at)
    values (room, owner_id, now() - interval '2 days');
  insert into classroom_sessions (classroom_id, started_by, started_at)
    values (room, owner_id, now() - interval '3 days');

  res := classroom_session_history(room, 50);
  perform t_ok('still one lesson',
    json_array_length(res->'lessons') = 1);
  perform t_ok('and two empties counted',
    (res->>'empty_count')::int = 2);

  raise notice '';
  raise notice '── D. Still only people who may manage the class ──';
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000009', false);
  begin
    perform classroom_session_history(room, 10);
    perform t_ok('a stranger is refused', false);
  exception when others then
    perform t_ok('a stranger is refused', true);
  end;
end $$;
