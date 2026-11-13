-- ============================================================
-- BirdWatchAI Classroom — feedback on generated questions
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-classrooms.sql. Purely additive: one table, three
-- functions. Nothing existing is replaced.
--
-- WHY
-- The questions are generated from templates against live data, so
-- nobody — including whoever wrote the template — sees the exact
-- wording a class will get until a class gets it. "This one reads
-- badly" is the single most useful signal for improving them, and
-- until now there was nowhere to put it: a teacher noticing a confusing
-- question mid-lesson had to remember it until they next saw someone.
--
-- So a flag is a first-class thing. It captures the question AS SHOWN —
-- prompt, choices, the answer, the chart it sat beside — because the
-- template that produced it will produce something different tomorrow
-- from different data, and "the counting one was unclear" is not enough
-- to act on a week later.
--
-- SAFE TO RE-RUN.
-- ============================================================

create extension if not exists pgcrypto;


-- ────────────────────────────────────────────────────────────────────
-- 1. The table
--
-- The question is denormalised into it on purpose. A foreign key to
-- classroom_session_answers would be tidier and useless: most flags
-- come from previewing a lesson that was never run, so there is no
-- answer row to point at, and the ones that do point at a session would
-- still be describing a row whose wording is the only copy that exists.
-- ────────────────────────────────────────────────────────────────────

create table if not exists classroom_question_feedback (
  id            uuid primary key default gen_random_uuid(),
  community_id  uuid not null references communities(id) on delete cascade,
  -- Nullable: the classroom may be deleted long before somebody acts on
  -- the feedback, and losing the note with it would be the wrong trade.
  classroom_id  uuid references classrooms(id) on delete set null,

  -- What produced it. template_id is the actionable part — it points at
  -- the code to change.
  template_id   text not null,
  category      text,
  grade_band    text,

  -- The question exactly as it appeared.
  prompt        text not null,
  choices       jsonb not null default '[]'::jsonb,
  correct_index integer,
  explain       text,
  chart_kind    text,
  source_feeder_id uuid,

  reason        text not null
                  check (reason in ('unclear', 'wrong', 'too_easy',
                                    'too_hard', 'bad_visual', 'other')),
  comment       text,

  created_by    uuid not null,
  created_at    timestamptz not null default now(),

  resolved_at   timestamptz,
  resolved_by   uuid,
  resolved_note text
);

create index if not exists idx_question_feedback_open
  on classroom_question_feedback(community_id, created_at desc)
  where resolved_at is null;

create index if not exists idx_question_feedback_template
  on classroom_question_feedback(template_id);

comment on table classroom_question_feedback is
  'Teacher feedback on generated classroom questions. The question is stored '
  'as shown because the template will not reproduce it.';


-- ────────────────────────────────────────────────────────────────────
-- 2. RLS — same posture as the rest of classroom mode
-- ────────────────────────────────────────────────────────────────────

alter table classroom_question_feedback enable row level security;

drop policy if exists "Service role full access question feedback" on classroom_question_feedback;
create policy "Service role full access question feedback" on classroom_question_feedback
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- 3. Raising a flag
--
-- Any teacher in the community, not only the classroom's own teacher:
-- a confusing question is confusing whoever meets it, and a teacher
-- previewing somebody else's lesson to cover a class should be able to
-- say so. The classroom id is checked to belong to the community so a
-- flag cannot be filed against a classroom elsewhere.
-- ────────────────────────────────────────────────────────────────────

create or replace function classroom_flag_question(
  p_community_id uuid,
  p_question     jsonb,
  p_reason       text,
  p_comment      text default null,
  p_classroom_id uuid default null
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  fb classroom_question_feedback%rowtype;
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  if p_question is null or jsonb_typeof(p_question) <> 'object' then
    raise exception 'A question object is required';
  end if;
  if coalesce(p_question->>'prompt', '') = '' then
    raise exception 'A question needs a prompt';
  end if;
  if p_reason not in ('unclear','wrong','too_easy','too_hard','bad_visual','other') then
    raise exception 'Unknown reason: %', p_reason;
  end if;
  if length(coalesce(p_comment, '')) > 2000 then
    raise exception 'Comment is too long (2000 characters max)';
  end if;

  if p_classroom_id is not null and not exists (
    select 1 from classrooms
     where id = p_classroom_id and community_id = p_community_id
  ) then
    raise exception 'That classroom is not in this community';
  end if;

  insert into classroom_question_feedback (
    community_id, classroom_id, template_id, category, grade_band,
    prompt, choices, correct_index, explain, chart_kind, source_feeder_id,
    reason, comment, created_by)
  values (
    p_community_id, p_classroom_id,
    coalesce(p_question->>'template_id', 'unknown'),
    p_question->>'category',
    p_question->>'grade_band',
    p_question->>'prompt',
    coalesce(p_question->'choices', '[]'::jsonb),
    nullif(p_question->>'correct_index', '')::integer,
    p_question->>'explain',
    p_question->>'chart_kind',
    nullif(p_question->>'source_feeder_id', '')::uuid,
    p_reason, nullif(trim(coalesce(p_comment, '')), ''), auth.uid())
  returning * into fb;

  return row_to_json(fb);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 4. Reading it back
--
-- Owner and moderator only. A teacher files feedback; deciding what to
-- do about it is the person who runs the community, and the list
-- carries other teachers' words about questions they found confusing —
-- which is not something to spread wider than it needs to go.
--
-- Grouped counts come back alongside the rows because the actionable
-- question is "which TEMPLATE keeps getting flagged", not "which
-- question was flagged once".
-- ────────────────────────────────────────────────────────────────────

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
begin
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator']);

  select json_agg(row_to_json(t) order by t.created_at desc) into items
  from (
    select f.id, f.template_id, f.category, f.grade_band, f.prompt,
           f.choices, f.correct_index, f.explain, f.chart_kind,
           f.reason, f.comment, f.created_at, f.resolved_at, f.resolved_note,
           coalesce(nullif(p.display_name, ''), u.email, 'Someone') as by_label,
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
    'items', coalesce(items, '[]'::json),
    'by_template', coalesce(tally, '[]'::json));
end;
$$;


create or replace function classroom_feedback_resolve(
  p_id   uuid,
  p_note text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  select community_id into cid from classroom_question_feedback where id = p_id;
  if cid is null then
    raise exception 'Feedback not found';
  end if;
  perform community_require_role(cid, auth.uid(), array['owner', 'moderator']);

  update classroom_question_feedback
     set resolved_at   = now(),
         resolved_by   = auth.uid(),
         resolved_note = nullif(trim(coalesce(p_note, '')), '')
   where id = p_id;
  return found;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 5. Grants
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text;
begin
  foreach f in array array[
    'classroom_flag_question(uuid, jsonb, text, text, uuid)',
    'classroom_feedback_list(uuid, boolean, integer)',
    'classroom_feedback_resolve(uuid, text)'
  ]
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('revoke execute on function %s from anon',   f);
    execute format('grant  execute on function %s to authenticated', f);
  end loop;
end $$;
