-- ────────────────────────────────────────────────────────────────────
-- Partner feeders from outside the community: any PUBLIC feeder
--
-- Run after setup-classrooms.sql. Replaces classroom_partners_set only.
--
-- Asked for: "It would be more flexible to allow the classroom to choose
-- partner feeders regardless of community. They should just be obvious
-- which community they are part of (i.e. Roland Park / Public)."
--
-- The old rule was "approved in this community". The new rule is "approved
-- in this community, OR public". Not "any feeder the editor can see":
--
--   A partner is read by EVERY teacher who runs the class, with their own
--   access (loadClassroomData reads community_detections under the
--   caller's RLS). A private feeder from another community the editor
--   happens to belong to would show up for the editor and come back empty
--   for every other teacher at the school — a partner that silently does
--   nothing for the people it was set up for. A public feeder is readable
--   by anyone, so it means the same thing for every teacher, and nothing
--   is exposed that the public feed does not already show.
--
-- A public partner that later goes private just stops returning rows for
-- teachers outside its community; the home/partner fallback already treats
-- a quiet partner as quiet, so nothing breaks. The row stays, and saving
-- the class again (which re-sends the set) is what removes it.
--
-- classroom_teacher_question_save accepts a photo from any partner, so a
-- teacher's own question can now use a public partner's photo. That is
-- public data by definition, so it is left as it is.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_partners_set(
  p_classroom_id uuid,
  p_feeder_ids   uuid[]
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
  ids  uuid[];
begin
  room := classroom_require_manage(p_classroom_id);

  ids := coalesce(p_feeder_ids, '{}'::uuid[]);

  if array_length(ids, 1) > 10 then
    raise exception 'Up to 10 partner feeders per classroom';
  end if;

  if exists (
    select 1 from unnest(ids) as fid
    where fid = room.home_feeder_id
       or not (
         exists (
           select 1 from community_feeders cf
           where cf.community_id = room.community_id
             and cf.feeder_id    = fid
             and cf.status       = 'approved')
         or exists (
           select 1 from feeders f
           where f.id = fid and f.is_public)
       )
  ) then
    raise exception 'Partner feeders must be public feeders or approved feeders in this community';
  end if;

  delete from classroom_partner_feeders where classroom_id = p_classroom_id;

  insert into classroom_partner_feeders (classroom_id, feeder_id)
  select p_classroom_id, fid from unnest(ids) as fid
  on conflict do nothing;

  return coalesce((
    select json_agg(json_build_object('feeder_id', pf.feeder_id,
                                      'display_name', f.display_name)
                    order by f.display_name)
    from classroom_partner_feeders pf
    join feeders f on f.id = pf.feeder_id
    where pf.classroom_id = p_classroom_id
  ), '[]'::json);
end;
$$;
