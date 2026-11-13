-- ════════════════════════════════════════════════════════════════════
-- Classroom: quiz size, feedback housekeeping, recent-question memory
--
-- Run after setup-classrooms.sql and setup-classroom-feedback.sql.
-- Safe to re-run.
--
-- Three unrelated-looking changes that all come from the same place: a
-- classroom that uses this DAILY rather than once a week.
--
--  1. A daily class does not want eight questions, it wants one or two.
--     A weekly one wants six. That is a property of how a teacher runs
--     their room, so it belongs on the classroom rather than in a
--     constant in the page.
--
--  2. Daily use burns through the question set fast, and a class that
--     meets the same question on Tuesday that it met on Monday has
--     noticed the whole thing is on rails. The page can only avoid
--     repeats if it can find out what was already asked.
--
--  3. Feedback piles up faster too. Marking a batch as addressed in one
--     call is what keeps "what is new since I last looked" answerable.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. How many questions a session asks
--
-- Capped at 20: beyond that it is not a warm-up or a quiz, it is a
-- test, and the projector flow is not built for one. The floor of 1 is
-- the daily-warm-up case and is the reason this exists.
-- ────────────────────────────────────────────────────────────────────

alter table classrooms
  add column if not exists questions_per_session integer not null default 8;

do $$
begin
  alter table classrooms
    add constraint classrooms_questions_per_session_check
    check (questions_per_session between 1 and 20);
exception
  when duplicate_object then null;
end $$;

comment on column classrooms.questions_per_session is
  'How many questions a session asks. 1-2 for a daily warm-up, 6-8 for '
  'a weekly quiz.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Setting it
--
-- Its own function rather than another argument on classroom_update:
-- appending a defaulted parameter there would leave two overloads of
-- the same name and make PostgREST's named-argument calls ambiguous,
-- which is the trap the suggestions migration already had to dig out
-- of. classroom_require_manage carries the permission rule, so a
-- teacher can only ever reach their own classroom.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_set_quiz_size(
  p_classroom_id uuid,
  p_n            integer
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  if p_n is null or p_n < 1 or p_n > 20 then
    raise exception 'A session asks between 1 and 20 questions';
  end if;

  update classrooms set questions_per_session = p_n where id = p_classroom_id;

  select row_to_json(c) into result from classrooms c where c.id = p_classroom_id;
  return result;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. What this class has already been asked
--
-- Returns template ids used in this classroom's recent sessions, most
-- recent first, so the page can push them to the back of the queue
-- rather than repeating them. Template ids are not student data: no
-- nickname, no answer, nothing about a child, so this stays clear of
-- the COPPA rules the rest of the session tables live under.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_recent_templates(
  p_classroom_id uuid,
  p_days         integer default 14
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select coalesce(json_agg(t.template_id order by t.last_asked desc), '[]'::json)
    into result
  from (
    select a.template_id, max(a.asked_at) as last_asked
      from classroom_session_answers a
      join classroom_sessions s on s.id = a.session_id
     where s.classroom_id = p_classroom_id
       and a.asked_at > now() - (greatest(coalesce(p_days, 14), 1) || ' days')::interval
     group by a.template_id
  ) t;

  return result;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. Clearing a batch of feedback
--
-- The note is the point of it. "Addressed" with no record of HOW is
-- the same as deleting the row, and the next person to read the
-- template has no idea a teacher ever complained about it or what was
-- done. Owner/moderator only, same as the single-row resolve.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_feedback_resolve_bulk(
  p_ids  uuid[],
  p_note text default null
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  cids uuid[];
  n    integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- Every row has to belong to a community this user may act in, and
  -- they are checked BEFORE anything is written: a batch that spans two
  -- communities must not half-apply.
  select array_agg(distinct community_id) into cids
    from classroom_question_feedback where id = any(p_ids);

  if cids is null then
    return 0;
  end if;

  for n in 1 .. array_length(cids, 1) loop
    perform community_require_role(cids[n], auth.uid(),
                                   array['owner', 'moderator']);
  end loop;

  update classroom_question_feedback
     set resolved_at   = now(),
         resolved_by   = auth.uid(),
         resolved_note = nullif(trim(coalesce(p_note, '')), '')
   where id = any(p_ids)
     and resolved_at is null;

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. classroom_list, carrying the new column
--
-- Replaced verbatim from setup-classrooms.sql with one line added, so
-- the two cannot drift apart.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_list(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
  r      text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  r := community_role(p_community_id, auth.uid());

  select json_agg(row_to_json(t) order by t.created_at desc) into result
  from (
    select c.id,
           c.name,
           c.grade_band,
           c.question_scope,
           c.questions_per_session,
           c.home_feeder_id,
           f.display_name           as home_feeder_name,
           f.last_heartbeat_at      as home_feeder_seen_at,
           c.teacher_user_id,
           coalesce(nullif(p.display_name, ''), u.email, 'Teacher') as teacher_label,
           (c.teacher_user_id = auth.uid())                         as is_mine,
           c.created_at,
           coalesce((
             select json_agg(json_build_object(
                      'feeder_id',    pf.feeder_id,
                      'display_name', pfd.display_name)
                    order by pfd.display_name)
             from classroom_partner_feeders pf
             join feeders pfd on pfd.id = pf.feeder_id
             where pf.classroom_id = c.id
           ), '[]'::json)           as partners,
           (select max(s.started_at) from classroom_sessions s
             where s.classroom_id = c.id)                           as last_session_at,
           (select count(*) from classroom_sessions s
             where s.classroom_id = c.id)                           as session_count
    from classrooms c
    left join feeders       f on f.id = c.home_feeder_id
    left join user_profiles p on p.id = c.teacher_user_id
    left join auth.users    u on u.id = c.teacher_user_id
    where c.community_id = p_community_id
      and c.archived_at is null
      and (r in ('owner', 'moderator') or c.teacher_user_id = auth.uid())
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Grants
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_set_quiz_size(uuid, integer)',
    'classroom_recent_templates(uuid, integer)',
    'classroom_feedback_resolve_bulk(uuid[], text)',
    'classroom_list(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;
