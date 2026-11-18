-- Behaviour tests for setup-classroom-journal.sql.
--
-- Order:
--   psql -f stub-schema.sql
--   psql -v part=pre  -f score-polls.test.sql     (join-code columns)
--   psql -c "alter table community_detections add column if not exists confidence double precision,
--                                             add column if not exists is_favorite boolean"
--   psql -f ../setup-classroom-score-polls.sql
--   psql -f ../setup-classroom-journal.sql
--   psql -f journal.test.sql

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
  owner_id uuid := 'f0000000-0000-0000-0000-0000000000b1';
  other_id uuid := 'f0000000-0000-0000-0000-0000000000b2';
  feeder   uuid := 'f0000000-0000-0000-0000-0000000000f1';
  cid uuid; room uuid; s1 uuid; s2 uuid; s3 uuid; j json; f json;
  y0 timestamptz := '2026-08-01'; y1 timestamptz := '2027-08-01';
begin
  insert into communities (slug, name, kind, owner_user_id)
    values ('jr-school', 'JR School', 'school', owner_id) returning id into cid;
  insert into community_members (community_id, user_id, role) values (cid, owner_id, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (cid, 'Room J', '3-5', owner_id, feeder) returning id into room;

  -- Lesson 1 (Sept): right, right, poll.  Lesson 2 (Oct): right, wrong,
  -- right, open prediction.  Lesson 3 (Oct): empty board.  A lesson from
  -- last school year, which must not count.
  insert into classroom_sessions (classroom_id, started_at) values (room, '2026-09-10 09:00') returning id into s1;
  insert into classroom_sessions (classroom_id, started_at) values (room, '2026-10-02 09:00') returning id into s2;
  insert into classroom_sessions (classroom_id, started_at) values (room, '2026-10-03 09:00') returning id into s3;
  insert into classroom_session_answers (session_id, asked_at, template_id, category, grade_band, prompt, correct_index, class_index, is_correct, pending_check) values
    (s1, '2026-09-10 09:01', 'a', 'counting', '3-5', 'q1', 0, 0, true,  null),
    (s1, '2026-09-10 09:02', 'b', 'counting', '3-5', 'q2', 1, 1, true,  null),
    (s1, '2026-09-10 09:03', 'p', 'observation', '3-5', 'poll', null, 0, null, null),
    (s2, '2026-10-02 09:01', 'c', 'counting', '3-5', 'q3', 0, 0, true,  null),
    (s2, '2026-10-02 09:02', 'd', 'counting', '3-5', 'q4', 0, 1, false, null),
    (s2, '2026-10-02 09:03', 'e', 'counting', '3-5', 'q5', 2, 2, true,  null),
    (s2, '2026-10-02 09:04', 'f', 'prediction', '3-5', 'tomorrow?', null, 1, null, '{"k":1}');
  insert into classroom_sessions (classroom_id, started_at) values (room, '2026-05-01') returning id into s3;
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, correct_index, class_index, is_correct)
    values (s3, 'old', 'counting', '3-5', 'old', 0, 0, true);

  perform set_config('test.uid', owner_id::text, true);
  j := classroom_journal(room, y0, y1);
  perform t_ok('A1 lessons: two with questions, not the empty board or last year', (j->>'lessons')::int = 2);
  perform t_ok('A2 asked leaves out the poll and the open prediction', (j->>'asked')::int = 5);
  perform t_ok('A3 correct', (j->>'correct')::int = 4);
  perform t_ok('A4 best run crosses lessons: right, right, right', (j->>'best_run')::int = 3);
  perform t_ok('A5 by month: Sept and Oct', json_array_length(j->'by_month') = 2
               and (j->'by_month'->1->>'lessons')::int = 1 and (j->'by_month'->1->>'asked')::int = 3);
  perform t_ok('A6 the prediction is listed, pending', json_array_length(j->'predictions') = 1
               and (j->'predictions'->0->>'pending')::boolean);
  perform t_ok('A7 polls counted separately', (j->>'polls')::int = 1);

  perform set_config('test.uid', other_id::text, true);
  perform t_raises('B1 a stranger cannot read the journal',
                   format('select classroom_journal(%L, %L, %L)', room, y0, y1));

  -- Firsts: earliest per species, the clearest photo, the excluded and the
  -- out-of-window left out.
  insert into community_detections (feeder_id, species, image_url, confidence, detected_at) values
    (feeder, 'Dark-eyed Junco', 'blur.jpg',  0.4, '2026-11-03 08:00'),
    (feeder, 'Dark-eyed Junco', 'sharp.jpg', 0.97, '2026-11-20 08:00'),
    (feeder, 'Northern Cardinal', null,      0.9, '2026-08-15 08:00'),
    (feeder, 'Northern Cardinal', 'c.jpg',   0.8, '2026-09-01 08:00'),
    (feeder, 'Squirrel', 's.jpg',            0.9, '2026-09-01 08:00'),
    (feeder, 'Blue Jay', 'j.jpg',            0.9, '2026-07-01 08:00'),
    (feeder, 'Tufted Titmouse', 'conf.jpg',  0.99, '2026-10-01 08:00'),
    (feeder, 'Tufted Titmouse', 'star.jpg',  0.50, '2026-10-02 08:00');
  update community_detections set is_favorite = true where image_url = 'star.jpg';
  f := classroom_year_firsts(array[feeder], y0, y1, array['squirrel']);
  perform t_ok('C1 three species, the squirrel and last year''s jay left out', json_array_length(f) = 3);
  perform t_ok('C2 in order of first sighting', f->0->>'sp' = 'Northern Cardinal');
  perform t_ok('C3 the first junco is the first one', (f->2->>'first_at')::timestamptz = '2026-11-03 08:00');
  perform t_ok('C4 but its photo is the clearest', f->2->>'photo' = 'sharp.jpg' and (f->2->>'n')::int = 2);
  perform t_ok('C6 a starred photo beats a more confident one', f->1->>'photo' = 'star.jpg');
  perform t_ok('C5 a photo is found even when the first visit had none', f->0->>'photo' = 'c.jpg');
end $$;
