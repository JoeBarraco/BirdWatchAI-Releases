-- ════════════════════════════════════════════════════════════════════
-- Classroom: questions a teacher writes for their own class
--
-- Run after setup-classrooms.sql. Safe to re-run.
--
-- Why this exists
-- ───────────────
-- Until now every question on the board came from a template, and a
-- teacher who wanted a different one could only suggest it: the note went
-- into the feedback digest and waited for somebody to write the template.
-- That is the right path for a question every class should get, and it
-- stays. It is the wrong path for "we read about owls this morning, ask
-- them which bird hunts at night" — a question for one class, this week,
-- that nobody else needs and that should not wait on anyone.
--
-- Shape of it
-- ───────────
-- One row per question, belonging to ONE classroom. Not shared across a
-- teacher's classes and not across the school: a question written for a
-- kindergarten would be wrong for the sixth grade down the corridor, and
-- the grade band is a property of the classroom, so tying the question to
-- the classroom carries its band with it for free.
--
-- A question is a prompt, two to four answers, which one is right, an
-- optional line for the reveal, and optionally a photo from the class's
-- own feeder. Off/on is a flag rather than a delete, so a question used
-- in the autumn can come back in the spring.
--
-- The photo is stored as a DETECTION ID, never a URL. The server checks
-- the detection came from this classroom's home or partner feeder, so the
-- projector can only ever show a photograph the class's own camera took —
-- not an address somebody typed. The image is looked up again on every
-- read, which also means a private school feeder's snapshot goes through
-- the same signing the rest of the lesson uses.
--
-- Every write goes through a function that starts with
-- classroom_require_manage, so the permission rule is the one that already
-- governs the classroom: its own teacher, or a moderator or owner of the
-- school. Not every teacher in the school.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. The table
--
-- The limits are on the table as well as in the functions. The functions
-- give a teacher a readable message; the CHECKs are what stops a bad row
-- arriving by any other path. Prompt length sits well under the 500 that
-- classroom_session_record accepts, so a question that saved can always
-- be recorded when the class answers it.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classroom_teacher_questions (
  id            uuid primary key default gen_random_uuid(),
  classroom_id  uuid not null references classrooms(id) on delete cascade,

  prompt        text not null check (length(prompt) between 1 and 300),
  choices       text[] not null
                  check (cardinality(choices) between 2 and 4
                         and array_position(choices, null) is null),
  correct_index integer not null
                  check (correct_index >= 0 and correct_index < cardinality(choices)),
  explain       text check (explain is null or length(explain) <= 400),

  -- Nullable, and SET NULL rather than CASCADE: the photo being swept by
  -- media retention must not take the teacher's question with it. The
  -- question simply goes back to having no picture.
  detection_id  uuid,

  active        boolean not null default true,

  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_classroom_teacher_questions_room
  on classroom_teacher_questions(classroom_id, created_at);

-- The foreign key to detections is added separately so the file still
-- applies where community_detections is absent (the test harness). In
-- production the table is always there.
do $$
begin
  if to_regclass('public.community_detections') is not null then
    begin
      alter table classroom_teacher_questions
        add constraint classroom_teacher_questions_detection_fk
        foreign key (detection_id) references community_detections(id)
        on delete set null;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- Same posture as the rest of classroom mode: no client reads the table
-- directly; everything goes through the functions below.
alter table classroom_teacher_questions enable row level security;

drop policy if exists "Service role full access teacher questions" on classroom_teacher_questions;
create policy "Service role full access teacher questions" on classroom_teacher_questions
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 2. Reading them
--
-- Oldest first, so the list a teacher sees does not reshuffle every time
-- they add one. image_url comes from the detection at read time — see the
-- header for why a URL is never stored.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_teacher_questions_list(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select json_agg(row_to_json(t) order by t.created_at) into result
  from (
    select q.id, q.prompt, q.choices, q.correct_index, q.explain,
           q.detection_id, d.image_url, q.active, q.created_at, q.updated_at
    from classroom_teacher_questions q
    left join community_detections d on d.id = q.detection_id
    where q.classroom_id = p_classroom_id
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. Saving one — new when p_id is null, an edit otherwise
--
-- One function for both, because the validation is the whole of the
-- work and two copies of it would drift.
--
-- Answers are trimmed and compared case-insensitively for duplicates:
-- "Robin" and "robin " offered side by side is a question with two
-- right answers, which is the exact bug a template once shipped.
--
-- Sixty per classroom is far beyond a term of use; the cap only exists
-- so a stuck button cannot fill the table.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_teacher_question_save(
  p_classroom_id  uuid,
  p_id            uuid,
  p_prompt        text,
  p_choices       text[],
  p_correct_index integer,
  p_explain       text,
  p_detection_id  uuid
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room     classrooms%rowtype;
  prompt_t text := btrim(coalesce(p_prompt, ''));
  explain_t text := nullif(btrim(coalesce(p_explain, '')), '');
  cleaned  text[];
  n        integer;
  row_out  classroom_teacher_questions%rowtype;
begin
  room := classroom_require_manage(p_classroom_id);

  if prompt_t = '' then
    raise exception 'Write the question first';
  end if;
  if length(prompt_t) > 300 then
    raise exception 'That question is too long for the board (300 characters at most)';
  end if;
  if explain_t is not null and length(explain_t) > 400 then
    raise exception 'The reveal note is too long (400 characters at most)';
  end if;

  -- Trim every answer and keep their ORDER, because p_correct_index
  -- points into it. A blank answer is refused rather than dropped:
  -- dropping it would silently move the right answer.
  select array_agg(btrim(coalesce(x, '')) order by i) into cleaned
  from unnest(coalesce(p_choices, '{}'::text[])) with ordinality as u(x, i);

  n := coalesce(cardinality(cleaned), 0);
  if n < 2 or n > 4 then
    raise exception 'A question needs between two and four answers';
  end if;
  if exists (select 1 from unnest(cleaned) c where c = '') then
    raise exception 'One of the answers is blank';
  end if;
  if exists (select 1 from unnest(cleaned) c where length(c) > 80) then
    raise exception 'An answer is too long (80 characters at most)';
  end if;
  if (select count(distinct lower(c)) from unnest(cleaned) c) <> n then
    raise exception 'Two of the answers are the same';
  end if;
  if p_correct_index is null or p_correct_index < 0 or p_correct_index >= n then
    raise exception 'Pick which answer is right';
  end if;

  -- The photo must be one this classroom's own feeders took.
  if p_detection_id is not null then
    if not exists (
      select 1 from community_detections d
      where d.id = p_detection_id
        and (d.feeder_id = room.home_feeder_id
             or d.feeder_id in (select pf.feeder_id
                                from classroom_partner_feeders pf
                                where pf.classroom_id = room.id))
    ) then
      raise exception 'That photo is not from this class''s feeders';
    end if;
  end if;

  if p_id is null then
    if (select count(*) from classroom_teacher_questions
        where classroom_id = room.id) >= 60 then
      raise exception 'This class already has 60 questions of its own — delete one first';
    end if;

    insert into classroom_teacher_questions
      (classroom_id, prompt, choices, correct_index, explain, detection_id, created_by)
    values
      (room.id, prompt_t, cleaned, p_correct_index, explain_t, p_detection_id, auth.uid())
    returning * into row_out;
  else
    update classroom_teacher_questions
       set prompt = prompt_t, choices = cleaned, correct_index = p_correct_index,
           explain = explain_t, detection_id = p_detection_id, updated_at = now()
     where id = p_id and classroom_id = room.id
    returning * into row_out;

    -- Same message as a classroom that does not exist: an id from another
    -- class is not this caller's business.
    if row_out.id is null then
      raise exception 'Question not found';
    end if;
  end if;

  return row_to_json(row_out);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. On/off, and delete
--
-- Both take only the question id and find the classroom from it, so the
-- permission check runs against the question's REAL classroom rather
-- than one the caller names.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_teacher_question_set_active(
  p_id     uuid,
  p_active boolean
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
begin
  select classroom_id into room_id from classroom_teacher_questions where id = p_id;
  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  update classroom_teacher_questions
     set active = coalesce(p_active, true), updated_at = now()
   where id = p_id;
  return found;
end;
$$;

create or replace function classroom_teacher_question_delete(p_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  room_id uuid;
begin
  select classroom_id into room_id from classroom_teacher_questions where id = p_id;
  if room_id is null then
    raise exception 'Question not found';
  end if;
  perform classroom_require_manage(room_id);

  delete from classroom_teacher_questions where id = p_id;
  return found;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. Grants — signed-in callers only; the functions do the rest
-- ────────────────────────────────────────────────────────────────────

revoke execute on function classroom_teacher_questions_list(uuid) from public, anon;
grant  execute on function classroom_teacher_questions_list(uuid) to authenticated;

revoke execute on function classroom_teacher_question_save(uuid, uuid, text, text[], integer, text, uuid) from public, anon;
grant  execute on function classroom_teacher_question_save(uuid, uuid, text, text[], integer, text, uuid) to authenticated;

revoke execute on function classroom_teacher_question_set_active(uuid, boolean) from public, anon;
grant  execute on function classroom_teacher_question_set_active(uuid, boolean) to authenticated;

revoke execute on function classroom_teacher_question_delete(uuid) from public, anon;
grant  execute on function classroom_teacher_question_delete(uuid) to authenticated;

commit;
