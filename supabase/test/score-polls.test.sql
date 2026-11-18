-- Behaviour tests for setup-classroom-score-polls.sql.
--
-- Needs stub-schema.sql, then this file's own preamble (the join-code
-- columns and tables the stub does not carry), then
-- setup-classroom-score-polls.sql, then the body below. Run in that order:
--   psql -f stub-schema.sql
--   psql -v part=pre  -f score-polls.test.sql
--   psql -f ../setup-classroom-score-polls.sql
--   psql -v part=test -f score-polls.test.sql
--
-- The point: a question with no right answer (a poll, or a prediction
-- that has not settled) must not count as asked, so a class that got
-- everything right does not see "0 / 1".

\if :{?part}
\else
  \set part test
\endif

select :'part' = 'pre' as is_pre \gset
\if :is_pre
alter table classroom_session_answers
  add column if not exists vote_counts       jsonb,
  add column if not exists participant_count int;
create table if not exists classroom_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references classroom_sessions(id) on delete cascade);
create table if not exists classroom_votes (
  answer_id uuid, participant_id uuid, choice_index int);
\quit
\endif

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

do $$
declare
  owner_id uuid := 'f0000000-0000-0000-0000-0000000000a1';
  cid  uuid; room uuid; sid uuid; sid2 uuid; res json; pred uuid; aid uuid;
  s    classroom_sessions%rowtype;
begin
  insert into communities (slug, name, kind, owner_user_id)
    values ('sp-school', 'SP School', 'school', owner_id) returning id into cid;
  insert into community_members (community_id, user_id, role) values (cid, owner_id, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid, 'Room 1', 'k-2', owner_id) returning id into room;
  insert into classroom_sessions (classroom_id) values (room) returning id into sid;
  perform set_config('test.uid', owner_id::text, true);

  -- A: teacher-led. One right, one poll, one prediction.
  perform classroom_session_record(sid, '{"prompt":"How many?","choices":[{"label":"1"},{"label":"2"}],"correct_index":1,"class_index":1}');
  perform classroom_session_record(sid, '{"prompt":"What is it doing?","choices":[{"label":"Eating"}],"class_index":0}');
  res := classroom_session_record(sid, '{"prompt":"Tomorrow?","choices":[{"label":"More"},{"label":"Fewer"}],"class_index":0,"pending_check":{"k":1}}');
  pred := (res->>'id')::uuid;
  select * into s from classroom_sessions where id = sid;
  perform t_ok('A1 the poll and the open prediction are not counted as asked', s.asked_count = 1);
  perform t_ok('A2 the right answer still counts as correct', s.correct_count = 1);

  -- B: the prediction settles, and the class called it.
  perform classroom_resolve_prediction(pred, 5, 0);
  select * into s from classroom_sessions where id = sid;
  perform t_ok('B1 a settled prediction joins asked', s.asked_count = 2);
  perform t_ok('B2 and correct, when the class called it', s.correct_count = 2);
  perform classroom_resolve_prediction(pred, 5, 0);
  select * into s from classroom_sessions where id = sid;
  perform t_ok('B3 resolving twice does not count twice', s.asked_count = 2 and s.correct_count = 2);

  -- C: join-code close. A poll is not counted; a split vote still is.
  insert into classroom_sessions (classroom_id, mode) values (room, 'join_code') returning id into sid2;
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, correct_index)
    values (sid2, 'clip-what-doing', 'observation', 'k-2', 'Doing?', null) returning id into aid;
  perform classroom_question_close(aid, 0);
  select * into s from classroom_sessions where id = sid2;
  perform t_ok('C1 a closed poll is not counted', s.asked_count = 0);
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, correct_index)
    values (sid2, 'count-one-day', 'counting', 'k-2', 'How many?', 1) returning id into aid;
  perform classroom_question_close(aid);   -- no votes at all: no class answer
  select * into s from classroom_sessions where id = sid2;
  perform t_ok('C2 a question with a right answer counts even with no class answer', s.asked_count = 1 and s.correct_count = 0);
end $$;
