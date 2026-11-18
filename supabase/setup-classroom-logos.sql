-- ============================================================
-- BirdWatchAI Classroom — a logo for each class (or each child)
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql and setup-community-logos.sql.
--
-- WHAT
-- A class can have its own picture: a classroom mascot, a child's drawing
-- of a bird, a Home Classroom child's own badge. Shown beside the class's
-- name in the panel, on the board during its lessons, and on its take-home
-- card, journal and certificate. The community's logo (the school crest, or
-- a Home Classroom's) stays where it is; this is one level down.
--
-- WHERE IT LIVES
-- The same public community-logos bucket, under the community's folder:
--     <community id>/classes/<classroom id>/logo-<time>.png
-- so a class's picture is filed with its school's, and deleting a school's
-- folder takes its classes' pictures with it.
--
-- WHO MAY SET IT
-- Whoever manages the class: its teacher, or the community's owner or a
-- moderator (classroom_require_manage). Not only the owner, as for the
-- community logo: a teacher's class is theirs to decorate. The upload
-- policy is widened for exactly that one sub-folder and nothing else.
-- ============================================================

begin;

alter table classrooms add column if not exists logo_url text;
comment on column classrooms.logo_url is
  'Class logo. A public community-logos URL under <community>/classes/<this classroom>/, '
  'set via classroom_set_logo(); null = none.';

-- The community logo rule (owner of the folder's community), plus: a
-- classes/<classroom id>/ path inside it, for whoever manages that class.
create or replace function community_logo_upload_ok(p_object_name text, p_user_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  folder text;
  sub    text;
  room   text;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_user_id is null or p_object_name is null then
    return false;
  end if;
  folder := split_part(p_object_name, '/', 1);
  if folder !~ uuid_re then
    return false;
  end if;

  sub  := split_part(p_object_name, '/', 2);
  room := split_part(p_object_name, '/', 3);
  if sub = 'classes' then
    if room !~ uuid_re or split_part(p_object_name, '/', 4) = '' then
      return false;
    end if;
    return exists (
      select 1 from classrooms c
       where c.id = room::uuid
         and c.community_id = folder::uuid
         and (c.teacher_user_id = p_user_id
              or community_role(c.community_id, p_user_id) in ('owner', 'moderator')));
  end if;

  return community_role(folder::uuid, p_user_id) = 'owner';
end;
$$;
revoke execute on function community_logo_upload_ok(text, uuid) from public, anon;
grant  execute on function community_logo_upload_ok(text, uuid) to authenticated;

create or replace function classroom_set_logo(p_classroom_id uuid, p_logo_url text default null)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
begin
  room := classroom_require_manage(p_classroom_id);
  if p_logo_url is not null
     and p_logo_url !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/community-logos/'
                        || room.community_id::text || '/classes/' || room.id::text
                        || '/[A-Za-z0-9._-]+$') then
    raise exception 'classroom_set_logo: logo_url must be this class''s own community-logos URL';
  end if;
  update classrooms set logo_url = p_logo_url where id = room.id;
  return found;
end;
$$;
revoke execute on function classroom_set_logo(uuid, text) from public, anon;
grant  execute on function classroom_set_logo(uuid, text) to authenticated;

-- classroom_list as it is in production, plus logo_url.
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
           c.logo_url,
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
