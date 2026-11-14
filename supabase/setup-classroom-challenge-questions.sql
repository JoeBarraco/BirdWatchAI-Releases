-- ════════════════════════════════════════════════════════════════════
--  A challenge can say WHICH questions it is about
-- ════════════════════════════════════════════════════════════════════
--
--  Follows setup-classroom-challenge-rooms.sql. A challenge was a window of
--  dates, and every class in it went on asking whatever it normally asks —
--  which makes the scoreboard a comparison of different papers. For a casual
--  week that is fine. For "Bird Week", where the whole school is meant to be
--  doing the same thing, it is not.
--
--  THREE MODES, because there are three different intentions:
--
--    'any'         Randomize. No restriction: every class goes on using its
--                  own curated list, exactly as before. The default, and
--                  what every challenge that already exists means.
--
--    'categories'  "This week is about measurement." Named by subject, so a
--                  question template added next month joins the challenge
--                  without anybody editing it.
--
--    'templates'   The exact questions, chosen one by one. For a moderator
--                  who knows precisely what they want on the board.
--
--  IT OVERRIDES THE CLASS'S OWN PICKS, rather than intersecting with them.
--  Intersecting would give each class a different pool — which is the thing
--  a challenge exists to stop — and a class whose curated list missed the
--  challenge's subject would end up with no questions at all.
--
--  Overriding is safe because the band filter is separate and client-side:
--  a template only ever reaches a class whose grade band it declares. A K-2
--  class in a challenge built from 6-8 templates gets the K-2 ones, not an
--  impossible lesson.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

begin;


-- ── 1. The policy ───────────────────────────────────────────────────

alter table classroom_challenges
  add column if not exists question_mode  text not null default 'any',
  add column if not exists categories     text[],
  add column if not exists template_picks text[];

do $$
begin
  alter table classroom_challenges
    add constraint classroom_challenges_question_mode
    check (question_mode in ('any', 'categories', 'templates'));
exception when duplicate_object then null;
end $$;

-- Size and no-nulls only, as on classrooms.template_picks: a CHECK may not
-- contain a subquery, so the per-element rules live in the write path below,
-- which is the only way in.
do $$
begin
  alter table classroom_challenges
    add constraint classroom_challenges_picks_shape
    check (
      (categories is null
        or (cardinality(categories) between 1 and 40
            and array_position(categories, null) is null))
      and
      (template_picks is null
        or (cardinality(template_picks) between 1 and 400
            and array_position(template_picks, null) is null))
    );
exception when duplicate_object then null;
end $$;

comment on column classroom_challenges.question_mode is
  'any | categories | templates. See setup-classroom-challenge-questions.sql. '
  'Overrides each classroom''s own template_picks for the duration.';


-- ── 2. Creating one ─────────────────────────────────────────────────
--
-- The five-argument signature is DROPPED, for the third time in this
-- feature's history and for the same reason: defaulted parameters mean two
-- candidates match a four- or five-argument named call, and PostgREST calls
-- that "function is not unique" rather than picking one.

drop function if exists classroom_challenge_create(uuid, text, date, date);
drop function if exists classroom_challenge_create(uuid, text, date, date, uuid[]);

create or replace function classroom_challenge_create(
  p_community_id  uuid,
  p_name          text,
  p_starts_on     date,
  p_ends_on       date,
  p_classroom_ids uuid[] default null,
  p_question_mode text   default 'any',
  p_categories    text[] default null,
  p_template_ids  text[] default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  c     classroom_challenges%rowtype;
  ids   uuid[];
  cats  text[];
  tmpl  text[];
  mode  text;
  n_all int;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'The challenge needs a name';
  end if;
  if p_ends_on < p_starts_on then
    raise exception 'The challenge cannot end before it starts';
  end if;
  if p_ends_on - p_starts_on > 180 then
    raise exception 'That window is longer than six months — check the dates';
  end if;

  mode := coalesce(nullif(btrim(p_question_mode), ''), 'any');
  if mode not in ('any', 'categories', 'templates') then
    raise exception 'Unknown question mode: %', mode;
  end if;

  -- Trim, drop blanks, de-duplicate — the same treatment classroom_set_
  -- templates gives a teacher's list, for the same reason: a list arriving
  -- with the same id twice is not worth refusing a save over.
  select array_agg(distinct v) into cats
    from (select btrim(x) as v from unnest(coalesce(p_categories, '{}'::text[])) x) q
   where v is not null and length(v) between 1 and 40;

  select array_agg(distinct v) into tmpl
    from (select btrim(x) as v from unnest(coalesce(p_template_ids, '{}'::text[])) x) q
   where v is not null and length(v) between 1 and 80;

  -- A mode that names nothing is the same as naming everything, and it is
  -- much more likely to be a UI that failed to send its list than a
  -- deliberate request for a challenge with no questions in it. Fall back to
  -- 'any' rather than create something that cannot be taught.
  if mode = 'categories' and (cats is null or cardinality(cats) = 0) then mode := 'any'; end if;
  if mode = 'templates'  and (tmpl is null or cardinality(tmpl) = 0) then mode := 'any'; end if;

  if mode <> 'categories' then cats := null; end if;
  if mode <> 'templates'  then tmpl := null; end if;

  if cats is not null and cardinality(cats) > 40 then
    raise exception 'That is more categories than exist';
  end if;
  if tmpl is not null and cardinality(tmpl) > 400 then
    raise exception 'That is more question types than a challenge can hold';
  end if;

  -- Only this school's own live classes. Silently dropping a foreign id
  -- would let a caller aim a challenge at another school's class and read
  -- its scores off the board.
  if p_classroom_ids is not null and array_length(p_classroom_ids, 1) > 0 then
    select array_agg(distinct r.id) into ids
      from classrooms r
     where r.id = any(p_classroom_ids)
       and r.community_id = p_community_id
       and r.archived_at is null;

    if ids is null or array_length(ids, 1) <> array_length(
         (select array_agg(distinct x) from unnest(p_classroom_ids) x), 1) then
      raise exception 'One of those classes is not in this school';
    end if;

    select count(*) into n_all from classrooms
     where community_id = p_community_id and archived_at is null;
    if array_length(ids, 1) >= n_all then
      ids := null;                        -- "every class", including later ones
    end if;
  end if;

  insert into classroom_challenges (community_id, name, starts_on, ends_on, created_by,
                                    question_mode, categories, template_picks)
  values (p_community_id, btrim(p_name), p_starts_on, p_ends_on, auth.uid(),
          mode, cats, tmpl)
  returning * into c;

  if ids is not null then
    insert into classroom_challenge_rooms (challenge_id, classroom_id)
    select c.id, x from unnest(ids) x;
  end if;

  return row_to_json(c);
end;
$$;


-- ── 3. Reading them ─────────────────────────────────────────────────

create or replace function classroom_challenge_list(p_community_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
  r      text;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);
  r := community_role(p_community_id, auth.uid());

  select json_agg(row_to_json(t) order by t.starts_on desc) into result
  from (
    select c.id, c.name, c.starts_on, c.ends_on, c.created_at,
           c.question_mode, c.categories, c.template_picks,
           (current_date between c.starts_on and c.ends_on) as is_current,
           (current_date > c.ends_on)                        as is_over,
           coalesce((select json_agg(cr.classroom_id)
                       from classroom_challenge_rooms cr
                      where cr.challenge_id = c.id), '[]'::json) as classroom_ids
      from classroom_challenges c
     where c.community_id = p_community_id
     order by c.starts_on desc
     limit 20
  ) t;

  return json_build_object(
    'items',     coalesce(result, '[]'::json),
    'can_manage', r in ('owner', 'moderator'));
end;
$$;


-- ── 4. What a class should be asking right now ──────────────────────
--
-- Called as a lesson starts, by the teacher about to teach it — so the
-- permission rule is classroom_require_manage, not the community-wide one:
-- a teacher may ask this about their own room without being handed the
-- roster of every other class in the school.
--
-- Returns null rather than raising when there is no challenge on. "No
-- challenge today" is the ordinary case, not an error, and a lesson must
-- never fail to start because the scoreboard had nothing to say.

create or replace function classroom_active_challenge(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  cid    uuid;
  result json;
begin
  perform classroom_require_manage(p_classroom_id);

  select community_id into cid from classrooms where id = p_classroom_id;
  if cid is null then
    return null;
  end if;

  select row_to_json(t) into result
  from (
    select c.id, c.name, c.starts_on, c.ends_on,
           c.question_mode, c.categories, c.template_picks
      from classroom_challenges c
     where c.community_id = cid
       and current_date between c.starts_on and c.ends_on
       -- No roster means every class; a roster means only the named ones.
       and (not exists (select 1 from classroom_challenge_rooms cr
                         where cr.challenge_id = c.id)
            or exists (select 1 from classroom_challenge_rooms cr
                        where cr.challenge_id = c.id
                          and cr.classroom_id = p_classroom_id))
     -- Two live challenges is not supposed to happen, but if it does the
     -- most recently created one is the one somebody meant.
     order by c.created_at desc
     limit 1
  ) t;

  return result;          -- null when nothing is running
end;
$$;


-- ── 5. Grants ───────────────────────────────────────────────────────

do $$
declare f text;
begin
  foreach f in array array[
    'classroom_challenge_create(uuid, text, date, date, uuid[], text, text[], text[])',
    'classroom_challenge_list(uuid)',
    'classroom_active_challenge(uuid)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon', f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;


commit;
