-- ============================================================
-- BirdWatchAI Classroom — put the classes (or children) in your own order
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classroom-logos.sql (whose classroom_list this extends).
--
-- WHAT (asked for 2026-11-18)
-- The class list on the left of the Classroom panel was newest first,
-- always. A teacher, or a parent with three children, can now drag the
-- rows into whatever order they like, and the order is kept on the server
-- so it is the same on the classroom laptop and at home.
--
-- WHO CAN MOVE WHAT
-- classroom_set_order takes the classes in their new order and renumbers
-- exactly those, so a caller can only reorder classes they manage
-- (classroom_require_manage on every one, or nothing happens). A teacher
-- sees only their own classes, so that is all they can move; an owner or
-- moderator sees and orders the lot. A class nobody has placed yet
-- (sort_order null) goes after the placed ones, newest first, as before.
-- ============================================================

begin;

alter table classrooms add column if not exists sort_order int;

create or replace function classroom_set_order(p_classroom_ids uuid[])
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  i   int;
  cid uuid;
  community uuid;
begin
  if p_classroom_ids is null or cardinality(p_classroom_ids) = 0 then
    return false;
  end if;
  if cardinality(p_classroom_ids) > 200 then
    raise exception 'Too many classes to order at once';
  end if;
  if (select count(distinct x) from unnest(p_classroom_ids) x) <> cardinality(p_classroom_ids) then
    raise exception 'A class appears twice in the order';
  end if;
  -- Every one must be the caller's to manage, and all in one community.
  for i in 1 .. cardinality(p_classroom_ids) loop
    perform classroom_require_manage(p_classroom_ids[i]);
    select community_id into cid from classrooms where id = p_classroom_ids[i];
    if community is null then community := cid;
    elsif community <> cid then
      raise exception 'Those classes are in different communities';
    end if;
  end loop;
  for i in 1 .. cardinality(p_classroom_ids) loop
    update classrooms set sort_order = i where id = p_classroom_ids[i];
  end loop;
  return true;
end;
$$;
revoke execute on function classroom_set_order(uuid[]) from public, anon;
grant  execute on function classroom_set_order(uuid[]) to authenticated;

-- classroom_list as it is in production, ordered by sort_order and
-- returning it.
CREATE OR REPLACE FUNCTION public.classroom_list(p_community_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  result json;
  r      text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  r := community_role(p_community_id, auth.uid());

  select json_agg(row_to_json(t) order by t.sort_order nulls last, t.created_at desc) into result
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
           c.logo_url,
           c.sort_order,
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

commit;
