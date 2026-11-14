-- Behavior tests for setup-classroom-teacher-questions.sql.
-- Needs stub-schema.sql and that migration applied.

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
  owner_id  uuid := '44444444-4444-4444-4444-444444444444';
  mod_id    uuid := '55555555-5555-5555-5555-555555555555';
  teach_a   uuid := '66666666-6666-6666-6666-666666666666';
  teach_b   uuid := '77777777-7777-7777-7777-777777777777';
  viewer_id uuid := '88888888-8888-8888-8888-888888888888';
  home_f    uuid := 'aaaaaaaa-0000-0000-0000-00000000000a';
  partner_f uuid := 'bbbbbbbb-0000-0000-0000-00000000000b';
  other_f   uuid := 'cccccccc-0000-0000-0000-00000000000c';
  cid       uuid;
  room_a    uuid;
  room_b    uuid;
  det_home  uuid;
  det_part  uuid;
  det_other uuid;
  q1        uuid;
  res       json;
  i         integer;
begin
  insert into communities (slug, name, kind, owner_user_id)
    values ('tq-school', 'Question School', 'school', owner_id)
    returning id into cid;

  insert into community_members (community_id, user_id, role) values
    (cid, owner_id, 'owner'), (cid, mod_id, 'moderator'),
    (cid, teach_a, 'teacher'), (cid, teach_b, 'teacher'),
    (cid, viewer_id, 'viewer');

  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (cid, 'Anna K-2', 'k-2', teach_a, home_f) returning id into room_a;
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (cid, 'Ben 6-8', '6-8', teach_b, other_f) returning id into room_b;
  insert into classroom_partner_feeders (classroom_id, feeder_id) values (room_a, partner_f);

  insert into community_detections (feeder_id, species, image_url)
    values (home_f, 'Blue Jay', 'https://example.test/jay.jpg') returning id into det_home;
  insert into community_detections (feeder_id, species, image_url)
    values (partner_f, 'Carolina Wren', 'private://wren.jpg') returning id into det_part;
  insert into community_detections (feeder_id, species, image_url)
    values (other_f, 'House Finch', 'https://example.test/finch.jpg') returning id into det_other;

  raise notice '';
  raise notice '── A. Who may write and read ──';
  perform set_config('test.uid', teach_a::text, false);
  res := classroom_teacher_question_save(room_a, null, '  Which bird hunts at night?  ',
           array[' Owl', 'Robin ', 'Blue Jay'], 0, '  Owls see in the dark.  ', null);
  q1 := (res->>'id')::uuid;
  perform t_ok('the class''s own teacher can save one', q1 is not null);
  perform t_ok('the prompt is trimmed', res->>'prompt' = 'Which bird hunts at night?');
  perform t_ok('every answer is trimmed, in order',
    (res->'choices')::jsonb = '["Owl", "Robin", "Blue Jay"]'::jsonb);
  perform t_ok('the reveal note is trimmed', res->>'explain' = 'Owls see in the dark.');
  perform t_ok('a new question starts switched on', (res->>'active')::boolean);
  perform t_ok('and records who wrote it', (res->>'created_by')::uuid = teach_a);

  perform t_ok('the teacher can list it',
    json_array_length(classroom_teacher_questions_list(room_a)) = 1);

  perform set_config('test.uid', teach_b::text, false);
  perform t_raises('another teacher in the school cannot list it',
    format('select classroom_teacher_questions_list(%L)', room_a));
  perform t_raises('nor add to it',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, 'Sneaky?', 'Yes', 'No'));
  perform t_raises('nor switch it off',
    format('select classroom_teacher_question_set_active(%L, false)', q1));
  perform t_raises('nor delete it',
    format('select classroom_teacher_question_delete(%L)', q1));
  perform t_raises('nor edit it by naming their own classroom',
    format('select classroom_teacher_question_save(%L, %L, %L, array[%L,%L], 0, null, null)',
           room_b, q1, 'Hijacked', 'Yes', 'No'));

  perform set_config('test.uid', mod_id::text, false);
  perform t_ok('a moderator can list it',
    json_array_length(classroom_teacher_questions_list(room_a)) = 1);

  perform set_config('test.uid', viewer_id::text, false);
  perform t_raises('a viewer cannot',
    format('select classroom_teacher_questions_list(%L)', room_a));

  perform set_config('test.uid', '', false);
  perform t_raises('nobody signed in cannot',
    format('select classroom_teacher_questions_list(%L)', room_a));

  raise notice '';
  raise notice '── B. What counts as a question ──';
  perform set_config('test.uid', teach_a::text, false);
  perform t_raises('a blank prompt is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, '   ', 'Yes', 'No'));
  perform t_raises('a prompt over 300 characters is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, repeat('x', 301), 'Yes', 'No'));
  perform t_raises('one answer is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L], 0, null, null)',
           room_a, 'Q?', 'Yes'));
  perform t_raises('five answers are refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L,%L,%L,%L], 0, null, null)',
           room_a, 'Q?', 'a', 'b', 'c', 'd', 'e'));
  perform t_raises('a blank answer is refused, not dropped',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L,%L], 2, null, null)',
           room_a, 'Q?', 'Yes', '  ', 'No'));
  perform t_raises('the same answer twice is refused, whatever the case',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, 'Q?', 'Robin', ' robin'));
  perform t_raises('an answer over 80 characters is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, 'Q?', repeat('y', 81), 'No'));
  perform t_raises('no right answer is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], null, null, null)',
           room_a, 'Q?', 'Yes', 'No'));
  perform t_raises('a right answer past the end is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 2, null, null)',
           room_a, 'Q?', 'Yes', 'No'));
  perform t_raises('a reveal note over 400 characters is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, %L, null)',
           room_a, 'Q?', 'Yes', 'No', repeat('z', 401)));
  perform t_ok('none of the refused ones were saved',
    json_array_length(classroom_teacher_questions_list(room_a)) = 1);

  raise notice '';
  raise notice '── C. Photos from the class''s own feeders only ──';
  res := classroom_teacher_question_save(room_a, null, 'Who is this?',
           array['Blue Jay', 'Robin'], 0, null, det_home);
  perform t_ok('a photo from the home feeder is accepted',
    (res->>'detection_id')::uuid = det_home);
  res := classroom_teacher_question_save(room_a, null, 'And this one?',
           array['Carolina Wren', 'Robin'], 0, null, det_part);
  perform t_ok('a photo from a partner feeder is accepted',
    (res->>'detection_id')::uuid = det_part);
  perform t_raises('a photo from somebody else''s feeder is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, %L)',
           room_a, 'Q?', 'Yes', 'No', det_other));
  perform t_raises('a made-up detection id is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, %L)',
           room_a, 'Q?', 'Yes', 'No', gen_random_uuid()));
  res := classroom_teacher_questions_list(room_a);
  perform t_ok('the list returns the photo''s address, looked up from the detection',
    exists (select 1 from json_array_elements(res) e
            where e->>'image_url' = 'https://example.test/jay.jpg'));
  perform t_ok('a private feeder''s marker comes back as-is, for the client to sign',
    exists (select 1 from json_array_elements(res) e
            where e->>'image_url' = 'private://wren.jpg'));
  perform t_ok('the list is oldest first',
    (res->0->>'id')::uuid = q1);

  raise notice '';
  raise notice '── D. Editing ──';
  res := classroom_teacher_question_save(room_a, q1, 'Which bird hunts at night?',
           array['Robin', 'Owl'], 1, null, null);
  perform t_ok('an edit keeps the same id', (res->>'id')::uuid = q1);
  perform t_ok('and moves the right answer with it', (res->>'correct_index')::int = 1);
  perform t_ok('and can clear the reveal note', res->>'explain' is null);
  perform t_raises('an edit naming an id that does not exist is refused',
    format('select classroom_teacher_question_save(%L, %L, %L, array[%L,%L], 0, null, null)',
           room_a, gen_random_uuid(), 'Q?', 'Yes', 'No'));

  raise notice '';
  raise notice '── E. On, off and gone ──';
  perform t_ok('the teacher can switch it off',
    classroom_teacher_question_set_active(q1, false));
  perform t_ok('and it stays in the list, switched off',
    exists (select 1 from json_array_elements(classroom_teacher_questions_list(room_a)) e
            where (e->>'id')::uuid = q1 and not (e->>'active')::boolean));
  perform t_ok('and back on', classroom_teacher_question_set_active(q1, true));
  perform t_ok('the teacher can delete it', classroom_teacher_question_delete(q1));
  perform t_raises('deleting it twice says not found',
    format('select classroom_teacher_question_delete(%L)', q1));

  raise notice '';
  raise notice '── F. The cap ──';
  for i in 1..58 loop
    perform classroom_teacher_question_save(room_a, null, 'Filler ' || i,
              array['Yes', 'No'], 0, null, null);
  end loop;
  perform t_ok('sixty fit', json_array_length(classroom_teacher_questions_list(room_a)) = 60);
  perform t_raises('the sixty-first is refused',
    format('select classroom_teacher_question_save(%L, null, %L, array[%L,%L], 0, null, null)',
           room_a, 'One more?', 'Yes', 'No'));
  perform t_ok('but editing one at the cap still works',
    classroom_teacher_question_save(room_a,
      (classroom_teacher_questions_list(room_a)->0->>'id')::uuid,
      'Edited at the cap', array['Yes', 'No'], 1, null, null) is not null);

  raise notice '';
  raise notice '── G. Gone with the classroom ──';
  delete from classrooms where id = room_a;
  perform t_ok('deleting the classroom deletes its questions',
    not exists (select 1 from classroom_teacher_questions where classroom_id = room_a));

  raise notice '';
  raise notice '── H. Nothing readable without the functions ──';
  perform t_ok('row level security is on',
    (select relrowsecurity from pg_class where relname = 'classroom_teacher_questions'));
  perform t_ok('anon cannot call the list function',
    not has_function_privilege('anon', 'classroom_teacher_questions_list(uuid)', 'execute'));
  perform t_ok('a signed-in caller can',
    has_function_privilege('authenticated', 'classroom_teacher_questions_list(uuid)', 'execute'));
end $$;
