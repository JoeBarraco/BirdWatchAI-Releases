-- ════════════════════════════════════════════════════════════════════
--  A teacher's chart can cover the week its photo was taken
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS EXISTS
--  "When writing your own question, how do you get the chart data to align
--  with the timeframe the photo was taken? I can click on a picture of a
--  bird from 3 months ago, but the data is not necessarily applicable to
--  that time for the chart."
--
--  A teacher's chart stores its shape and series, never its numbers, and
--  was always drawn from the week the lesson runs. The photo picker reaches
--  back a term or a school year, so an August photo sat beside November's
--  chart. The editor now has "Chart covers": the week of the lesson (as
--  before, and the default) or the week the photo was taken. The second is
--  stored as chart_spec.window = 'photo'.
--
--  TWO CHANGES HERE:
--
--  1. classroom_teacher_questions_list returns the date and feeder of the
--     question's photo and clip (photo_at, photo_feeder_id, clip_at,
--     clip_feeder_id). The client fetches the seven days ending on that
--     date, from that feeder, when the lesson is built. Without these a
--     saved question has an image URL and nothing to anchor a week on.
--
--  2. The chart_spec check is rebuilt. It allowed only days, species and
--     hours, but the editor has offered "Each month this school year" since
--     the year charts went in, and saving one failed at this constraint.
--     It now allows 'months', and checks 'window' when one is present.
--
--  Before this is applied: saving a photo-week chart already works (the
--  old check ignores keys it does not name), but a saved one goes up with
--  no chart, because the client has no date to anchor it on. It never
--  falls back to the lesson's week, which would be the wrong numbers.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. The check
-- ────────────────────────────────────────────────────────────────────

alter table classroom_teacher_questions
  drop constraint if exists classroom_teacher_questions_chart_check;

alter table classroom_teacher_questions
  add constraint classroom_teacher_questions_chart_check
  check (chart_spec is null
         or (jsonb_typeof(chart_spec) = 'object'
             and (chart_spec ->> 'kind')
                   = any (array['bars', 'hbars', 'line', 'dots', 'donut', 'picto'])
             and (chart_spec ->> 'source')
                   = any (array['days', 'species', 'hours', 'months'])
             and (not (chart_spec ? 'window')
                  or (chart_spec ->> 'window') = any (array['lesson', 'photo']))));


-- ────────────────────────────────────────────────────────────────────
-- 2. The list, carrying where and when the media was taken
--
-- Replaced verbatim from what is live (pg_get_functiondef, 2026-11-16),
-- with four columns added.
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

  select json_agg(row_to_json(t) order by t.owned desc, t.created_at) into result
  from (
    select q.id, q.prompt, q.choices, q.correct_index, q.explain,
           q.detection_id, d.image_url,
           d.detected_at                              as photo_at,
           d.feeder_id                                as photo_feeder_id,
           q.clip_detection_id, c.video_url,
           c.detected_at                              as clip_at,
           c.feeder_id                                as clip_feeder_id,
           q.chart_spec, q.category, q.standards,
           q.shared, q.active, q.created_at, q.updated_at,
           (q.classroom_id = p_classroom_id)          as owned,
           own.name                                   as from_classroom
    from classroom_teacher_questions q
    left join community_detections d on d.id = q.detection_id
    left join community_detections c on c.id = q.clip_detection_id
    left join classrooms own on own.id = q.classroom_id
    where q.classroom_id = p_classroom_id
       or q.id in (select aq.question_id from classroom_adopted_questions aq
                    where aq.classroom_id = p_classroom_id)
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 3. Grants
--
-- ⚠ REVOKE FROM PUBLIC, NOT JUST FROM anon. See
-- setup-classroom-question-order.sql.
-- ────────────────────────────────────────────────────────────────────

revoke execute on function classroom_teacher_questions_list(uuid) from public;
revoke execute on function classroom_teacher_questions_list(uuid) from anon;
grant  execute on function classroom_teacher_questions_list(uuid) to authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select x->>'photo_at', x->>'photo_feeder_id'
--      from json_array_elements(classroom_teacher_questions_list('<id>')) x;
--
--  A question with a photo must have both. And a months chart must now
--  save:
--    update classroom_teacher_questions
--       set chart_spec = '{"kind":"bars","source":"months"}' where id = '<id>';
--  while '{"kind":"bars","source":"days","window":"later"}' must not.
-- ════════════════════════════════════════════════════════════════════
