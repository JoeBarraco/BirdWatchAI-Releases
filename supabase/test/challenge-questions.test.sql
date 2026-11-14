-- Behaviour tests for setup-classroom-challenge-questions.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-classroom-challenges.sql, setup-classroom-challenge-rooms.sql AND
-- setup-classroom-challenge-questions.sql.
--
-- The two things most worth pinning down:
--   * 'any' is the default, so every challenge created before this migration
--     goes on behaving exactly as it did.
--   * a mode that names nothing falls back to 'any' rather than creating a
--     challenge with no askable questions in it.

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
  owner_id uuid := 'e0000000-0000-0000-0000-000000000001';
  mod_id   uuid := 'e0000000-0000-0000-0000-000000000002';
  t1_id    uuid := 'e0000000-0000-0000-0000-000000000003';
  out_id   uuid := 'e0000000-0000-0000-0000-000000000004';
  cid      uuid;
  rA uuid; rB uuid;
  ch       uuid;
  act      json;
begin
  insert into auth.users (id, email) values
    (owner_id,'head@q.example'), (mod_id,'dep@q.example'),
    (t1_id,'tina@q.example'),    (out_id,'other@q.example')
  on conflict (id) do nothing;

  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('q-school','Question School','school',owner_id, now() + interval '6 months')
    returning id into cid;
  insert into community_members (community_id, user_id, role) values
    (cid, owner_id,'owner'), (cid, mod_id,'moderator'), (cid, t1_id,'teacher');

  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room A','k-2',t1_id) returning id into rA;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room B','3-5',t1_id) returning id into rB;

  perform set_config('test.uid', mod_id::text, false);

  raise notice '';
  raise notice '── A. The default is unrestricted ──';
  select (classroom_challenge_create(cid,'Plain', current_date - 1, current_date + 1)->>'id')::uuid
    into ch;
  perform t_ok('a four-argument call still works', ch is not null);
  perform t_ok('…and lands on mode any',
    (select question_mode from classroom_challenges where id = ch) = 'any');
  perform t_ok('…with no categories and no templates',
    (select categories is null and template_picks is null
       from classroom_challenges where id = ch));

  raise notice '';
  raise notice '── B. By category ──';
  select (classroom_challenge_create(cid,'Measurement Week', current_date - 1, current_date + 1,
            null, 'categories', array['math','counting','math'])->>'id')::uuid into ch;
  perform t_ok('the category list is stored, de-duplicated',
    (select cardinality(categories) from classroom_challenges where id = ch) = 2);
  perform t_ok('template picks are cleared for a category challenge',
    (select template_picks is null from classroom_challenges where id = ch));

  raise notice '';
  raise notice '── C. By exact question ──';
  select (classroom_challenge_create(cid,'Chosen', current_date - 1, current_date + 1,
            null, 'templates', array['ignored'], array['word-jumble','odd-one-out'])->>'id')::uuid
    into ch;
  perform t_ok('the template list is stored',
    (select cardinality(template_picks) from classroom_challenges where id = ch) = 2);
  perform t_ok('categories are cleared for a template challenge',
    (select categories is null from classroom_challenges where id = ch));

  raise notice '';
  raise notice '── D. A mode that names nothing is not a lesson with no questions ──';
  select (classroom_challenge_create(cid,'Empty Cats', current_date - 1, current_date + 1,
            null, 'categories', array[]::text[])->>'id')::uuid into ch;
  perform t_ok('an empty category list falls back to any',
    (select question_mode from classroom_challenges where id = ch) = 'any');
  select (classroom_challenge_create(cid,'Blanks', current_date - 1, current_date + 1,
            null, 'templates', null, array['   ', ''])->>'id')::uuid into ch;
  perform t_ok('a list of blanks falls back to any',
    (select question_mode from classroom_challenges where id = ch) = 'any');

  perform t_raises('an unknown mode is refused',
    format('select classroom_challenge_create(%L, ''Weird'', current_date, current_date + 1, null, ''sideways'')', cid));

  raise notice '';
  raise notice '── E. What a class should be asking now ──';
  -- Clear the board first. Sections A-D are about CREATION and left five
  -- unrestricted, in-window challenges behind, every one of which covers
  -- every class — so without this the "active" tests are asking which of
  -- six live challenges wins, which is a different question. (They would
  -- also tie on created_at: one transaction, one now().)
  delete from classroom_challenges where community_id = cid;

  -- One live, category challenge covering only Room A.
  select (classroom_challenge_create(cid,'Live One', current_date - 1, current_date + 1,
            array[rA], 'categories', array['art'])->>'id')::uuid into ch;

  perform set_config('test.uid', t1_id::text, false);
  act := classroom_active_challenge(rA);
  perform t_ok('the teacher of the named room sees it', act is not null);
  perform t_ok('…with its mode and categories',
    act->>'question_mode' = 'categories'
    and (select count(*) from json_array_elements_text(act->'categories')) = 1);

  perform t_ok('a room outside the roster sees nothing',
    classroom_active_challenge(rB) is null);

  raise notice '';
  raise notice '── F. Out of window, and out of school ──';
  perform set_config('test.uid', mod_id::text, false);
  update classroom_challenges set starts_on = current_date - 20,
                                  ends_on   = current_date - 10 where id = ch;
  perform set_config('test.uid', t1_id::text, false);
  perform t_ok('a finished challenge is not active', classroom_active_challenge(rA) is null);

  perform set_config('test.uid', out_id::text, false);
  perform t_raises('somebody outside the school cannot ask',
    format('select classroom_active_challenge(%L)', rA));

  raise notice '';
  raise notice '── G. Still only owners and moderators may create ──';
  perform set_config('test.uid', t1_id::text, false);
  perform t_raises('a teacher cannot create one with a question policy',
    format('select classroom_challenge_create(%L, ''Mine'', current_date, current_date + 1, null, ''categories'', array[''art''])', cid));
end $$;
