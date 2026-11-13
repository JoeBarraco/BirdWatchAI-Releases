-- ════════════════════════════════════════════════════════════════════
-- Classroom: suggestions ON a question, not just complaints about one
--
-- Run this AFTER setup-classroom-feedback.sql. It is safe to re-run.
--
-- Why
-- ───
-- Review gave a teacher exactly one door: "Something is wrong". That is
-- the wrong door for most of what a careful reviewer actually notices.
-- From the first real review pass: "I think the bars are too far apart
-- and maybe should be different colors. Nothing is wrong, just a
-- suggestion."
--
-- Filing that as a flag is not a cosmetic mislabel. The feedback pile is
-- a work queue — flags are defects to fix before a class meets them,
-- and burying "this would read better if…" among them means either the
-- real defects get diluted or the suggestions get closed unread. Worse,
-- a teacher who has to call their idea a fault will often just not file
-- it, which loses precisely the observation that was worth having.
--
-- classroom_suggest_question already writes kind='suggestion', but it
-- takes a free-text idea and keeps no question with it. For "these bars
-- are too far apart" the question IS the subject: without the template
-- id, the chart kind and the rendered prompt there is nothing to act on
-- later. So the flag path — which captures the whole question — grows a
-- kind instead.
--
-- Signature change
-- ────────────────
-- p_kind is appended with a default, which would otherwise leave two
-- overloads of the same name and make a 5-argument call ambiguous under
-- PostgREST's named-argument calls. The old signature is therefore
-- dropped first, and the grant re-issued against the new one.
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. Let the table hold the new reason
--
-- The first cut of this migration taught the FUNCTION about
-- 'improvement' and left the TABLE's check constraint alone, so every
-- suggestion was accepted by the function and then refused by the
-- constraint underneath it:
--
--   new row for relation "classroom_question_feedback" violates check
--   constraint "classroom_question_feedback_reason_check"
--
-- Validating the same vocabulary in two places is what made that
-- possible. The constraint is the one that actually protects the data,
-- so it is the one that has to be widened; the function's check stays
-- only to turn a violation into a sentence a teacher can read.
--
-- 'idea' is kept: classroom_suggest_question writes it for a free-text
-- suggestion that has no question attached, and dropping it here would
-- break that path instead.
-- ────────────────────────────────────────────────────────────────────

alter table classroom_question_feedback
  drop constraint if exists classroom_question_feedback_reason_check;

alter table classroom_question_feedback
  add constraint classroom_question_feedback_reason_check
  check (reason in ('unclear', 'wrong', 'too_easy', 'too_hard',
                    'bad_visual', 'improvement', 'other', 'idea'));


-- ────────────────────────────────────────────────────────────────────
-- 2. Replace the flag RPC with one that can file either kind
-- ────────────────────────────────────────────────────────────────────

drop function if exists classroom_flag_question(uuid, jsonb, text, text, uuid);

create or replace function classroom_flag_question(
  p_community_id uuid,
  p_question     jsonb,
  p_reason       text,
  p_comment      text default null,
  p_classroom_id uuid default null,
  p_kind         text default 'flag'
)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  fb classroom_question_feedback%rowtype;
begin
  -- Any teacher in the community, not only the classroom's own teacher:
  -- a confusing question is confusing whoever meets it, and a teacher
  -- previewing somebody else's lesson to cover a class should be able
  -- to say so.
  perform community_require_role(p_community_id, auth.uid(),
                                 array['owner', 'moderator', 'teacher']);

  if p_question is null or jsonb_typeof(p_question) <> 'object' then
    raise exception 'A question object is required';
  end if;
  if coalesce(p_question->>'prompt', '') = '' then
    raise exception 'A question needs a prompt';
  end if;

  if p_kind not in ('flag', 'suggestion') then
    raise exception 'Unknown kind: %', p_kind;
  end if;

  -- 'improvement' is the reason a suggestion carries when it is simply
  -- a better idea rather than a named fault. The fault reasons stay
  -- available to suggestions too, because "the chart is hard to read"
  -- is a sensible thing to raise either as a defect or as a polish
  -- item, and which one it is depends on the teacher's judgement about
  -- severity, not on the vocabulary.
  if p_reason not in ('unclear', 'wrong', 'too_easy', 'too_hard',
                      'bad_visual', 'improvement', 'other') then
    raise exception 'Unknown reason: %', p_reason;
  end if;

  -- A defect report with no words is still actionable: the question
  -- itself is the evidence. A suggestion with no words is not — there
  -- is nothing in it to act on but the fact that somebody was unhappy.
  if p_kind = 'suggestion'
     and coalesce(trim(coalesce(p_comment, '')), '') = '' then
    raise exception 'Say what would make it better';
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
    community_id, classroom_id, kind, template_id, category, grade_band,
    prompt, choices, correct_index, explain, chart_kind, source_feeder_id,
    reason, comment, created_by)
  values (
    p_community_id, p_classroom_id, p_kind,
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
-- 3. Grants
--
-- Same shape as setup-classroom-feedback.sql §5: nothing to public or
-- anon, execute to authenticated, and the function's own role check
-- does the real work.
-- ────────────────────────────────────────────────────────────────────

do $$
declare
  f text := 'classroom_flag_question(uuid, jsonb, text, text, uuid, text)';
begin
  execute format('revoke execute on function %s from public', f);
  execute format('revoke execute on function %s from anon',   f);
  execute format('grant  execute on function %s to authenticated', f);
end $$;
