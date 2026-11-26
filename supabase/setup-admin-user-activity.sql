-- ════════════════════════════════════════════════════════════════════
--  Admin: who is using BirdWatchAI, and when they last did anything
-- ════════════════════════════════════════════════════════════════════
--
--  The admin panel listed moderators and communities but never the people
--  using the site, so "has this teacher signed in since we set them up?"
--  meant opening the Supabase dashboard. This puts one row per account in
--  the admin panel: when they joined, when they last signed in, what they
--  belong to, and how much they have done.
--
--  READ-ONLY, AND NOTHING NEW IS COLLECTED. ⚠
--  Every figure here is something the database already holds for its own
--  reasons: auth.users keeps last_sign_in_at, moderator_sessions keeps
--  each mod login, and comments, reactions, flags, follows, feedback and
--  teacher questions all carry created_at. A real activity log (page views,
--  a daily "last active" touch) was deliberately left for later: teachers
--  at real schools use this, and collecting more about them should wait
--  until this view shows what is actually missing.
--
--  "LAST SIGNED IN" IS NOT "LAST ACTIVE". last_sign_in_at only moves on a
--  fresh sign-in; a session refresh does not touch it, so someone who
--  stays signed in for weeks looks absent. last_activity_at is the latest
--  of every dated thing they did (including their feeders checking in),
--  which is the better answer to "are they still using it?".
--
--  ADMIN ONLY, through the moderator session token, exactly like
--  moderator_list_users and community_admin_list. It returns email
--  addresses, so it must never be callable without that check.
--
--  Students never appear: classroom devices are anonymous
--  classroom_participants, not accounts.
-- ════════════════════════════════════════════════════════════════════

drop function if exists admin_list_user_activity(text);

create or replace function admin_list_user_activity(p_token text)
returns json
language plpgsql security definer
-- Explicit search_path; see the note on community_admin_create in
-- setup-communities.sql. `auth` is read by qualified name below.
set search_path = public, extensions
as $$
declare
  admin_role text;
  result     json;
begin
  admin_role := moderator_session_role(p_token);

  -- A dead token is reported as expired, not as "not an admin". The other
  -- admin RPCs fold the two together, which told a lapsed admin they weren't
  -- one; the client now copes with that, but there is no reason for a new
  -- function to repeat it.
  if admin_role is null then
    raise exception 'Invalid or expired moderator session';
  end if;
  if admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;

  -- Each source is aggregated per user in its own CTE and then joined once.
  -- Joining the raw tables directly would multiply rows (3 comments x 4
  -- reactions = 12 rows) and every count would come out wrong.
  with
  comments as (
    select user_id, count(*) n, max(created_at) last_at
      from detection_comments group by user_id),
  -- detection_reactions.user_id is text, because anonymous visitors react
  -- under a browser id rather than an account. Only uuid-shaped ids can be
  -- accounts, and comparing as text avoids a cast error on the rest.
  reactions as (
    select user_id, count(*) n, max(created_at) last_at
      from detection_reactions group by user_id),
  flags as (
    select user_id, count(*) n, max(created_at) last_at
      from detection_flags group by user_id),
  follows as (
    select user_id, count(*) n, max(created_at) last_at
      from feeder_follows group by user_id),
  feedback as (
    select created_by as user_id, count(*) n, max(created_at) last_at
      from classroom_question_feedback group by created_by),
  questions as (
    select created_by as user_id, count(*) n,
           max(greatest(created_at, coalesce(updated_at, created_at))) last_at
      from classroom_teacher_questions group by created_by),
  life as (
    select user_id, count(*) n, max(created_at) last_at
      from user_life_list group by user_id),
  -- A feeder checking in is not the person doing something, but for a
  -- feeder owner it is the clearest sign the setup is still running, which
  -- is usually what the admin is really asking.
  feeders_owned as (
    select o.user_id, count(*) n, max(f.last_heartbeat_at) last_at
      from feeder_owners o
      join feeders f on f.id = o.feeder_id
     group by o.user_id),
  memberships as (
    select m.user_id,
           json_agg(json_build_object('name', c.name, 'role', m.role)
                    order by c.name) list,
           max(m.created_at) last_at
      from community_members m
      join communities c on c.id = m.community_id
     group by m.user_id),
  teaching as (
    select teacher_user_id as user_id,
           json_agg(name order by name) list
      from classrooms
     where archived_at is null and teacher_user_id is not null
     group by teacher_user_id),
  -- Moderators sign in through their own login, which never touches
  -- auth.users.last_sign_in_at, so their latest session is read separately
  -- and matched to the account by email.
  mod_logins as (
    select lower(mo.email) as email, mo.role, max(s.created_at) last_at
      from moderators mo
      left join moderator_sessions s on s.moderator_id = mo.id
     group by lower(mo.email), mo.role)
  select coalesce(json_agg(row_to_json(x) order by x.last_activity_at desc nulls last), '[]'::json)
    into result
    from (
      select u.id,
             u.email,
             nullif(trim(p.display_name), '')   as display_name,
             u.created_at                       as joined_at,
             u.last_sign_in_at,
             ml.role                            as mod_role,
             ml.last_at                         as last_mod_login_at,
             coalesce(mb.list, '[]'::json)      as communities,
             coalesce(t.list,  '[]'::json)      as classrooms,
             coalesce(fo.n, 0)                  as feeder_count,
             fo.last_at                         as last_feeder_checkin_at,
             coalesce(cm.n, 0)                  as comment_count,
             coalesce(rx.n, 0)                  as reaction_count,
             coalesce(fl.n, 0)                  as flag_count,
             coalesce(fw.n, 0)                  as follow_count,
             coalesce(fb.n, 0)                  as feedback_count,
             coalesce(q.n,  0)                  as question_count,
             coalesce(lf.n, 0)                  as life_list_count,
             -- greatest() ignores nulls in Postgres, so a user who has only
             -- ever signed in still gets that as their last activity.
             greatest(u.last_sign_in_at, ml.last_at, fo.last_at, mb.last_at,
                      cm.last_at, rx.last_at, fl.last_at, fw.last_at,
                      fb.last_at, q.last_at, lf.last_at) as last_activity_at
        from auth.users u
        left join user_profiles p  on p.id = u.id
        left join mod_logins   ml  on ml.email = lower(u.email)
        left join memberships  mb  on mb.user_id = u.id
        left join teaching     t   on t.user_id  = u.id
        left join feeders_owned fo on fo.user_id = u.id
        left join comments     cm  on cm.user_id = u.id
        left join reactions    rx  on rx.user_id = u.id::text
        left join flags        fl  on fl.user_id = u.id
        left join follows      fw  on fw.user_id = u.id
        left join feedback     fb  on fb.user_id = u.id
        left join questions    q   on q.user_id  = u.id
        left join life         lf  on lf.user_id = u.id
    ) x;

  return result;
end;
$$;

-- anon, like every other moderator-token RPC: the admin has no Supabase
-- Auth session of their own here, and the token check above is the gate.
grant execute on function admin_list_user_activity(text) to anon;
