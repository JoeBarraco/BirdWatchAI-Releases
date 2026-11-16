-- ════════════════════════════════════════════════════════════════════
--  The order a classroom's questions are asked in
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--  Review questions has had a Sort control for a while, and its own
--  tooltip admitted what it did not do: "Reorders this list only. What
--  the class is actually asked is unchanged." A teacher who sorts a list
--  of the questions their class is about to be asked reasonably expects
--  to have changed something. Asked for directly: a Random option, and
--  "when I change the order it should update [the lesson] as well."
--
--  So the sort stops being a view and becomes a setting. It is stored on
--  the classroom, review draws in it, and buildClassroomQuestions
--  applies it to the lesson — one order, decided in the one place the
--  teacher can see every question at once.
--
--  THE FOUR VALUES, and null meaning 'lesson'
--    lesson  the careful default: identification opens, the teacher's
--            new questions next, recent repeats to the back, thumbs
--            applied last. Null means this — every classroom that
--            existed before this column did has exactly the behaviour it
--            had yesterday, with no backfill.
--    best    highest-rated across the school first.
--    worst   lowest first, which is the one a teacher wanting to FIND
--            the weak questions asks for.
--    random  shuffled, and deliberately ignoring all of the above.
--
--  ⚠ ITS OWN FUNCTION, NOT A NEW ARGUMENT ON classroom_update, for the
--  reason setup-classroom-picks.sql already paid for once: appending a
--  defaulted argument leaves two overloads of the same name, and
--  PostgREST resolves named-argument calls by matching argument NAMES
--  against the candidates. Two candidates that both match is an error,
--  not a preference.
--
--  ⚠ THE CHECK CONSTRAINT IS NOT VALIDATED AGAINST EXISTING ROWS on
--  purpose — there are none to validate, the column is new — but it is
--  there so a future caller cannot write 'shuffle' or 'Random' and have
--  the client silently fall back to lesson order without anyone seeing
--  it happen. The function cleans its input too; the constraint is the
--  backstop for anything that reaches the table another way.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. The column
-- ────────────────────────────────────────────────────────────────────

alter table classrooms
  add column if not exists question_order text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'classrooms_question_order_check') then
    alter table classrooms
      add constraint classrooms_question_order_check
      check (question_order is null
             or question_order in ('lesson', 'best', 'worst', 'random'));
  end if;
end $$;

comment on column classrooms.question_order is
  'How this classroom''s lesson orders its questions: lesson | best | '
  'worst | random. NULL means lesson, which is the behaviour every '
  'classroom had before this column existed.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Setting it
--
-- classroom_require_manage carries the permission rule, so a teacher
-- can only ever reach their own classroom and a moderator can reach any
-- in their community. Same guard classroom_set_templates uses.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_set_question_order(
  p_classroom_id uuid,
  p_order        text
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  cleaned text;
begin
  perform classroom_require_manage(p_classroom_id);

  cleaned := lower(btrim(coalesce(p_order, '')));

  -- 'lesson' and the empty string both mean "the default", and they
  -- arrive from different places: 'lesson' from the dropdown, blank
  -- from a caller clearing the setting. Storing NULL for both means the
  -- read path has one case, not three.
  if cleaned in ('', 'lesson') then
    cleaned := null;
  elsif cleaned not in ('best', 'worst', 'random') then
    raise exception 'Unknown question order: %', p_order;
  end if;

  update classrooms
     set question_order = cleaned
   where id = p_classroom_id;

  return true;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. classroom_list, carrying the new column
--
-- Replaced verbatim from what is live, with one line added, so the two
-- cannot drift apart. (Taken from pg_get_functiondef rather than from
-- a file in this folder: setup-classroom-cadence.sql holds an older
-- copy of this function that has no template_picks in it, and building
-- on that one would drop the curated question lists.)
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
           c.template_picks,
           c.question_order,
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
-- 4. Grants
--
-- ⚠ REVOKE FROM PUBLIC, NOT JUST FROM anon. `create function` grants
-- EXECUTE to PUBLIC by default and anon inherits from PUBLIC, so
-- revoking from anon alone leaves =X/postgres sitting in the ACL and
-- the role still holds the privilege through the back door. Checked by
-- reading proacl back, not by trusting the revoke.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_set_question_order(uuid, text)',
    'classroom_list(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select classroom_set_question_order('<classroom id>', 'random');
--    select id, name, question_order from classrooms where id = '<id>';
--
--  'lesson' and '' must both store NULL. 'Shuffle' must raise.
--
--  And the ACL, which is the part that has been wrong before:
--    select has_function_privilege('anon',
--             'classroom_set_question_order(uuid, text)', 'execute');
--  must be false.
-- ════════════════════════════════════════════════════════════════════
