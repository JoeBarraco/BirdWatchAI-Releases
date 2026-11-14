-- ════════════════════════════════════════════════════════════════════
--  Previous lessons returns LESSONS, not sessions
-- ════════════════════════════════════════════════════════════════════
--
--  A classroom_sessions row is created the moment the board goes up — the
--  join code and every answer hang off it — so a teacher who opens one and
--  is interrupted leaves a row behind with nothing in it. On a real class,
--  four of eight rows were those.
--
--  The client already hides them. This file fixes the part the client
--  cannot: the limit. classroom_session_history returns the 50 most recent
--  SESSIONS, so a class with a habit of abandoned boards was spending its
--  budget on them and losing real lessons off the end of its history, with
--  nothing saying so. Filtering here means 50 means 50 lessons.
--
--  THE RETURN SHAPE CHANGES, COMPATIBLY.
--  It returned a bare json array. It now returns
--
--      { "lessons": [ ...same rows... ], "empty_count": <int> }
--
--  so the panel can go on saying "the board went up 4 other times with no
--  question asked" rather than quietly dropping them. The client accepts
--  BOTH shapes — an array from a server without this migration, an object
--  from one with it — so neither deploy order breaks the other and this can
--  be applied before or after the site updates.
--
--  empty_count counts every abandoned session for the class, not just the
--  ones that would have fitted in the window. "You have left the board up
--  and taught nothing 30 times" is the useful version of that number.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run. The signature is unchanged, so this is a
--  genuine replacement rather than a second overload.
-- ════════════════════════════════════════════════════════════════════

begin;

create or replace function classroom_session_history(
  p_classroom_id uuid,
  p_limit        integer default 10
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
  empties int;
begin
  perform classroom_require_manage(p_classroom_id);

  select count(*) into empties
    from classroom_sessions s
   where s.classroom_id = p_classroom_id
     and not exists (select 1 from classroom_session_answers a
                      where a.session_id = s.id);

  select json_agg(row_to_json(t) order by t.started_at desc) into result
  from (
    select s.id, s.started_at, s.ended_at, s.asked_count, s.correct_count,
           coalesce((
             select json_agg(json_build_object(
                      'id',             a.id,
                      'asked_at',       a.asked_at,
                      'category',       a.category,
                      'prompt',         a.prompt,
                      'choices',        a.choices,
                      'correct_index',  a.correct_index,
                      'class_index',    a.class_index,
                      'is_correct',     a.is_correct,
                      'pending',        (a.pending_check is not null and a.resolved_at is null),
                      'resolved_actual', a.resolved_actual)
                    order by a.asked_at)
             from classroom_session_answers a
             where a.session_id = s.id
           ), '[]'::json) as questions
    from classroom_sessions s
    where s.classroom_id = p_classroom_id
      -- A session is not a lesson until something was asked. The scoreboard
      -- has drawn this line since it was written; this is the same line.
      and exists (select 1 from classroom_session_answers a
                   where a.session_id = s.id)
    order by s.started_at desc
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ) t;

  return json_build_object(
    'lessons',     coalesce(result, '[]'::json),
    'empty_count', empties);
end;
$$;

revoke execute on function classroom_session_history(uuid, integer) from public;
revoke execute on function classroom_session_history(uuid, integer) from anon;
grant  execute on function classroom_session_history(uuid, integer) to authenticated;

commit;
