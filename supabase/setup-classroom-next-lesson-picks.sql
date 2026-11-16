-- ════════════════════════════════════════════════════════════════════
--  Put a question in the next lesson, or take it out
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--  Sort decides which questions make the lesson's cut. Asked for directly:
--  "what if I want a particular question promoted or demoted to/from the
--  upcoming lesson." Review now has ↑ Put in and ↓ Take out on each
--  question, and these are where those picks are kept.
--
--  FOR THE NEXT LESSON ONLY. A pick that never expired would be a second,
--  hidden question picker, and the real one is right there. So the picks
--  carry the time they were last changed, and classroom_list stops
--  returning them once any question has been ASKED in this classroom after
--  that time. Asked, not merely a session started: opening the board and
--  being called away before a question goes up leaves an empty session
--  row behind (see the note in showClassroomHistory), and that is not the
--  lesson the teacher picked for.
--
--  Nothing is ever cleared by a lesson. Expiry is worked out on read, so
--  there is no write on the lesson's path that could fail or be forgotten,
--  and the next pick after expiry simply starts again from empty.
--
--  KEYED BY template_id, the same id ratings and the recent list use.
--
--  ⚠ ITS OWN FUNCTION, for the overload reason setup-classroom-question-
--  order.sql gives.
--
--  Before this is applied the client keeps working: classroom_list carries
--  no picks, so nothing is overruled, and a pick fails to save, puts the
--  list back, and says so.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. The columns
-- ────────────────────────────────────────────────────────────────────

alter table classrooms
  add column if not exists next_lesson_picks    jsonb,
  add column if not exists next_lesson_picks_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'classrooms_next_lesson_picks_check') then
    alter table classrooms
      add constraint classrooms_next_lesson_picks_check
      check (next_lesson_picks is null
             or (jsonb_typeof(next_lesson_picks) = 'object'
                 and pg_column_size(next_lesson_picks) < 32768));
  end if;
end $$;

comment on column classrooms.next_lesson_picks is
  '{"in": [template_id, ...], "out": [template_id, ...]}: questions a '
  'teacher put into or took out of the next lesson in Review. Read through '
  'classroom_list, which drops them once a question has been asked after '
  'next_lesson_picks_at.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Still live?
--
-- True when nothing has been asked in this classroom since the picks were
-- set. One place for the rule, used by the setter and by classroom_list.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_next_lesson_picks_live(
  p_classroom_id uuid,
  p_at           timestamptz
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select p_at is not null
     and not exists (
           select 1
             from classroom_session_answers a
             join classroom_sessions s on s.id = a.session_id
            where s.classroom_id = p_classroom_id
              and a.asked_at > p_at);
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. Setting one
--
-- One question at a time: 'in', 'out', or '' to let the sort decide again.
-- Returns the picks as they now stand, which the client takes over its own
-- guess. Expired picks are dropped here rather than carried forward.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_set_next_lesson_pick(
  p_classroom_id uuid,
  p_template_id  text,
  p_pick         text
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  tid  text;
  pk   text;
  cur  jsonb;
  at   timestamptz;
  ins  jsonb;
  outs jsonb;
  res  jsonb;
begin
  perform classroom_require_manage(p_classroom_id);

  tid := btrim(coalesce(p_template_id, ''));
  if tid = '' or char_length(tid) > 200 then
    raise exception 'Unknown question';
  end if;

  pk := lower(btrim(coalesce(p_pick, '')));
  if pk not in ('', 'in', 'out') then
    raise exception 'Unknown pick: %', p_pick;
  end if;

  select next_lesson_picks, next_lesson_picks_at
    into cur, at
    from classrooms
   where id = p_classroom_id
   for update;

  if cur is null or not classroom_next_lesson_picks_live(p_classroom_id, at) then
    cur := '{}'::jsonb;
  end if;

  -- This question out of both lists, then into the one asked for, so a
  -- question is never both in and out.
  select coalesce(jsonb_agg(t.v), '[]'::jsonb) into ins
    from jsonb_array_elements_text(coalesce(cur -> 'in', '[]'::jsonb)) as t(v)
   where t.v <> tid;
  select coalesce(jsonb_agg(t.v), '[]'::jsonb) into outs
    from jsonb_array_elements_text(coalesce(cur -> 'out', '[]'::jsonb)) as t(v)
   where t.v <> tid;

  if pk = 'in'  then ins  := ins  || to_jsonb(tid); end if;
  if pk = 'out' then outs := outs || to_jsonb(tid); end if;

  if jsonb_array_length(ins) > 100 or jsonb_array_length(outs) > 300 then
    raise exception 'Too many questions picked';
  end if;

  res := case when jsonb_array_length(ins) = 0 and jsonb_array_length(outs) = 0
              then null
              else jsonb_build_object('in', ins, 'out', outs) end;

  update classrooms
     set next_lesson_picks    = res,
         next_lesson_picks_at = case when res is null then null else now() end
   where id = p_classroom_id;

  return res::json;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. classroom_list, carrying the live picks
--
-- Replaced verbatim from what is live (pg_get_functiondef, 2026-11-16),
-- with one expression added. The lesson reads its room from this list.
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
           case when c.next_lesson_picks is not null
                 and classroom_next_lesson_picks_live(c.id, c.next_lesson_picks_at)
                then c.next_lesson_picks end                        as next_lesson_picks,
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
-- 5. Grants
--
-- ⚠ REVOKE FROM PUBLIC, NOT JUST FROM anon. See
-- setup-classroom-question-order.sql. The liveness helper is internal:
-- it is security definer and takes any classroom id, so nobody outside
-- the two functions above gets to call it.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_set_next_lesson_pick(uuid, text, text)',
    'classroom_list(uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;

  execute 'revoke execute on function classroom_next_lesson_picks_live(uuid, timestamptz) from public';
  execute 'revoke execute on function classroom_next_lesson_picks_live(uuid, timestamptz) from anon';
  execute 'revoke execute on function classroom_next_lesson_picks_live(uuid, timestamptz) from authenticated';
end $$;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select classroom_set_next_lesson_pick('<classroom id>', 'count-total', 'in');
--    select classroom_set_next_lesson_pick('<classroom id>', 'count-total', 'out');
--  The second must move it from "in" to "out", not leave it in both.
--    select classroom_set_next_lesson_pick('<classroom id>', 'count-total', '');
--  must return null and clear both columns.
--
--    select has_function_privilege('anon',
--             'classroom_set_next_lesson_pick(uuid, text, text)', 'execute');
--    select has_function_privilege('authenticated',
--             'classroom_next_lesson_picks_live(uuid, timestamptz)', 'execute');
--  must both be false.
-- ════════════════════════════════════════════════════════════════════
