-- ============================================================
-- BirdWatchAI Classroom — a poll does not count against the class
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql and setup-classroom-join.sql. Replaces
-- three functions with the same signatures (grants are kept by CREATE OR
-- REPLACE) and recounts the existing sessions once.
--
-- THE BUG (TODO.MD, CLASSROOM, 2026-11-14)
-- A question with no right answer still counted as asked. The clip poll
-- "What is it doing?" has none ever; a prediction has none until the
-- data comes in. So a class that got everything right saw "0 / 1" after
-- a poll, and a prediction counted as a miss until it settled.
--
-- THE RULE NOW
-- asked_count counts a question once it has a right answer:
--   * classroom_session_record  — when it is recorded, if it has one.
--   * classroom_question_close  — when voting closes, if it has one.
--   * classroom_resolve_prediction — when a prediction settles.
-- A poll never has one, so it is never counted. The stage applies the
-- same rule (community-classroom.js, answerClassroomQuestion and
-- finishClassroomQuestion), so the board and the history agree.
--
-- Applied to production 2026-11-18. Changed three sessions' asked_count,
-- each by one unsettled prediction; no correct_count changed.
-- ============================================================

begin;

CREATE OR REPLACE FUNCTION public.classroom_session_record(p_session_id uuid, p_question jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  room_id    uuid;
  ans        classroom_session_answers%rowtype;
  correct_ix integer;
  class_ix   integer;
  ok         boolean;
begin
  select classroom_id into room_id from classroom_sessions where id = p_session_id;
  if room_id is null then
    raise exception 'Session not found';
  end if;
  perform classroom_require_manage(room_id);

  if p_question is null or jsonb_typeof(p_question) <> 'object' then
    raise exception 'A question object is required';
  end if;
  if coalesce(p_question->>'prompt', '') = '' then
    raise exception 'A question needs a prompt';
  end if;
  if length(p_question->>'prompt') > 500 then
    raise exception 'Question prompt is too long';
  end if;
  if jsonb_typeof(coalesce(p_question->'choices', '[]'::jsonb)) <> 'array' then
    raise exception 'Question choices must be a list';
  end if;
  if jsonb_array_length(coalesce(p_question->'choices', '[]'::jsonb)) > 8 then
    raise exception 'Too many choices for one question';
  end if;

  correct_ix := nullif(p_question->>'correct_index', '')::integer;
  class_ix   := nullif(p_question->>'class_index',   '')::integer;
  ok         := case when correct_ix is null or class_ix is null
                     then null else correct_ix = class_ix end;

  insert into classroom_session_answers (
    session_id, template_id, category, grade_band, scope,
    prompt, choices, correct_index, class_index, is_correct,
    source_feeder_id, detection_id, pending_check, resolve_after)
  values (
    p_session_id,
    coalesce(p_question->>'template_id', 'unknown'),
    coalesce(p_question->>'category',    'unknown'),
    coalesce(p_question->>'grade_band',  'k-2'),
    coalesce(p_question->>'scope',       'home'),
    p_question->>'prompt',
    coalesce(p_question->'choices', '[]'::jsonb),
    correct_ix, class_ix, ok,
    nullif(p_question->>'source_feeder_id', '')::uuid,
    nullif(p_question->>'detection_id',     '')::uuid,
    case when jsonb_typeof(coalesce(p_question->'pending_check', 'null'::jsonb)) = 'object'
         then p_question->'pending_check' else null end,
    nullif(p_question->>'resolve_after', '')::timestamptz)
  returning * into ans;

  update classroom_sessions
     set asked_count   = asked_count + case when correct_ix is not null then 1 else 0 end,
         correct_count = correct_count + case when ok then 1 else 0 end
   where id = p_session_id;

  return row_to_json(ans);
end;
$$;


CREATE OR REPLACE FUNCTION public.classroom_question_close(p_answer_id uuid, p_class_index integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  room_id  uuid;
  ans      classroom_session_answers%rowtype;
  tally    jsonb;
  winner   integer;
  tied     boolean;
  ok       boolean;
  joined   integer;
begin
  select s.classroom_id into room_id
  from classroom_session_answers a
  join classroom_sessions s on s.id = a.session_id
  where a.id = p_answer_id;
  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  select * into ans from classroom_session_answers where id = p_answer_id;
  if ans.class_index is not null or ans.vote_counts is not null then
    return row_to_json(ans);          -- already closed; idempotent
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('i', choice_index, 'n', n)
                            order by choice_index), '[]'::jsonb)
    into tally
  from (select choice_index, count(*) as n
        from classroom_votes where answer_id = p_answer_id
        group by choice_index) c;

  select count(*) into joined
  from classroom_participants where session_id = ans.session_id;

  -- Plurality, and whether it is shared.
  select c.choice_index into winner
  from (select choice_index, count(*) as n
        from classroom_votes where answer_id = p_answer_id
        group by choice_index) c
  order by c.n desc, c.choice_index
  limit 1;

  tied := winner is not null and exists (
    select 1
    from (select choice_index, count(*) as n
          from classroom_votes where answer_id = p_answer_id
          group by choice_index) c
    where c.choice_index <> winner
      and c.n = (select count(*) from classroom_votes
                 where answer_id = p_answer_id and choice_index = winner)
  );

  if p_class_index is not null then
    winner := p_class_index;
  elsif tied then
    winner := null;
  end if;

  ok := case when ans.correct_index is null or winner is null
             then null else ans.correct_index = winner end;

  update classroom_session_answers
     set class_index       = winner,
         is_correct        = ok,
         vote_counts       = tally,
         participant_count = joined
   where id = p_answer_id
  returning * into ans;

  update classroom_sessions
     set voting_open   = false,
         asked_count   = asked_count + case when ans.correct_index is not null then 1 else 0 end,
         correct_count = correct_count + case when ok then 1 else 0 end
   where id = ans.session_id;

  return row_to_json(ans);
end;
$$;


CREATE OR REPLACE FUNCTION public.classroom_resolve_prediction(p_answer_id uuid, p_actual double precision, p_correct_index integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  room_id uuid;
  ans     classroom_session_answers%rowtype;
  ok      boolean;
begin
  select s.classroom_id into room_id
  from classroom_session_answers a
  join classroom_sessions s on s.id = a.session_id
  where a.id = p_answer_id;

  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  select * into ans from classroom_session_answers where id = p_answer_id;
  if ans.resolved_at is not null then
    return row_to_json(ans);          -- already scored; idempotent
  end if;

  ok := (p_correct_index is not null and ans.class_index is not null
         and p_correct_index = ans.class_index);

  update classroom_session_answers
     set correct_index   = p_correct_index,
         is_correct      = ok,
         resolved_actual = p_actual,
         resolved_at     = now()
   where id = p_answer_id
  returning * into ans;

  -- A prediction is left out of asked_count until it settles (see
  -- setup-classroom-score-polls.sql), so it joins the tally here: asked
  -- now that it has an answer, and correct if the class called it.
  if p_correct_index is not null then
    update classroom_sessions
       set asked_count   = asked_count + 1,
           correct_count = correct_count + case when ok then 1 else 0 end
     where id = ans.session_id;
  end if;

  return row_to_json(ans);
end;
$$;


-- One-time recount. "Counted" means the same as the rule above, applied
-- to what is stored: a right answer is known, and the class answered or
-- the vote was closed (a split vote closes with no class answer and
-- still counts, as it always has).
update classroom_sessions s
   set asked_count   = t.asked,
       correct_count = t.correct
  from (select s2.id,
               count(a.id) filter (where a.correct_index is not null
                                     and (a.class_index is not null
                                          or a.vote_counts is not null)) as asked,
               count(a.id) filter (where a.is_correct)                   as correct
          from classroom_sessions s2
          left join classroom_session_answers a on a.session_id = s2.id
         group by s2.id) t
 where t.id = s.id
   and (s.asked_count <> t.asked or s.correct_count <> t.correct);

commit;
