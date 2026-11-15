-- ════════════════════════════════════════════════════════════════════
--  Previous lessons carry the template id, so the panel can name the
--  standards a lesson covered
-- ════════════════════════════════════════════════════════════════════
--
--  classroom_session_answers has stored template_id since the table was
--  written — it is `not null` there — but classroom_session_history never
--  returned it, because until now nothing on the client needed to know
--  WHICH question a row had been.
--
--  The alignment map (docs/js/classroom-alignment.js) is keyed by exactly
--  that id. Without it the "Florida standards covered" block under each
--  lesson in Previous Lessons can only ever be empty, and it would be
--  empty SILENTLY — every question would look unaligned, which is the one
--  failure mode that makes the feature actively misleading rather than
--  merely absent.
--
--  THE SIGNATURE IS UNCHANGED. ⚠
--  (uuid, integer), exactly as before. This is a genuine replacement, not
--  a second overload — which is the trap that took the challenge RPCs down
--  with PGRST203 "could not choose the best candidate function" and is
--  worth restating every time this file family is touched. Adding a
--  defaulted argument here would be a new function, not an edit.
--
--  THE RETURN SHAPE GROWS, COMPATIBLY.
--  One more key inside each question object. A client without this
--  deployed finds template_id undefined and renders no standards block,
--  which is what it does today; a client with it finds the id. Neither
--  deploy order breaks the other.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
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
                      -- The only new key. Everything else is byte-for-byte
                      -- what setup-classroom-history-lessons.sql returned.
                      'template_id',    a.template_id,
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
      -- A session is not a lesson until something was asked. Unchanged from
      -- the migration this replaces; repeated rather than inherited because
      -- create or replace rewrites the whole body.
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

-- One signature, or something has gone wrong. The challenge functions were
-- left with two for a fortnight and the only symptom was a live outage, so
-- this file refuses to commit rather than leave the question open.
do $$
declare n int;
begin
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'classroom_session_history';
  if n <> 1 then
    raise exception 'classroom_session_history has % signatures, expected 1 '
                    '— PostgREST will refuse named-argument calls', n;
  end if;
end $$;

commit;
