-- ════════════════════════════════════════════════════════════════════
-- Classroom: how the rest of the school rated a question
--
-- Run after setup-classroom-ratings.sql. Safe to re-run. Nothing else
-- depends on it: review asks for the counts, gets PGRST202 until this is
-- pasted in, and draws exactly as it did before — no tallies, and the
-- sort control has nothing to sort by.
--
-- Why this exists
-- ───────────────
-- "I think other teachers should see the ratings of the questions (how
-- many ups/downs). Also, perhaps there should be an optional sort by
-- ratings?"
--
-- setup-classroom-ratings.sql deliberately stopped short of this. A
-- thumb reordered one classroom's lessons and was visible to nobody
-- else, because ranking across a school needs decisions that should come
-- from real ratings rather than a guess: whose rating counts, and how
-- one teacher is stopped from burying a good question for everyone.
--
-- This answers the first of those and sidesteps the second. The counts
-- are REPORTED, never applied: a teacher reviewing a lesson can see that
-- four other classes liked a question, and nothing about that number
-- changes what any class is asked. Lesson building still honours one
-- thumb and one only — the room's own. A school tally cannot override
-- what a class teacher chose for their room, so there is no way for one
-- teacher to bury a question for anybody but themselves.
--
-- Shape of it
-- ───────────
-- ONE OBJECT, { "template-id": {"up": n, "down": n}, ... }, because the
-- only thing the page does with it is look one up by id while drawing a
-- question and while scoring the sort.
--
-- A COUNT IS CLASSES, NOT TEACHERS. The ratings table is keyed
-- (classroom_id, template_id), so each class contributes at most one up
-- or one down. A teacher who runs four classes can put four of them on
-- the same question, and the number is honest about that only if the
-- page says "classes". It does.
--
-- WITHIN ONE SCHOOL. p_community_id is the whole reach of a tally.
-- Nothing here reads across communities, so one school's opinion of a
-- question is invisible to every other and cannot sway it. Cross-school
-- ranking remains the deferred problem it was.
--
-- ARCHIVED CLASSES ARE LEFT OUT. A school that archives a year's classes
-- each June would otherwise carry their tallies forever, and a question
-- would read as well-liked on the strength of rooms that no longer run.
-- This is a judgement call rather than a necessity: deleting the
-- `and c.archived_at is null` line below restores the lifetime tally,
-- and nothing else has to change.
-- ════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────
-- Reading the school's tallies
--
-- The same permission rule classroom_feedback_list uses: anyone who is
-- staff in this community may read them. A tally says nothing about who
-- rated what — only how many classes went each way — so there is nothing
-- here for a teacher to learn about a colleague's opinion of them.
--
-- Templates nobody has rated are absent rather than present as zeroes.
-- "No opinion" and "0 up, 0 down" are the same fact, and the page draws
-- nothing at all for it, so sending it would be bytes that only have to
-- be filtered out again.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_template_rating_counts(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  select coalesce(json_object_agg(t.template_id,
                                  json_build_object('up', t.up, 'down', t.down)),
                  '{}'::json)
    into result
  from (
    select r.template_id,
           count(*) filter (where r.rating > 0) as up,
           count(*) filter (where r.rating < 0) as down
      from classroom_question_ratings r
      join classrooms c on c.id = r.classroom_id
     where c.community_id = p_community_id
       and c.archived_at is null
     group by r.template_id
  ) t;

  return result;
end;
$$;

revoke execute on function classroom_template_rating_counts(uuid) from public;
revoke execute on function classroom_template_rating_counts(uuid) from anon;
grant  execute on function classroom_template_rating_counts(uuid) to authenticated;
