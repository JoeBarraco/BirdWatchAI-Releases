-- ════════════════════════════════════════════════════════════════════
-- Classroom: letting a teacher choose which questions can come up
--
-- Run after setup-classrooms.sql and setup-classroom-cadence.sql.
-- Safe to re-run.
--
-- Why this exists
-- ───────────────
-- Until now a classroom's lesson was "whatever the engine can build from
-- this week, in its own order, cut to the session size". That is the
-- right default and it stays the default — a teacher who wants to open
-- the panel and press Start should never have to curate anything.
--
-- But it is the wrong ONLY option. A teacher covering telling-the-time
-- this fortnight wants the clock question every day; one who has not
-- taught percentages yet wants them to stay off the board; one running
-- this in an art room wants the art and identification questions and
-- none of the arithmetic. All three are asking the same thing: let me
-- say which questions this room can ask.
--
-- Shape of it
-- ───────────
-- A nullable array of template ids on the classroom. NULL — the default,
-- and what every existing classroom has — means "no restriction", which
-- is exactly the behaviour that was there before. A non-empty array
-- means "only these". There is deliberately no third state.
--
-- The ids themselves are CLIENT-SIDE constants (CLASSROOM_TEMPLATES in
-- community-classroom.js), so the database cannot validate them and does
-- not try. It stores a list of short strings and enforces only that the
-- list is sane in size. A pick naming a template that has since been
-- renamed simply never matches; the picker UI shows the teacher what is
-- actually selectable, which is where that gets noticed.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. The column
--
-- The cap is 400 rather than "the number of templates" because the
-- database has no way to know that number, and because the only thing
-- the cap is protecting against is somebody posting a megabyte of
-- strings. 400 is comfortably above any plausible template count and
-- comfortably below anything that matters.
-- ────────────────────────────────────────────────────────────────────

alter table classrooms
  add column if not exists template_picks text[];

-- Size and no-nulls only. A CHECK constraint may not contain a
-- subquery, so the per-element length rule cannot live here; it lives
-- in classroom_set_templates below, which is the only write path.
do $$
begin
  alter table classrooms
    add constraint classrooms_template_picks_check
    check (
      template_picks is null
      or (cardinality(template_picks) between 1 and 400
          and array_position(template_picks, null) is null)
    );
exception
  when duplicate_object then null;
end $$;

comment on column classrooms.template_picks is
  'Which question templates this classroom may ask, by client-side '
  'template id. NULL means no restriction, which is the default and the '
  'behaviour every classroom had before this column existed.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Setting it
--
-- Its own function, for the same reason classroom_set_quiz_size is its
-- own function: appending a defaulted argument to classroom_update
-- would leave two overloads of the same name, and PostgREST resolves
-- named-argument calls by matching the argument NAMES against the
-- candidates — two candidates that both match is an error, not a
-- preference. That trap has already cost this schema one migration.
--
-- An empty array and NULL both mean "no restriction". They arrive from
-- different places — NULL from a classroom that has never been curated,
-- an empty array from a teacher who has just unticked the last box —
-- and collapsing them here means the read path only ever has one case
-- to handle. A teacher who unticks everything gets the full set back,
-- which is the only sensible reading of "no questions allowed".
--
-- classroom_require_manage carries the permission rule, so a teacher
-- can only ever reach their own classroom and a moderator can reach any
-- in their community.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_set_templates(
  p_classroom_id uuid,
  p_template_ids text[]
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  cleaned text[];
begin
  perform classroom_require_manage(p_classroom_id);

  -- Trim, drop blanks and nulls, de-duplicate. A list arriving with the
  -- same id twice is not an error worth refusing a teacher's save over.
  select array_agg(distinct q.v) into cleaned
  from (
    select btrim(x) as v
    from unnest(coalesce(p_template_ids, '{}'::text[])) as x
  ) q
  where q.v is not null and length(q.v) between 1 and 80;

  if cleaned is null or cardinality(cleaned) = 0 then
    cleaned := null;                      -- no restriction
  elsif cardinality(cleaned) > 400 then
    raise exception 'That is more question types than a classroom can hold';
  end if;

  update classrooms
     set template_picks = cleaned
   where id = p_classroom_id;

  return found;
end;
$$;

revoke execute on function classroom_set_templates(uuid, text[]) from public;
revoke execute on function classroom_set_templates(uuid, text[]) from anon;
grant  execute on function classroom_set_templates(uuid, text[]) to authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 3. classroom_list, so the panel can read the picks back
--
-- Replaced verbatim from setup-classroom-cadence.sql with one line
-- added, so the two cannot drift apart. (That file in turn took it
-- verbatim from setup-classrooms.sql for the same reason.)
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
