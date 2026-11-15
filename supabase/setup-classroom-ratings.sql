-- ════════════════════════════════════════════════════════════════════
-- Classroom: a teacher's thumbs up or down on a question
--
-- Run after setup-classrooms.sql. Safe to re-run. Nothing else depends
-- on it: the page asks for ratings, gets PGRST202 until this is pasted
-- in, and builds the lesson exactly as it did before.
--
-- Why this exists
-- ───────────────
-- "It would be nice if teachers could vote/rate a question, both live or
-- when reviewing and then the system can rank the questions and use that
-- for candidates for review or use in next sessions."
--
-- A teacher already had two ways to react to a question and both are too
-- heavy for the common case. Unticking a template in the picker removes
-- it for good, which is the wrong answer to "meh, not this one so
-- often". Flagging files a report somebody has to read, which is the
-- wrong answer to "my class loved that one". There was no way to say
-- either quickly, and no positive signal at all.
--
-- Shape of it
-- ───────────
-- ONE RATING PER CLASSROOM PER TEMPLATE, not per teacher. The rating is
-- about what suits this room, and the room is what the lesson is built
-- for; a moderator covering a lesson who taps thumbs-down is speaking
-- for that class for the day, and two people's votes on one class's
-- lesson averaging out to nothing would help nobody.
--
-- DELIBERATELY CLASSROOM-LOCAL. Nothing here ranks questions across a
-- school or across schools. That needs decisions this does not make —
-- whose rating counts, how one teacher is stopped from burying a good
-- question for everyone — and it should be designed from real ratings
-- once there are some, not guessed at before there are any.
--
-- The template ids are CLIENT-SIDE constants, so, as with template_picks,
-- the database stores short strings and checks only that they are sane.
-- A teacher's own question is rated by its 'teacher:<uuid>' id, the same
-- id the lesson and the session history already use for it.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- 1. The table
--
-- No row means no opinion. A rating of zero is never stored: clearing a
-- thumb deletes the row, so "neutral" has one representation and the
-- read path never has to ask which of two it is looking at.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classroom_question_ratings (
  classroom_id uuid not null references classrooms(id) on delete cascade,
  template_id  text not null check (length(template_id) between 1 and 80),
  rating       smallint not null check (rating in (-1, 1)),
  rated_by     uuid not null,
  updated_at   timestamptz not null default now(),
  primary key (classroom_id, template_id)
);

comment on table classroom_question_ratings is
  'A teacher''s thumbs up (1) or down (-1) on a question template for one '
  'classroom. Reorders that classroom''s lessons; never removes a question '
  'and never affects any other classroom.';

alter table classroom_question_ratings enable row level security;

drop policy if exists "Service role full access question ratings" on classroom_question_ratings;
create policy "Service role full access question ratings" on classroom_question_ratings
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 2. Setting it
--
-- classroom_require_manage is the permission rule, the same one the
-- picker uses: a rating changes what this class is asked, which is the
-- class teacher's call (or a moderator's), not any teacher who can see
-- the community.
--
-- Returns what is now stored, so the button the teacher pressed can show
-- the database's answer rather than the page's guess.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_rate_template(
  p_classroom_id uuid,
  p_template_id  text,
  p_rating       integer
)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare
  tid text := btrim(coalesce(p_template_id, ''));
begin
  perform classroom_require_manage(p_classroom_id);

  if length(tid) not between 1 and 80 then
    raise exception 'A question type is required';
  end if;
  if p_rating is null or p_rating not in (-1, 0, 1) then
    raise exception 'A rating is -1, 0 or 1';
  end if;

  if p_rating = 0 then
    delete from classroom_question_ratings
     where classroom_id = p_classroom_id and template_id = tid;
    return 0;
  end if;

  insert into classroom_question_ratings
    (classroom_id, template_id, rating, rated_by)
  values (p_classroom_id, tid, p_rating, auth.uid())
  on conflict (classroom_id, template_id) do update
    set rating = excluded.rating,
        rated_by = excluded.rated_by,
        updated_at = now();

  return p_rating;
end;
$$;

revoke execute on function classroom_rate_template(uuid, text, integer) from public;
revoke execute on function classroom_rate_template(uuid, text, integer) from anon;
grant  execute on function classroom_rate_template(uuid, text, integer) to authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 3. Reading them back
--
-- As one object, { "template-id": 1, ... }, because the only thing the
-- page ever does with them is look one up by id while ordering a lesson.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_template_ratings(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select coalesce(json_object_agg(template_id, rating), '{}'::json)
    into result
  from classroom_question_ratings
  where classroom_id = p_classroom_id;

  return result;
end;
$$;

revoke execute on function classroom_template_ratings(uuid) from public;
revoke execute on function classroom_template_ratings(uuid) from anon;
grant  execute on function classroom_template_ratings(uuid) to authenticated;
