-- ============================================================
-- BirdWatchAI Classroom — Español on the students' own devices too
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classroom-join.sql.
--
-- WHY (2026-11-18)
-- With Español on (classroom-spanish.js), the board shows a Spanish line
-- under the question and each answer, but a student answering on a phone
-- in join-code mode only got the English. Now the board sends the Spanish
-- with the question and the phones show it too.
--
-- HOW
-- The Spanish answers ride inside the choices themselves ({label, es}),
-- which classroom_poll already returns exactly as stored, so they need
-- nothing here. The Spanish QUESTION needs a column: prompt_es on
-- classroom_session_answers, written by classroom_question_open and
-- returned by classroom_poll. Both functions are production's own, with
-- only those lines added. Null whenever the class has Español off.
-- ============================================================

begin;

alter table classroom_session_answers add column if not exists prompt_es text;

CREATE OR REPLACE FUNCTION public.classroom_question_open(p_session_id uuid, p_question jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  room_id uuid;
  ans     classroom_session_answers%rowtype;
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
  if jsonb_array_length(coalesce(p_question->'choices', '[]'::jsonb)) > 8 then
    raise exception 'Too many choices for one question';
  end if;

  if length(coalesce(p_question->>'prompt_es', '')) > 600 then
    raise exception 'Spanish prompt is too long';
  end if;

  insert into classroom_session_answers (
    session_id, template_id, category, grade_band, scope,
    prompt, prompt_es, choices, correct_index,
    source_feeder_id, detection_id, pending_check, resolve_after)
  values (
    p_session_id,
    coalesce(p_question->>'template_id', 'unknown'),
    coalesce(p_question->>'category',    'unknown'),
    coalesce(p_question->>'grade_band',  'k-2'),
    coalesce(p_question->>'scope',       'home'),
    p_question->>'prompt',
    nullif(p_question->>'prompt_es', ''),
    coalesce(p_question->'choices', '[]'::jsonb),
    nullif(p_question->>'correct_index', '')::integer,
    nullif(p_question->>'source_feeder_id', '')::uuid,
    nullif(p_question->>'detection_id',     '')::uuid,
    case when jsonb_typeof(coalesce(p_question->'pending_check', 'null'::jsonb)) = 'object'
         then p_question->'pending_check' else null end,
    nullif(p_question->>'resolve_after', '')::timestamptz)
  returning * into ans;

  update classroom_sessions
     set current_answer_id = ans.id, voting_open = true
   where id = p_session_id;

  return row_to_json(ans);
end;
$$;

CREATE OR REPLACE FUNCTION public.classroom_poll(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  p    classroom_participants%rowtype;
  sess classroom_sessions%rowtype;
  ans  classroom_session_answers%rowtype;
  mine integer;
begin
  select * into p from classroom_participants where token = p_token;
  if p.id is null then
    return json_build_object('state', 'gone');
  end if;

  select * into sess from classroom_sessions where id = p.session_id;
  if sess.id is null or sess.ended_at is not null then
    return json_build_object('state', 'ended');
  end if;

  update classroom_participants set last_seen_at = now() where id = p.id;

  if sess.current_answer_id is null then
    return json_build_object('state', 'waiting', 'nickname', p.nickname);
  end if;

  select * into ans from classroom_session_answers where id = sess.current_answer_id;
  if ans.id is null then
    return json_build_object('state', 'waiting', 'nickname', p.nickname);
  end if;

  select choice_index into mine
  from classroom_votes where answer_id = ans.id and participant_id = p.id;

  -- Note what is NOT in this object. correct_index, detection_id,
  -- source_feeder_id and the photo all stay server-side; a child's
  -- phone is the last place the answer key should be.
  return json_build_object(
    'state',     case when sess.voting_open then 'question' else 'closed' end,
    'nickname',  p.nickname,
    'answer_id', ans.id,
    'prompt',    ans.prompt,
    'prompt_es', ans.prompt_es,
    'choices',   ans.choices,
    'has_image', ans.detection_id is not null,
    'my_vote',   mine);
end;
$$;

commit;
