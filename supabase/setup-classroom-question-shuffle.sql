-- ════════════════════════════════════════════════════════════════════
--  A fresh Random every time it is picked
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--  Random was seeded by the classroom and the day and nothing else, so it
--  was one shuffle per room per day. Picking it again drew the same order,
--  and so did switching away and back. Asked for directly: "Make Random
--  reshuffle each time I pick it, including the first question."
--
--  The shuffle cannot simply be live-random. Review and the lesson have to
--  draw the SAME order, because review is where the teacher sees which
--  questions the class will get, and they run at different times, often on
--  different screens. So each pick writes a new seed to the classroom, and
--  both read it from there. Same seed, same list, same shuffle.
--
--  ⚠ ITS OWN FUNCTION, NOT A NEW ARGUMENT ON classroom_set_question_order,
--  for the reason setup-classroom-question-order.sql gives: a defaulted
--  extra argument leaves two overloads of one name, and PostgREST cannot
--  choose between two candidates that both match a named-argument call.
--
--  ⚠ THE CLIENT MAKES THE SEED, NOT THE SERVER. That lets review draw the
--  new order the moment the teacher picks it, and only keep it once the
--  save comes back. A server-made seed would need a round trip before the
--  list could move. The seed is not a secret and chooses nothing but an
--  order, so trusting the caller with it costs nothing. It is still
--  length-checked so the column cannot be used as storage.
--
--  Before this is applied the client keeps working: the save fails, review
--  keeps the order it had, and Random stays one shuffle per day.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. The column
-- ────────────────────────────────────────────────────────────────────

alter table classrooms
  add column if not exists question_order_seed text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'classrooms_question_order_seed_check') then
    alter table classrooms
      add constraint classrooms_question_order_seed_check
      check (question_order_seed is null
             or char_length(question_order_seed) between 1 and 64);
  end if;
end $$;

comment on column classrooms.question_order_seed is
  'Seed for this classroom''s Random question order, replaced each time a '
  'teacher picks Random. Review and the lesson both shuffle with it, so '
  'they agree. NULL means the order is seeded by the day alone.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Setting it
--
-- Same permission rule as classroom_set_question_order: a teacher can
-- reach their own classroom, a moderator any in their community.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_set_question_order_seed(
  p_classroom_id uuid,
  p_seed         text
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  cleaned text;
begin
  perform classroom_require_manage(p_classroom_id);

  cleaned := nullif(btrim(coalesce(p_seed, '')), '');
  if cleaned is not null and char_length(cleaned) > 64 then
    raise exception 'Question order seed is too long';
  end if;

  update classrooms
     set question_order_seed = cleaned
   where id = p_classroom_id;

  return true;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. classroom_list, carrying the new column
--
-- Replaced verbatim from what is live (pg_get_functiondef, 2026-11-16),
-- with one line added. The lesson reads its room from this list, so a
-- seed it did not carry would leave the board on the old shuffle while
-- review showed the new one.
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
           c.question_order_seed,
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
-- ⚠ REVOKE FROM PUBLIC, NOT JUST FROM anon. See
-- setup-classroom-question-order.sql: anon inherits EXECUTE from PUBLIC.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_set_question_order_seed(uuid, text)',
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
--    select classroom_set_question_order_seed('<classroom id>', 'abc123');
--    select id, name, question_order, question_order_seed
--      from classrooms where id = '<id>';
--
--  '' must store NULL. 65 characters must raise.
--
--    select has_function_privilege('anon',
--             'classroom_set_question_order_seed(uuid, text)', 'execute');
--  must be false.
-- ════════════════════════════════════════════════════════════════════
