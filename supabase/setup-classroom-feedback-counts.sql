-- ════════════════════════════════════════════════════════════════════
--  How much is waiting: open and closed counts for the feedback pile
-- ════════════════════════════════════════════════════════════════════
--
--  WHY THIS IS NOT PART OF classroom_feedback_list
--  The counts are wanted on the ROW in the left-hand column — "6 open ·
--  12 closed" under "Review flags & suggestions" — and that row is drawn
--  before anybody has clicked it. classroom_feedback_list only runs once
--  the row IS clicked, which is one click too late to put a number on it.
--
--  WHY NOT COUNT THE ROWS THE LIST ALREADY RETURNS
--  Because it would be wrong. classroom_feedback_list takes p_limit and
--  caps it at 500, so a school with 600 closed items would be told it has
--  500. A count has to be a count.
--
--  WHAT IT COSTS
--  Two filtered counts over one index scan on community_id, returned as
--  a four-field json object. Cheaper than the list it sits beside.
--
--  WHO CAN CALL IT
--  Exactly who can read the pile: owner, moderator, teacher — the same
--  community_require_role line as classroom_feedback_list, so the two can
--  never drift into disagreeing about who is allowed to look. Knowing
--  that twelve things were dealt with is not more sensitive than reading
--  the twelve things.
--
--  FAILS OPEN ON THE CLIENT, NOT HERE
--  community-classroom.js treats a missing function (PGRST202) as "no
--  counts to show" and falls back to the descriptive text that was on the
--  row before. So the page can ship before this file is applied and the
--  row simply reads as it always did — no error, no empty badge.
-- ════════════════════════════════════════════════════════════════════

begin;

create or replace function classroom_feedback_counts(p_community_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n_open   integer;
  n_closed integer;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  select count(*) filter (where resolved_at is null),
         count(*) filter (where resolved_at is not null)
    into n_open, n_closed
  from classroom_question_feedback
  where community_id = p_community_id;

  return json_build_object(
    'open',   coalesce(n_open,   0),
    'closed', coalesce(n_closed, 0));
end;
$function$;

-- Same shape as every other function in this folder: never anon, and the
-- role check above is what actually decides, not the grant.
revoke execute on function classroom_feedback_counts(uuid) from anon;
grant  execute on function classroom_feedback_counts(uuid) to authenticated;

commit;


-- ════════════════════════════════════════════════════════════════════
--  Check it:
--
--    select jsonb_pretty(classroom_feedback_counts('<community id>')::jsonb);
--
--  open + closed should equal
--    select count(*) from classroom_question_feedback
--     where community_id = '<community id>';
--
--  and an unauthenticated call should raise 'Sign-in required' rather
--  than returning zeroes — a zero would be a lie, not a refusal.
-- ════════════════════════════════════════════════════════════════════
