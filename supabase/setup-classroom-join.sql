-- ============================================================
-- BirdWatchAI Classroom Mode — phase 2: live join-code voting
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql. Purely additive to it: new columns on
-- classroom_sessions and classroom_session_answers, two new tables, and
-- one replaced function (classroom_session_start, which refused any
-- mode but 'teacher_led').
--
-- Design notes: "BirdWatch AI – Classroom Mode (design notes)" §9B and
-- §14 step 2. Teacher-led mode (§9A) is untouched and keeps working
-- exactly as before — the question screen is the same in both modes;
-- only where the answer comes from differs.
--
-- ── HOW A CLASS RUNS IN THIS MODE ───────────────────────────────────
--   1. Teacher starts a session; a 6-digit code goes up on the
--      projector.
--   2. Students open /join, type the code and a nickname, and get a
--      random token. No account, no password, no email.
--   3. Teacher puts a question up: classroom_question_open freezes it
--      into classroom_session_answers and points the session at it.
--   4. Devices poll classroom_poll and show prompt + buttons. The
--      PHOTO stays on the projector (§15) — student devices never
--      receive it, and never receive the correct answer either.
--   5. Teacher closes voting: classroom_question_close tallies the
--      votes, takes the plurality as the class's answer, scores it, and
--      stores the tally on the answer row.
--   6. Teacher ends the session: every nickname, token and individual
--      vote is DELETED. The per-question tallies survive because they
--      were folded into vote_counts in step 5.
--
-- ── WHY POLLING AND NOT REALTIME ────────────────────────────────────
-- The design notes say the teacher screen should subscribe via Supabase
-- Realtime, "same tech as remote support". Remote support does use
-- Realtime broadcast — but from the C# server and the tunnel, never
-- from the website: docs/js/ has no Supabase JS client and speaks plain
-- REST throughout (see the header of community-core.js). Three reasons
-- not to make a classroom the first browser Realtime client here:
--
--   * Hand-rolling the Phoenix channel protocol is a lot of new,
--     untested surface to put under a room full of children.
--   * postgres_changes on classroom_votes would need a SELECT policy on
--     the vote rows for anon — the opposite of what §8 asks for.
--   * A dropped poll is invisible and self-healing; a dropped websocket
--     needs reconnect logic that only gets exercised on bad school
--     wifi, which is where it would fail.
--
-- So: the teacher screen polls classroom_tally (one small row) and the
-- devices poll classroom_poll, both on a ~1.5s timer. A class of thirty
-- is about twenty requests a second against two indexed primary-key
-- lookups. If that ever stops being enough, the swap is confined to the
-- two poll loops in community-classroom-join.js.
--
-- SAFE TO RE-RUN.
-- ============================================================

create extension if not exists pgcrypto;


-- ────────────────────────────────────────────────────────────────────
-- 1. Columns on the phase-1 tables
-- ────────────────────────────────────────────────────────────────────

alter table classroom_sessions
  add column if not exists join_code         text,
  -- The question currently on the projector, and whether its buttons
  -- are live. Kept on the SESSION rather than derived from the answer
  -- rows because that is the single value every student device polls:
  -- "what am I looking at, and can I still vote?"
  add column if not exists current_answer_id uuid,
  add column if not exists voting_open       boolean not null default false;

-- Partial unique index, not a unique constraint. A 6-digit code has to
-- be reusable — there are only a million of them and a school will burn
-- through codes for years — so uniqueness has to hold only among
-- sessions that are still running.
create unique index if not exists idx_classroom_sessions_live_code
  on classroom_sessions(join_code)
  where join_code is not null and ended_at is null;

alter table classroom_session_answers
  -- The tally, frozen at the moment voting closed: [{"i":0,"n":4},…].
  -- This is why the individual votes can be deleted at the end of class
  -- without losing the teacher's record of how the room split.
  add column if not exists vote_counts       jsonb,
  add column if not exists participant_count integer;


-- ────────────────────────────────────────────────────────────────────
-- 2. Participants and votes
--
-- PRIVACY (design notes §8). These are the only two tables in classroom
-- mode that hold anything about a student, and both are emptied by
-- classroom_session_end. A nickname is all that is ever collected — no
-- name, no email, no account, no device identifier. The token is a
-- random bearer string with no meaning outside its session.
--
-- Deliberately NOT stored: anything that would let two sessions be
-- linked to the same child. A new session means a new token and a
-- nickname typed fresh; there is no identifier that survives the bell.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classroom_participants (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references classroom_sessions(id) on delete cascade,
  nickname     text not null,
  token        text not null unique default encode(gen_random_bytes(18), 'hex'),
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists idx_classroom_participants_session
  on classroom_participants(session_id);

create table if not exists classroom_votes (
  id             uuid primary key default gen_random_uuid(),
  answer_id      uuid not null references classroom_session_answers(id) on delete cascade,
  participant_id uuid not null references classroom_participants(id)    on delete cascade,
  choice_index   integer not null,
  voted_at       timestamptz not null default now(),
  -- One vote per student per question. A child who taps B and then
  -- changes their mind to C should end up with one vote for C, not one
  -- of each — and a device with a flaky connection that retries must
  -- not stuff the ballot.
  unique (answer_id, participant_id)
);

create index if not exists idx_classroom_votes_answer
  on classroom_votes(answer_id);


-- ────────────────────────────────────────────────────────────────────
-- 3. RLS
--
-- Same posture as phase 1: no SELECT policy for anon or authenticated,
-- everything through SECURITY DEFINER RPCs. This matters more here than
-- anywhere else in classroom mode, because the student-facing functions
-- are callable with the publishable key. A SELECT policy on
-- classroom_session_answers that let a device read its own question
-- would also let it read correct_index — the answer key, handed to the
-- class on a plate. The RPC returns a chosen subset of columns instead.
-- ────────────────────────────────────────────────────────────────────

alter table classroom_participants enable row level security;
alter table classroom_votes        enable row level security;

drop policy if exists "Service role full access classroom participants" on classroom_participants;
create policy "Service role full access classroom participants" on classroom_participants
  for all to service_role using (true) with check (true);

drop policy if exists "Service role full access classroom votes" on classroom_votes;
create policy "Service role full access classroom votes" on classroom_votes
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 4. Starting a session, now with a join code
--
-- Replaces the phase-1 version in setup-classrooms.sql §7, which
-- refused any mode but 'teacher_led'. Everything else about it is
-- unchanged, including closing sessions left open on this classroom.
-- ────────────────────────────────────────────────────────────────────

/**
 * Pick a 6-digit code not currently in use by a live session.
 *
 * ON THE SIZE OF THE CODE. Six digits is a million possibilities, which
 * is not a secret — somebody determined could script their way into a
 * session. That is accepted deliberately: the code has to be readable
 * off a projector and typed by a six-year-old, the thing being guarded
 * is the right to vote in a quiz about birds, and the code stops
 * working the moment the teacher ends the class. What the design does
 * NOT do is let a guess reach anything else: a participant token grants
 * exactly one session's questions and nothing about the community, the
 * feeder, the other classrooms or any other child.
 *
 * The participant cap below is the real protection — it bounds how much
 * noise a successful guess can make, and a teacher who sees forty
 * nicknames in a class of twenty-five can just end the session and
 * start another with a fresh code.
 */
create or replace function classroom_new_join_code()
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  code  text;
  tries integer := 0;
begin
  loop
    code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (
      select 1 from classroom_sessions
      where join_code = code and ended_at is null
    );
    tries := tries + 1;
    if tries > 50 then
      -- Fifty collisions means something is very wrong (a million codes
      -- and a handful of live sessions), so fail loudly rather than
      -- spinning.
      raise exception 'Could not allocate a join code; too many sessions are open';
    end if;
  end loop;
  return code;
end;
$$;

-- How many people may join one session. A generous class size, not a
-- tight one: a double class in the hall is a real thing, and a cap that
-- bites during an actual lesson is worse than one that bites a script.
create or replace function classroom_participant_cap()
returns integer language sql immutable as $$ select 60 $$;

create or replace function classroom_session_start(
  p_classroom_id uuid,
  p_mode         text default 'teacher_led'
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  sess classroom_sessions%rowtype;
  mode text := coalesce(p_mode, 'teacher_led');
begin
  perform classroom_require_manage(p_classroom_id);

  if mode not in ('teacher_led', 'join_code') then
    raise exception 'Unknown session mode: %', mode;
  end if;

  -- Ending the stragglers also retires their join codes, which is what
  -- frees the code space and stops a device left running in another
  -- room from polling a session nobody is in.
  update classroom_sessions
     set ended_at = now(), voting_open = false
   where classroom_id = p_classroom_id and ended_at is null;

  insert into classroom_sessions (classroom_id, mode, started_by, join_code)
  values (p_classroom_id, mode, auth.uid(),
          case when mode = 'join_code' then classroom_new_join_code() end)
  returning * into sess;

  return row_to_json(sess);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. Teacher: open a question, tally it, close it
--
-- In teacher-led mode the answer row is created when the teacher taps
-- (classroom_session_record, phase 1, untouched). In join-code mode it
-- has to exist BEFORE anyone can vote on it, so the two paths differ
-- here and only here.
-- ────────────────────────────────────────────────────────────────────

/**
 * Put a question up for voting.
 *
 * Takes the same question object as classroom_session_record. The
 * correct answer is stored — the devices simply never get a function
 * that returns it.
 *
 * asked_count is NOT incremented here. A question that goes up and is
 * then skipped because the fire alarm goes off was not asked, and the
 * session's score should not say it was. The count moves in
 * classroom_question_close.
 */
create or replace function classroom_question_open(
  p_session_id uuid,
  p_question   jsonb
)
returns json
language plpgsql security definer
set search_path = public
as $$
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

  insert into classroom_session_answers (
    session_id, template_id, category, grade_band, scope,
    prompt, choices, correct_index,
    source_feeder_id, detection_id, pending_check, resolve_after)
  values (
    p_session_id,
    coalesce(p_question->>'template_id', 'unknown'),
    coalesce(p_question->>'category',    'unknown'),
    coalesce(p_question->>'grade_band',  'k-2'),
    coalesce(p_question->>'scope',       'home'),
    p_question->>'prompt',
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


/**
 * The live tally, for the teacher's bar chart. Polled while voting is
 * open, so it is deliberately one cheap aggregate over an indexed
 * column and returns nothing else.
 */
create or replace function classroom_tally(p_answer_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
  result  json;
begin
  select s.classroom_id into room_id
  from classroom_session_answers a
  join classroom_sessions s on s.id = a.session_id
  where a.id = p_answer_id;
  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  select json_build_object(
    'answer_id', p_answer_id,
    'votes',     coalesce((
        select json_agg(json_build_object('i', choice_index, 'n', n) order by choice_index)
        from (select choice_index, count(*) as n
              from classroom_votes where answer_id = p_answer_id
              group by choice_index) c), '[]'::json),
    'voted',     (select count(*) from classroom_votes where answer_id = p_answer_id),
    'joined',    (select count(*) from classroom_participants p
                  join classroom_session_answers a on a.id = p_answer_id
                  where p.session_id = a.session_id)
  ) into result;

  return result;
end;
$$;


/**
 * Close voting and score the question.
 *
 * The class's answer is the PLURALITY — what most of the room picked.
 * On a tie, or with no votes at all, class_index stays null and the
 * question counts as asked but not correct: a split room has not agreed
 * on an answer, and silently awarding it to whichever choice sorts
 * first would put words in the class's mouth.
 *
 * p_class_index lets the teacher override — the room argues, the
 * teacher makes the call — and is how a tie gets resolved out loud.
 */
create or replace function classroom_question_close(
  p_answer_id   uuid,
  p_class_index integer default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
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
         asked_count   = asked_count + 1,
         correct_count = correct_count + case when ok then 1 else 0 end
   where id = ans.session_id;

  return row_to_json(ans);
end;
$$;


/**
 * The lobby list: who has joined, for the screen that is up while the
 * class is still typing the code in. Nicknames only — there is nothing
 * else to show, by design.
 */
create or replace function classroom_participants_list(p_session_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
  result  json;
begin
  select classroom_id into room_id from classroom_sessions where id = p_session_id;
  if room_id is null then
    raise exception 'Session not found';
  end if;
  perform classroom_require_manage(room_id);

  select json_agg(nickname order by joined_at) into result
  from classroom_participants where session_id = p_session_id;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Students — the only functions callable with the publishable key
--
-- Everything below is reachable by anyone on the internet holding the
-- anon key, which ships in every install. They are written on that
-- assumption:
--
--   * A valid join code is the only way in, and it only works while a
--     session is live.
--   * A token addresses exactly one participant in one session.
--   * No function here returns correct_index, a photo, a feeder id, a
--     community id, a classroom id, another participant's token, or
--     anything about any other session.
--   * Nothing here can write outside the session its token belongs to.
-- ────────────────────────────────────────────────────────────────────

/**
 * Join a session with a code and a nickname.
 *
 * The nickname is squeezed hard: trimmed, control characters stripped,
 * capped at 20 characters. It goes on a projector in front of a class,
 * so the cap is as much about layout as safety — and every render site
 * escapes it anyway.
 *
 * Returns a fresh token every time, including for a nickname that is
 * already in the room. Two children called Sam are two participants; a
 * nickname is a label, never an identity, and treating a repeat as a
 * returning user would hand Sam's vote to whoever typed it second.
 */
create or replace function classroom_join(
  p_code     text,
  p_nickname text
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  sess classroom_sessions%rowtype;
  nick text;
  n    integer;
  p    classroom_participants%rowtype;
begin
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    raise exception 'That code does not look right — it is six digits.';
  end if;

  select * into sess from classroom_sessions
   where join_code = trim(p_code) and ended_at is null
   limit 1;

  if sess.id is null then
    -- Same message for "wrong code" and "class is over", so the
    -- function cannot be used to discover which codes are live.
    raise exception 'No class is running with that code.';
  end if;

  nick := regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', '', 'g');
  nick := trim(nick);
  if nick = '' then
    raise exception 'Pick a nickname first.';
  end if;
  nick := left(nick, 20);

  select count(*) into n from classroom_participants where session_id = sess.id;
  if n >= classroom_participant_cap() then
    raise exception 'This class is full.';
  end if;

  insert into classroom_participants (session_id, nickname)
  values (sess.id, nick)
  returning * into p;

  return json_build_object(
    'token',    p.token,
    'nickname', p.nickname);
end;
$$;


/**
 * What should this device be showing right now?
 *
 * The one function a student's browser calls on a timer. It returns the
 * current question's prompt and choices and nothing else — no
 * correct_index, no image, no ids beyond the question's own, which the
 * device needs to vote.
 *
 * Also the device's heartbeat: it touches last_seen_at, which is what
 * the teacher's "24 of 26 connected" reading is built from.
 */
create or replace function classroom_poll(p_token text)
returns json
language plpgsql security definer
set search_path = public
as $$
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
    'choices',   ans.choices,
    'has_image', ans.detection_id is not null,
    'my_vote',   mine);
end;
$$;


/**
 * Cast or change a vote.
 *
 * Changeable right up until the teacher closes voting, which is what
 * the unique constraint on (answer_id, participant_id) plus this
 * upsert gives. A child who taps the wrong button and says so should be
 * able to fix it without the teacher reopening anything.
 */
create or replace function classroom_vote(
  p_token        text,
  p_answer_id    uuid,
  p_choice_index integer
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  p    classroom_participants%rowtype;
  sess classroom_sessions%rowtype;
  ans  classroom_session_answers%rowtype;
begin
  select * into p from classroom_participants where token = p_token;
  if p.id is null then
    raise exception 'You are not in a class right now.';
  end if;

  select * into sess from classroom_sessions where id = p.session_id;
  if sess.id is null or sess.ended_at is not null then
    raise exception 'The class has finished.';
  end if;
  if not sess.voting_open then
    raise exception 'Voting is closed for this question.';
  end if;

  -- The answer must be the one THIS session currently has open. Without
  -- this a token could vote on any question id it happened to learn,
  -- including one belonging to another classroom.
  if sess.current_answer_id is distinct from p_answer_id then
    raise exception 'That question is not the one on the board.';
  end if;

  select * into ans from classroom_session_answers where id = p_answer_id;
  if ans.id is null then
    raise exception 'Question not found';
  end if;
  if p_choice_index is null
     or p_choice_index < 0
     or p_choice_index >= jsonb_array_length(coalesce(ans.choices, '[]'::jsonb)) then
    raise exception 'That is not one of the choices.';
  end if;

  insert into classroom_votes (answer_id, participant_id, choice_index)
  values (p_answer_id, p.id, p_choice_index)
  on conflict (answer_id, participant_id) do update
    set choice_index = excluded.choice_index,
        voted_at     = now();

  update classroom_participants set last_seen_at = now() where id = p.id;

  return json_build_object('ok', true, 'my_vote', p_choice_index);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 7. Ending a session deletes the student data
--
-- Design notes §8: "delete session data when the session ends". This is
-- that, and it replaces the phase-1 classroom_session_end.
--
-- What goes: every nickname, every token, every individual vote.
-- What stays: the questions, the class's collective answer, and the
-- per-question tallies — none of which say anything about a particular
-- child, and all of which the teacher needs next week.
--
-- The delete is unconditional rather than opt-in. A teacher who forgets
-- to tick a box is the normal case, so the safe thing has to be the
-- thing that happens by default.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_session_end(p_session_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
  sess    classroom_sessions%rowtype;
  purged  integer;
begin
  select classroom_id into room_id from classroom_sessions where id = p_session_id;
  if room_id is null then
    raise exception 'Session not found';
  end if;
  perform classroom_require_manage(room_id);

  -- Any question still open gets closed and scored first, so a session
  -- ended mid-question still records what the room had voted. Doing it
  -- the other way round would delete the votes before they counted.
  update classroom_sessions set voting_open = false where id = p_session_id;

  perform classroom_question_close(a.id)
  from classroom_session_answers a
  where a.session_id = p_session_id
    and a.class_index is null
    and a.vote_counts is null
    and exists (select 1 from classroom_votes v where v.answer_id = a.id);

  delete from classroom_votes v
   using classroom_session_answers a
   where v.answer_id = a.id and a.session_id = p_session_id;

  delete from classroom_participants where session_id = p_session_id;
  get diagnostics purged = row_count;

  update classroom_sessions
     set ended_at          = coalesce(ended_at, now()),
         voting_open       = false,
         current_answer_id = null,
         -- Retiring the code is what makes it reusable and stops a
         -- device left open in a bag from polling all afternoon.
         join_code         = null
   where id = p_session_id
  returning * into sess;

  return json_build_object('session', row_to_json(sess), 'purged_participants', purged);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 8. Housekeeping
--
-- A session nobody ended — the laptop lid went down, the tab was
-- closed — still holds nicknames. Phase 1 closed stragglers when the
-- next session started on the same classroom, which is enough to keep
-- the join code free but leaves the student data sitting there until
-- that classroom runs again. For data that §8 says to delete at the end
-- of the lesson, "whenever we next happen to need the code" is not good
-- enough.
--
-- Run it from a scheduled job (pg_cron: `select classroom_sweep();`
-- hourly) or leave it — community-classroom-join.js also calls it when
-- a teacher opens the panel, which covers the realistic case of a
-- forgotten session being cleaned up the next school day.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_sweep(p_older_than interval default interval '6 hours')
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  n integer := 0;
  s record;
begin
  for s in
    select id from classroom_sessions
    where ended_at is null and started_at < now() - p_older_than
  loop
    -- Deliberately does NOT call classroom_session_end: that function
    -- scores any still-open question, and scoring needs a teacher's
    -- auth.uid() for the permission check. A swept session is one
    -- nobody closed, so its last question goes unscored — the votes are
    -- deleted either way, and inventing a result for a lesson that was
    -- abandoned mid-question would be worse than leaving a gap.
    update classroom_sessions set ended_at = now() where id = s.id;

    delete from classroom_votes v
     using classroom_session_answers a
     where v.answer_id = a.id and a.session_id = s.id;
    delete from classroom_participants where session_id = s.id;

    update classroom_sessions
       set voting_open = false, current_answer_id = null, join_code = null
     where id = s.id;

    n := n + 1;
  end loop;
  return n;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 9. Grants
--
-- The split that matters: three functions are reachable with the
-- publishable key (the student ones), everything else needs a real
-- signed-in session. classroom_sweep is authenticated-only too — it is
-- called from the teacher's panel, and an anon-callable "delete things"
-- function is a gift to anyone holding the anon key even when it only
-- deletes what it should.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  -- Teacher / staff only.
  foreach f in array array[
    'classroom_session_start(uuid, text)',
    'classroom_question_open(uuid, jsonb)',
    'classroom_question_close(uuid, integer)',
    'classroom_tally(uuid)',
    'classroom_participants_list(uuid)',
    'classroom_session_end(uuid)',
    'classroom_sweep(interval)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;

  -- Students: no account, so these must work with the publishable key.
  foreach f in array array[
    'classroom_join(text, text)',
    'classroom_poll(text)',
    'classroom_vote(text, uuid, integer)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant  execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- Internal helpers: called only from the functions above.
revoke execute on function classroom_new_join_code()   from public;
revoke execute on function classroom_new_join_code()   from anon;
revoke execute on function classroom_new_join_code()   from authenticated;
revoke execute on function classroom_participant_cap() from public;
revoke execute on function classroom_participant_cap() from anon;
