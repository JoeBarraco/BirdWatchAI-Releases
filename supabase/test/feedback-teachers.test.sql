-- Behavior tests for setup-classroom-feedback-teachers.sql.
-- Needs stub-schema.sql and that migration applied.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

create or replace function t_raises(label text, sql text) returns void
language plpgsql as $$
begin
  execute sql;
  raise notice 'FAIL *** % (expected an error, got none)', label;
exception when others then
  raise notice 'PASS % [%]', label, left(sqlerrm, 56);
end $$;

do $$
declare
  owner_id   uuid := '44444444-4444-4444-4444-444444444444';
  mod_id     uuid := '55555555-5555-5555-5555-555555555555';
  teach_a    uuid := '66666666-6666-6666-6666-666666666666';
  teach_b    uuid := '77777777-7777-7777-7777-777777777777';
  viewer_id  uuid := '88888888-8888-8888-8888-888888888888';
  cid        uuid;
  res        json;
  labels     text;
begin
  insert into auth.users (id, email) values
    (owner_id,  'head@school.example'),
    (mod_id,    'deputy@school.example'),
    (teach_a,   'anna@school.example'),
    (teach_b,   'ben@school.example'),
    (viewer_id, 'parent@school.example')
  on conflict (id) do nothing;

  insert into user_profiles (id, display_name) values
    (owner_id, 'Head'), (mod_id, 'Deputy'),
    (teach_a, 'Anna Teacher'), (teach_b, 'Ben Teacher')
  on conflict (id) do nothing;

  insert into communities (slug, name, kind, owner_user_id)
    values ('fb-school', 'Feedback School', 'school', owner_id)
    returning id into cid;

  insert into community_members (community_id, user_id, role) values
    (cid, owner_id, 'owner'), (cid, mod_id, 'moderator'),
    (cid, teach_a, 'teacher'), (cid, teach_b, 'teacher'),
    (cid, viewer_id, 'viewer');

  -- Two open flags from different teachers, and one already handled.
  insert into classroom_question_feedback
    (community_id, kind, reason, comment, template_id, prompt, created_by) values
    (cid, 'flag', 'unclear', 'The wording confused my class', 'tpl-a',
     'Which bird visited most?', teach_a),
    (cid, 'flag', 'wrong', 'The answer looks wrong to me', 'tpl-b',
     'How many visits on Tuesday?', teach_b);
  insert into classroom_question_feedback
    (community_id, kind, reason, comment, template_id, prompt, created_by,
     resolved_at, resolved_by, resolved_note) values
    (cid, 'flag', 'too_hard', 'Too hard for K-2', 'tpl-c',
     'Estimate the weekly mean', teach_b,
     now() - interval '2 days', owner_id, 'Reworded for K-2');

  raise notice '';
  raise notice '── A. Who may read the pile ──';
  perform set_config('test.uid', teach_a::text, false);
  perform t_ok('a teacher can read it now',
    (classroom_feedback_list(cid)->>'items') is not null);

  perform set_config('test.uid', viewer_id::text, false);
  perform t_raises('a viewer still cannot',
    format('select classroom_feedback_list(%L)', cid));

  perform set_config('test.uid', '99999999-9999-9999-9999-999999999999', false);
  perform t_raises('a non-member still cannot',
    format('select classroom_feedback_list(%L)', cid));

  raise notice '';
  raise notice '── B. can_resolve reflects the server rule ──';
  perform set_config('test.uid', teach_a::text, false);
  perform t_ok('teacher: can_resolve false',
    (classroom_feedback_list(cid)->>'can_resolve')::boolean = false);
  perform set_config('test.uid', mod_id::text, false);
  perform t_ok('moderator: can_resolve true',
    (classroom_feedback_list(cid)->>'can_resolve')::boolean);
  perform set_config('test.uid', owner_id::text, false);
  perform t_ok('owner: can_resolve true',
    (classroom_feedback_list(cid)->>'can_resolve')::boolean);

  raise notice '';
  raise notice '── C. A teacher never sees a colleague''s name ──';
  perform set_config('test.uid', teach_a::text, false);
  res := classroom_feedback_list(cid);
  select string_agg(e->>'by_label', ' | ') into labels
    from json_array_elements(res->'items') e;
  perform t_ok('teacher sees only You / A colleague',
    labels !~ 'Anna|Ben|Head|Deputy|@');
  perform t_ok('…their own item reads "You"',
    exists (select 1 from json_array_elements(res->'items') e
             where e->>'template_id' = 'tpl-a' and e->>'by_label' = 'You'));
  perform t_ok('…a colleague''s reads "A colleague"',
    exists (select 1 from json_array_elements(res->'items') e
             where e->>'template_id' = 'tpl-b' and e->>'by_label' = 'A colleague'));
  perform t_ok('is_mine marks their own',
    (select (e->>'is_mine')::boolean from json_array_elements(res->'items') e
      where e->>'template_id' = 'tpl-a'));
  perform t_ok('…and not the other''s',
    (select (e->>'is_mine')::boolean = false from json_array_elements(res->'items') e
      where e->>'template_id' = 'tpl-b'));

  -- The words themselves are the useful part and must survive redaction.
  perform t_ok('the comment is NOT redacted',
    exists (select 1 from json_array_elements(res->'items') e
             where e->>'comment' = 'The answer looks wrong to me'));

  raise notice '';
  raise notice '── D. A moderator still sees names ──';
  perform set_config('test.uid', mod_id::text, false);
  res := classroom_feedback_list(cid);
  perform t_ok('moderator sees the author''s name',
    exists (select 1 from json_array_elements(res->'items') e
             where e->>'template_id' = 'tpl-a' and e->>'by_label' = 'Anna Teacher'));
  perform t_ok('…and "You" on their own, not their own name',
    not exists (select 1 from json_array_elements(res->'items') e
                 where e->>'by_label' = 'Deputy'));

  raise notice '';
  raise notice '── E. Handled items ──';
  perform set_config('test.uid', teach_b::text, false);
  select count(*) into labels from json_array_elements(classroom_feedback_list(cid)->'items');
  perform t_ok('open-only hides the handled one', labels = '2');
  select count(*) into labels
    from json_array_elements(classroom_feedback_list(cid, true)->'items');
  perform t_ok('include_resolved shows it', labels = '3');
  perform t_ok('a teacher can read the resolution note',
    exists (select 1 from json_array_elements(classroom_feedback_list(cid, true)->'items') e
             where e->>'template_id' = 'tpl-c'
               and e->>'resolved_note' = 'Reworded for K-2'));

  raise notice '';
  raise notice '── F. The tally still counts open items only ──';
  perform set_config('test.uid', owner_id::text, false);
  perform t_ok('three flags, two open, tally has two templates',
    (select count(*) from json_array_elements(
       classroom_feedback_list(cid, true)->'by_template')) = 2);
end $$;
