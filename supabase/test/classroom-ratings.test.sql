-- Behavior tests for setup-classroom-ratings.sql.
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
  owner_id uuid := 'a1111111-1111-1111-1111-111111111111';
  teach_a  uuid := 'a2222222-2222-2222-2222-222222222222';
  teach_b  uuid := 'a3333333-3333-3333-3333-333333333333';
  cid      uuid;
  room_a   uuid;
  room_b   uuid;
  res      json;
  n        integer;
begin
  insert into communities (slug, name, kind, owner_user_id)
    values ('rate-school', 'Rating School', 'school', owner_id)
    returning id into cid;
  insert into community_members (community_id, user_id, role) values
    (cid, owner_id, 'owner'), (cid, teach_a, 'teacher'), (cid, teach_b, 'teacher');
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid, 'Room A', '3-5', teach_a) returning id into room_a;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid, 'Room B', '3-5', teach_b) returning id into room_b;

  -- ── A. The class teacher rates, and reads it back ──
  perform set_config('test.uid', teach_a::text, false);
  perform t_ok('A1 thumbs up returns 1',
    classroom_rate_template(room_a, 'count-one-day', 1) = 1);
  perform t_ok('A2 thumbs down returns -1',
    classroom_rate_template(room_a, 'letter-code', -1) = -1);
  res := classroom_template_ratings(room_a);
  perform t_ok('A3 read back as an object keyed by template',
    (res->>'count-one-day')::int = 1 and (res->>'letter-code')::int = -1);

  -- ── B. Changing and clearing ──
  perform classroom_rate_template(room_a, 'count-one-day', -1);
  select count(*) into n from classroom_question_ratings
   where classroom_id = room_a and template_id = 'count-one-day';
  perform t_ok('B1 changing a rating keeps one row', n = 1);
  perform t_ok('B2 and it holds the new value',
    (classroom_template_ratings(room_a)->>'count-one-day')::int = -1);
  perform t_ok('B3 clearing returns 0',
    classroom_rate_template(room_a, 'count-one-day', 0) = 0);
  perform t_ok('B4 and deletes the row — neutral has one representation',
    classroom_template_ratings(room_a)->'count-one-day' is null);
  perform t_ok('B5 clearing what was never rated is not an error',
    classroom_rate_template(room_a, 'never-rated', 0) = 0);
  perform t_ok('B6 a teacher question id is accepted',
    classroom_rate_template(room_a,
      'teacher:0d0d0d0d-0000-0000-0000-000000000000', 1) = 1);

  -- ── C. Bad input ──
  perform t_raises('C1 rating 2 is refused',
    format('select classroom_rate_template(%L, %L, 2)', room_a, 'x'));
  perform t_raises('C2 null rating is refused',
    format('select classroom_rate_template(%L, %L, null)', room_a, 'x'));
  perform t_raises('C3 blank template is refused',
    format('select classroom_rate_template(%L, %L, 1)', room_a, '   '));
  perform t_raises('C4 overlong template is refused',
    format('select classroom_rate_template(%L, %L, 1)', room_a, repeat('x', 81)));

  -- ── D. Classroom-local, and only for those who manage it ──
  perform set_config('test.uid', teach_b::text, false);
  perform t_raises('D1 another teacher cannot rate my class',
    format('select classroom_rate_template(%L, %L, -1)', room_a, 'letter-code'));
  perform t_raises('D2 nor read my ratings',
    format('select classroom_template_ratings(%L)', room_a));
  perform t_ok('D3 their own class starts with no opinions',
    classroom_template_ratings(room_b)::text = '{}');
  perform classroom_rate_template(room_b, 'letter-code', 1);
  perform set_config('test.uid', teach_a::text, false);
  perform t_ok('D4 their thumbs up did not touch my thumbs down',
    (classroom_template_ratings(room_a)->>'letter-code')::int = -1);

  perform set_config('test.uid', owner_id::text, false);
  perform t_ok('D5 the owner can rate any class (covering a lesson)',
    classroom_rate_template(room_a, 'hidden-bird', 1) = 1);

  perform set_config('test.uid', '', false);
  perform t_raises('D6 signed out is refused',
    format('select classroom_template_ratings(%L)', room_a));

  -- ── E. Ratings go with the classroom ──
  delete from classrooms where id = room_a;
  select count(*) into n from classroom_question_ratings where classroom_id = room_a;
  perform t_ok('E1 deleting the classroom deletes its ratings', n = 0);
end $$;
