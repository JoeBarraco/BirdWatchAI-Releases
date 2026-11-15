-- ════════════════════════════════════════════════════════════════════
--  Teacher questions: a subject, a standard, real media, and sharing
-- ════════════════════════════════════════════════════════════════════
--
--  Run after setup-classroom-teacher-questions.sql. Safe to re-run.
--
--  Four teacher suggestions, one migration, because they all land on the
--  same table and splitting them would mean four rounds of the overload
--  trap below rather than one.
--
--  1. "The write your own section should give you more control of the
--      question. For instance, you should be able to choose photos/clips
--      from ANY feeder accessible to the teacher on the community site.
--      Then you should be able to add charts/stats/data from the site and
--      construct the question from that."
--
--      → clip_detection_id, chart_spec, and the photo check widened from
--        this classroom's own feeders to every approved feeder in its
--        community. That is the same set the pooled data source reads,
--        so it is a boundary the project already draws.
--
--  2. "Teachers that write their own questions should be able to promote
--      the question outside of their classroom use so others can use it.
--      Also perhaps choose a category for the question as well."
--
--      → `shared`, plus a category, plus classroom_adopted_questions.
--
--  SHARING IS OPT-IN AT BOTH ENDS, and that is the whole design. ⚠
--  Marking a question shared only OFFERS it; another class gets it when
--  its own teacher adopts it. The alternative — shared questions
--  appearing automatically to every same-band class — would mean a
--  teacher's lesson silently acquiring somebody else's question between
--  one week and the next, which is exactly the control this feature was
--  asked for in order to gain. A join table is the honest shape.
--
--  3. Standards. Every template question carries Florida benchmarks;
--     teacher questions carried none, so a lesson's coverage report
--     silently under-counted whatever the teacher wrote themselves.
--     `standards text[]` fixes that. It is set by whoever reviews the
--     question — there is no automatic mapping and there should not be:
--     the rule in classroom-alignment.js is that the child must DO the
--     thing the benchmark describes, which is a judgement.
--
--  ⚠ THE OVERLOAD TRAP, FOR THE FOURTH TIME IN THIS PROJECT.
--  classroom_teacher_question_save gains arguments. `create or replace`
--  with a changed argument list creates a SECOND function, and PostgREST
--  then refuses every named-argument call with PGRST203 "Could not choose
--  the best candidate function" — a live outage, which is how the
--  challenge RPCs went down. The old signature is dropped explicitly
--  below, and a check at the foot of this file refuses to commit if more
--  than one survives.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
-- ════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ────────────────────────────────────────────────────────────────────

alter table classroom_teacher_questions
  add column if not exists category    text,
  add column if not exists shared      boolean not null default false,
  add column if not exists clip_detection_id uuid,
  add column if not exists chart_spec  jsonb,
  add column if not exists standards   text[] not null default '{}';

-- The categories the client already groups questions by. Open-ended text
-- would drift into forty spellings of "science"; a check keeps the
-- picker and the data agreeing.
do $$
begin
  alter table classroom_teacher_questions
    add constraint classroom_teacher_questions_category_check
    check (category is null or category in (
      'identification', 'counting', 'comparison', 'time', 'math', 'science',
      'prediction', 'analysis', 'puzzle', 'wonder', 'language', 'geography',
      'history', 'art', 'music'));
exception when duplicate_object then null;
end $$;

-- A chart spec is small and closed: which shape, over which data. Free
-- jsonb would let a question ask for a chart the client cannot draw, and
-- the failure would land on a projector.
do $$
begin
  alter table classroom_teacher_questions
    add constraint classroom_teacher_questions_chart_check
    check (chart_spec is null or (
      jsonb_typeof(chart_spec) = 'object'
      and chart_spec->>'kind' in ('bars','hbars','line','dots','donut','picto')
      and chart_spec->>'source' in ('days','species','hours')));
exception when duplicate_object then null;
end $$;

-- At most eight benchmarks, each shaped like a CPALMS code. The client
-- validates against the real catalogue; this only stops obvious rubbish
-- reaching the table by another path.
--
-- ⚠ ONE REGEX OVER THE JOINED ARRAY, not a per-element test. The obvious
-- `not exists (select 1 from unnest(standards) ...)` is rejected outright:
-- "cannot use subquery in check constraint". Joining with a comma and
-- matching code(,code)* is the same assertion without one, and
-- array_to_string is immutable so a constraint may call it.
do $$
begin
  alter table classroom_teacher_questions
    add constraint classroom_teacher_questions_standards_check
    check (cardinality(standards) <= 8
           and (cardinality(standards) = 0
                or array_to_string(standards, ',') ~
                   '^[A-Z]{2,4}\.[A-Z0-9]{1,3}\.[A-Z]{1,4}\.[0-9]+\.[0-9]+'
                   '(,[A-Z]{2,4}\.[A-Z0-9]{1,3}\.[A-Z]{1,4}\.[0-9]+\.[0-9]+)*$'));
exception when duplicate_object then null;
end $$;

do $$
begin
  if to_regclass('public.community_detections') is not null then
    begin
      alter table classroom_teacher_questions
        add constraint classroom_teacher_questions_clip_fk
        foreign key (clip_detection_id) references community_detections(id)
        on delete set null;
    exception when duplicate_object then null;
    end;
  end if;
end $$;


-- ────────────────────────────────────────────────────────────────────
-- 2. Adoption
--
-- Which classrooms have taken up a question somebody else shared. A bare
-- join table, like classroom_partner_feeders: the order carries no
-- meaning and a class either uses a question or it does not.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classroom_adopted_questions (
  classroom_id uuid not null references classrooms(id) on delete cascade,
  question_id  uuid not null references classroom_teacher_questions(id) on delete cascade,
  adopted_by   uuid,
  adopted_at   timestamptz not null default now(),
  primary key (classroom_id, question_id)
);

create index if not exists idx_classroom_adopted_q
  on classroom_adopted_questions(question_id);

alter table classroom_adopted_questions enable row level security;

drop policy if exists "Service role full access adopted questions" on classroom_adopted_questions;
create policy "Service role full access adopted questions" on classroom_adopted_questions
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 3. Reading
--
-- The list a teacher manages: their own questions, plus any they have
-- adopted from another class. `owned` is what the client uses to decide
-- whether Edit and Delete are offered — an adopted question belongs to
-- the teacher who wrote it.
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
           q.clip_detection_id, c.video_url,
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

/**
 * Questions other classes in this community have shared, that this one
 * has not taken up yet.
 *
 * Same grade band only. A question written for a kindergarten is wrong
 * for the sixth grade down the corridor, which is the reason teacher
 * questions were tied to one classroom in the first place — sharing
 * widens who may use it, not which age it suits.
 */
create or replace function classroom_shared_questions_list(p_classroom_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room   classrooms%rowtype;
  result json;
begin
  room := classroom_require_manage(p_classroom_id);

  select json_agg(row_to_json(t) order by t.created_at desc) into result
  from (
    select q.id, q.prompt, q.choices, q.correct_index, q.explain,
           q.detection_id, d.image_url, q.chart_spec, q.category, q.standards,
           q.created_at,
           own.name as from_classroom,
           coalesce(nullif(p.display_name, ''), 'A teacher') as from_teacher
    from classroom_teacher_questions q
    join classrooms own on own.id = q.classroom_id
    left join community_detections d on d.id = q.detection_id
    left join user_profiles p on p.id = q.created_by
    where q.shared
      and q.active
      and own.community_id = room.community_id
      and own.grade_band   = room.grade_band
      and q.classroom_id  <> room.id
      and not exists (select 1 from classroom_adopted_questions aq
                       where aq.classroom_id = room.id and aq.question_id = q.id)
    limit 100
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. Writing
--
-- The old signature goes first. See the header: this is the trap that
-- took the challenge RPCs down.
-- ────────────────────────────────────────────────────────────────────

drop function if exists classroom_teacher_question_save(uuid, uuid, text, text[], integer, text, uuid);

create or replace function classroom_teacher_question_save(
  p_classroom_id  uuid,
  p_id            uuid,
  p_prompt        text,
  p_choices       text[],
  p_correct_index integer,
  p_explain       text,
  p_detection_id  uuid,
  p_clip_detection_id uuid default null,
  p_chart_spec    jsonb default null,
  p_category      text default null,
  p_standards     text[] default null,
  p_shared        boolean default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  room      classrooms%rowtype;
  prompt_t  text := btrim(coalesce(p_prompt, ''));
  explain_t text := nullif(btrim(coalesce(p_explain, '')), '');
  cleaned   text[];
  n         integer;
  row_out   classroom_teacher_questions%rowtype;
begin
  room := classroom_require_manage(p_classroom_id);

  if prompt_t = '' then
    raise exception 'Write the question first';
  end if;
  if length(prompt_t) > 300 then
    raise exception 'That question is too long for the board (300 characters at most)';
  end if;
  if explain_t is not null and length(explain_t) > 400 then
    raise exception 'The reveal note is too long (400 characters at most)';
  end if;

  select array_agg(btrim(coalesce(x, '')) order by i) into cleaned
  from unnest(coalesce(p_choices, '{}'::text[])) with ordinality as u(x, i);

  n := coalesce(cardinality(cleaned), 0);
  if n < 2 or n > 4 then
    raise exception 'A question needs between two and four answers';
  end if;
  if exists (select 1 from unnest(cleaned) c where c = '') then
    raise exception 'One of the answers is blank';
  end if;
  if exists (select 1 from unnest(cleaned) c where length(c) > 80) then
    raise exception 'An answer is too long (80 characters at most)';
  end if;
  if (select count(distinct lower(c)) from unnest(cleaned) c) <> n then
    raise exception 'Two of the answers are the same';
  end if;
  if p_correct_index is null or p_correct_index < 0 or p_correct_index >= n then
    raise exception 'Pick which answer is right';
  end if;

  -- ⚠ THE MEDIA CHECK IS WIDER THAN IT WAS, AND NO WIDER THAN THAT.
  -- It was: this classroom's home or partner feeders. It is now: any
  -- feeder APPROVED IN THIS CLASSROOM'S COMMUNITY, which is what the
  -- suggestion asked for ("any feeder accessible to the teacher on the
  -- community site") and is the same set the pooled data source reads.
  --
  -- It is still a check against the database and not a trusted id from
  -- the client. The whole reason a detection id is stored rather than a
  -- URL is that a teacher must not be able to put an arbitrary address
  -- on a projector, and widening the set does not change that.
  if p_detection_id is not null and not cm_detection_in_community(p_detection_id, room.community_id) then
    raise exception 'That photo is not from a feeder in this community';
  end if;
  if p_clip_detection_id is not null and not cm_detection_in_community(p_clip_detection_id, room.community_id) then
    raise exception 'That clip is not from a feeder in this community';
  end if;
  if p_clip_detection_id is not null and not exists (
    select 1 from community_detections d
     where d.id = p_clip_detection_id and coalesce(d.video_url, '') <> '') then
    raise exception 'That detection has no clip';
  end if;

  if p_id is null then
    if (select count(*) from classroom_teacher_questions
        where classroom_id = room.id) >= 60 then
      raise exception 'This class already has 60 questions of its own — delete one first';
    end if;

    insert into classroom_teacher_questions
      (classroom_id, prompt, choices, correct_index, explain, detection_id,
       clip_detection_id, chart_spec, category, standards, shared, created_by)
    values
      (room.id, prompt_t, cleaned, p_correct_index, explain_t, p_detection_id,
       p_clip_detection_id, p_chart_spec, p_category,
       coalesce(p_standards, '{}'), coalesce(p_shared, false), auth.uid())
    returning * into row_out;
  else
    -- Only the OWNING classroom may edit. An adopted question is
    -- somebody else's work and editing it would change it under them.
    update classroom_teacher_questions
       set prompt = prompt_t, choices = cleaned, correct_index = p_correct_index,
           explain = explain_t, detection_id = p_detection_id,
           clip_detection_id = p_clip_detection_id,
           chart_spec = p_chart_spec,
           category   = p_category,
           standards  = coalesce(p_standards, standards),
           shared     = coalesce(p_shared, shared),
           updated_at = now()
     where id = p_id and classroom_id = room.id
    returning * into row_out;

    if row_out.id is null then
      raise exception 'Question not found';
    end if;
  end if;

  return row_to_json(row_out);
end;
$$;

/**
 * Is this detection from a feeder approved in this community?
 *
 * Its own function because three call sites need exactly this question
 * and a copy that drifts is a hole rather than a bug.
 */
create or replace function cm_detection_in_community(p_detection_id uuid, p_community_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from community_detections d
      join community_feeders cf on cf.feeder_id = d.feeder_id
     where d.id = p_detection_id
       and cf.community_id = p_community_id
       and cf.status = 'approved'
  );
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. Adopting and dropping a shared question
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_adopt_question(
  p_classroom_id uuid,
  p_question_id  uuid,
  p_adopt        boolean default true
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  room classrooms%rowtype;
  ok   boolean;
begin
  room := classroom_require_manage(p_classroom_id);

  if not coalesce(p_adopt, true) then
    delete from classroom_adopted_questions
     where classroom_id = room.id and question_id = p_question_id;
    return found;
  end if;

  -- Shared, same community, same band, and not this class's own. Checked
  -- here rather than trusted from the client: an id is just an id.
  select exists (
    select 1 from classroom_teacher_questions q
      join classrooms own on own.id = q.classroom_id
     where q.id = p_question_id
       and q.shared
       and own.community_id = room.community_id
       and own.grade_band   = room.grade_band
       and q.classroom_id  <> room.id
  ) into ok;

  if not ok then
    raise exception 'That question is not shared with this class';
  end if;

  insert into classroom_adopted_questions (classroom_id, question_id, adopted_by)
  values (room.id, p_question_id, auth.uid())
  on conflict do nothing;
  return true;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 6. Grants
-- ────────────────────────────────────────────────────────────────────

revoke execute on function classroom_teacher_question_save(
  uuid, uuid, text, text[], integer, text, uuid, uuid, jsonb, text, text[], boolean) from public, anon;
grant  execute on function classroom_teacher_question_save(
  uuid, uuid, text, text[], integer, text, uuid, uuid, jsonb, text, text[], boolean) to authenticated;

revoke execute on function classroom_shared_questions_list(uuid) from public, anon;
grant  execute on function classroom_shared_questions_list(uuid) to authenticated;

revoke execute on function classroom_adopt_question(uuid, uuid, boolean) from public, anon;
grant  execute on function classroom_adopt_question(uuid, uuid, boolean) to authenticated;

revoke execute on function cm_detection_in_community(uuid, uuid) from public, anon;


-- ────────────────────────────────────────────────────────────────────
-- 7. One signature each, or stop
--
-- The challenge RPCs were left with two for a fortnight and the only
-- symptom was a live outage. This refuses to commit instead.
-- ────────────────────────────────────────────────────────────────────

do $$
declare r record;
begin
  for r in
    select p.proname, count(*) as n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('classroom_teacher_question_save',
                         'classroom_teacher_questions_list',
                         'classroom_shared_questions_list',
                         'classroom_adopt_question')
     group by p.proname
  loop
    if r.n <> 1 then
      raise exception '% has % signatures, expected 1 — PostgREST will refuse '
                      'named-argument calls', r.proname, r.n;
    end if;
  end loop;
end $$;

commit;
