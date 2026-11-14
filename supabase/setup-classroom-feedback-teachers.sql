-- ════════════════════════════════════════════════════════════════════
--  Teachers can read the feedback pile
-- ════════════════════════════════════════════════════════════════════
--
--  Teachers could always FILE feedback — classroom_flag_question and
--  classroom_suggest_question have accepted the teacher role since they
--  were written. What they could not do is see any of it again.
--
--  That made flagging feel like dropping something into a hole. A
--  teacher who flags a bad question gets no sign it arrived, no sign it
--  was dealt with, and no sign that the three colleagues down the
--  corridor flagged the same one last week. The predictable result is
--  that people stop flagging — which costs the question bank far more
--  than the privacy this was protecting.
--
--  WHAT CHANGES
--  classroom_feedback_list accepts 'teacher'. Resolving does NOT:
--  classroom_feedback_resolve and _resolve_bulk stay owner/moderator,
--  because deciding a complaint has been answered is a different act
--  from reading it.
--
--  WHO SAID IT
--  The original comment on this function was right that the list
--  "carries other teachers' words about questions they found
--  confusing — which is not something to spread wider than it needs to
--  go". The words are the useful part; the names are not. So a teacher
--  sees every item and every resolution, with authorship reduced to
--  'You' on their own and 'A colleague' on everyone else's. Owners and
--  moderators still see names, because they are the ones who may need
--  to go and ask.
--
--  can_resolve rides along in the payload so the client renders the
--  right buttons from what the server actually permits, rather than
--  re-deriving the rule and drifting from it.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;

create or replace function classroom_feedback_list(
  p_community_id uuid,
  p_include_resolved boolean default false,
  p_limit integer default 100
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  items json;
  tally json;
  r     text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  r := community_role(p_community_id, auth.uid());

  select json_agg(row_to_json(t) order by t.created_at desc) into items
  from (
    select f.id, f.template_id, f.category, f.grade_band, f.prompt,
           f.choices, f.correct_index, f.explain, f.chart_kind,
           f.kind, f.reason, f.comment, f.created_at, f.resolved_at, f.resolved_note,
           -- Own first, so an owner reading their own flag sees 'You'
           -- rather than their own display name, which reads oddly.
           case
             when f.created_by = auth.uid()     then 'You'
             when r in ('owner', 'moderator')
               then coalesce(nullif(p.display_name, ''), u.email, 'Someone')
             else 'A colleague'
           end as by_label,
           (f.created_by = auth.uid()) as is_mine,
           c.name as classroom_name
    from classroom_question_feedback f
    left join user_profiles p on p.id = f.created_by
    left join auth.users    u on u.id = f.created_by
    left join classrooms    c on c.id = f.classroom_id
    where f.community_id = p_community_id
      and (p_include_resolved or f.resolved_at is null)
    order by f.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) t;

  -- Which templates draw the most complaints, open ones only.
  select json_agg(row_to_json(g) order by g.n desc, g.template_id) into tally
  from (
    select template_id, count(*) as n
    from classroom_question_feedback
    where community_id = p_community_id and resolved_at is null
    group by template_id
  ) g;

  return json_build_object(
    'items',       coalesce(items, '[]'::json),
    'by_template', coalesce(tally, '[]'::json),
    'can_resolve', r in ('owner', 'moderator'),
    'my_role',     r);
end;
$$;

revoke execute on function classroom_feedback_list(uuid, boolean, integer) from public;
revoke execute on function classroom_feedback_list(uuid, boolean, integer) from anon;
grant  execute on function classroom_feedback_list(uuid, boolean, integer) to authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it, as a teacher would see it:
--
--    select jsonb_pretty(classroom_feedback_list('<community id>')::jsonb);
--
--  can_resolve should be false for a teacher and true for an owner or
--  moderator, and by_label should never show a colleague's name to a
--  teacher.
-- ════════════════════════════════════════════════════════════════════
