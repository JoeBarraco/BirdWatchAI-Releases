-- Behaviour tests for setup-classroom-teacher-questions-2.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-classroom-teacher-questions.sql AND
-- setup-classroom-teacher-questions-2.sql, in that order.
--
-- What is actually being guarded here is the SHARING RULE, which has
-- four conditions that all have to hold at once — shared, same
-- community, same grade band, not your own — and any one of them
-- failing open means a teacher's lesson acquires somebody else's
-- question without them asking. Sections D and E exist for that.

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
  raise notice 'PASS % [%]', label, left(sqlerrm, 52);
end $$;


do $$
declare
  head   uuid := 'd0000000-0000-0000-0000-000000000001';
  other  uuid := 'd0000000-0000-0000-0000-000000000002';
  cid    uuid;
  cid2   uuid;
  fid    uuid := 'd0000000-0000-0000-0000-0000000000f1';
  fout   uuid := 'd0000000-0000-0000-0000-0000000000f2';
  roomA  uuid; roomB uuid; roomC uuid; roomD uuid;
  photo  uuid; clip uuid; outside uuid;
  q1     uuid; q2 uuid;
  res    json;
begin
  raise notice '';
  raise notice '── 0. The migration is applied ──';
  perform t_ok('save() has exactly one signature',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='classroom_teacher_question_save') = 1);
  if not exists (select 1 from information_schema.columns
                  where table_name='classroom_teacher_questions' and column_name='shared') then
    raise exception 'shared column missing — apply setup-classroom-teacher-questions-2.sql';
  end if;
  perform t_ok('the new columns exist',
    (select count(*) from information_schema.columns
      where table_name='classroom_teacher_questions'
        and column_name in ('shared','category','standards','chart_spec','clip_detection_id')) = 5);

  insert into auth.users (id,email) values (head,'head@tq.example'), (other,'other@tq.example')
    on conflict (id) do nothing;
  insert into communities (slug,name,kind,owner_user_id,school_expires_at)
    values ('tq-school','TQ School','school',head, now() + interval '6 months') returning id into cid;
  insert into communities (slug,name,kind,owner_user_id,school_expires_at)
    values ('tq-other','Other School','school',head, now() + interval '6 months') returning id into cid2;
  insert into community_members (community_id,user_id,role)
    values (cid,head,'owner'), (cid2,head,'owner');

  -- A feeder approved in this community, and one that is not.
  insert into community_feeders (community_id, feeder_id, status)
    values (cid, fid, 'approved'), (cid, fout, 'pending');

  insert into classrooms (community_id,name,grade_band,teacher_user_id)
    values (cid,'Room A','3-5',head) returning id into roomA;
  insert into classrooms (community_id,name,grade_band,teacher_user_id)
    values (cid,'Room B','3-5',head) returning id into roomB;
  insert into classrooms (community_id,name,grade_band,teacher_user_id)
    values (cid,'Room C','k-2',head) returning id into roomC;
  insert into classrooms (community_id,name,grade_band,teacher_user_id)
    values (cid2,'Room D','3-5',head) returning id into roomD;

  insert into community_detections (feeder_id, species, image_url, video_url)
    values (fid,'Northern Cardinal','https://x/p.jpg', null) returning id into photo;
  insert into community_detections (feeder_id, species, image_url, video_url)
    values (fid,'Blue Jay','https://x/c.jpg','https://x/c.mp4') returning id into clip;
  insert into community_detections (feeder_id, species, image_url, video_url)
    values (fout,'Crow','https://x/o.jpg', null) returning id into outside;

  perform set_config('test.uid', head::text, false);

  raise notice '';
  raise notice '── A. Media may come from any APPROVED feeder in the community ──';
  res := classroom_teacher_question_save(roomA, null, 'Which bird?',
           array['Cardinal','Jay'], 0, null, photo);
  q1 := (res->>'id')::uuid;
  perform t_ok('a photo from an approved community feeder is accepted', q1 is not null);

  perform t_ok('a clip is accepted too',
    (classroom_teacher_question_save(roomA, q1, 'Which bird?',
       array['Cardinal','Jay'], 0, null, photo, clip)->>'clip_detection_id') = clip::text);

  perform t_raises('a feeder that is NOT approved here is refused',
    format('select classroom_teacher_question_save(%L,null,%L,array[''a'',''b''],0,null,%L)',
           roomA, 'Q', outside));

  perform t_raises('a detection with no clip cannot be used as one',
    format('select classroom_teacher_question_save(%L,null,%L,array[''a'',''b''],0,null,null,%L)',
           roomA, 'Q', photo));

  raise notice '';
  raise notice '── B. Category, standards and chart spec ──';
  res := classroom_teacher_question_save(roomA, q1, 'Which bird?',
           array['Cardinal','Jay'], 0, null, photo, clip,
           '{"kind":"bars","source":"days"}'::jsonb, 'science',
           array['SC.3.L.15.1','MA.3.DP.1.2'], false);
  perform t_ok('they round-trip',
    res->>'category' = 'science'
    and (res->'standards')::jsonb ? 'SC.3.L.15.1'
    and res->'chart_spec'->>'kind' = 'bars');

  perform t_raises('a category outside the list is refused',
    format('select classroom_teacher_question_save(%L,%L,%L,array[''a'',''b''],0,null,null,null,null,%L)',
           roomA, q1, 'Q', 'astrology'));

  perform t_raises('a chart shape the client cannot draw is refused',
    format('select classroom_teacher_question_save(%L,%L,%L,array[''a'',''b''],0,null,null,null,%L)',
           roomA, q1, 'Q', '{"kind":"sunburst","source":"days"}'));

  perform t_raises('a standard that is not a benchmark code is refused',
    format('select classroom_teacher_question_save(%L,%L,%L,array[''a'',''b''],0,null,null,null,null,null,%L)',
           roomA, q1, 'Q', array['not a code']));

  raise notice '';
  raise notice '── C. Sharing offers; it does not impose ──';
  perform classroom_teacher_question_save(roomA, q1, 'Which bird?',
    array['Cardinal','Jay'], 0, null, photo, clip, null, 'science',
    array['SC.3.L.15.1'], true);

  perform t_ok('Room B is offered it',
    json_array_length(classroom_shared_questions_list(roomB)) = 1);
  perform t_ok('…but has NOT got it until it adopts',
    json_array_length(classroom_teacher_questions_list(roomB)) = 0);

  perform classroom_adopt_question(roomB, q1, true);
  perform t_ok('after adopting, it is in Room B''s list',
    json_array_length(classroom_teacher_questions_list(roomB)) = 1);
  perform t_ok('…marked as not its own',
    ((classroom_teacher_questions_list(roomB))->0->>'owned') = 'false');
  perform t_ok('…and it drops off the offered list',
    json_array_length(classroom_shared_questions_list(roomB)) = 0);

  perform t_ok('Room A still owns it',
    ((classroom_teacher_questions_list(roomA))->0->>'owned') = 'true');

  perform classroom_adopt_question(roomB, q1, false);
  perform t_ok('dropping it removes it again',
    json_array_length(classroom_teacher_questions_list(roomB)) = 0);

  raise notice '';
  raise notice '── D. The four conditions each hold on their own ──';
  perform t_ok('a different GRADE BAND is not offered it',
    json_array_length(classroom_shared_questions_list(roomC)) = 0);
  perform t_ok('a different COMMUNITY is not offered it',
    json_array_length(classroom_shared_questions_list(roomD)) = 0);

  perform t_raises('and cannot adopt it either',
    format('select classroom_adopt_question(%L,%L,true)', roomD, q1));

  res := classroom_teacher_question_save(roomA, null, 'Not shared',
           array['a','b'], 0, null, null);
  q2 := (res->>'id')::uuid;
  -- Not "the offered list is empty": q1 is still shared and Room B has
  -- just dropped it, so it is correctly back on offer. The claim is about
  -- q2 specifically, which was never shared.
  perform t_ok('an UNSHARED question is not among those offered',
    not exists (select 1 from json_array_elements(classroom_shared_questions_list(roomB)) e
                 where e->>'id' = q2::text));
  perform t_raises('and cannot be adopted',
    format('select classroom_adopt_question(%L,%L,true)', roomB, q2));

  perform t_ok('a class is never offered its OWN question',
    json_array_length(classroom_shared_questions_list(roomA)) = 0);

  raise notice '';
  raise notice '── E. Editing stays with the owner ──';
  perform classroom_adopt_question(roomB, q1, true);
  perform t_raises('Room B cannot edit a question it only adopted',
    format('select classroom_teacher_question_save(%L,%L,%L,array[''x'',''y''],0,null,null)',
           roomB, q1, 'Hijacked'));
  perform t_ok('…and the question is untouched',
    (select prompt from classroom_teacher_questions where id = q1) = 'Which bird?');

  raise notice '';
  raise notice '── F. Still only people who may manage the class ──';
  perform set_config('test.uid', other::text, false);
  perform t_raises('a stranger cannot list',
    format('select classroom_teacher_questions_list(%L)', roomA));
  perform t_raises('a stranger cannot see what is shared',
    format('select classroom_shared_questions_list(%L)', roomA));
  perform t_raises('a stranger cannot adopt',
    format('select classroom_adopt_question(%L,%L,true)', roomB, q1));
end $$;
