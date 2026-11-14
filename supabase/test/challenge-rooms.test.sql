-- Behaviour tests for setup-classroom-challenge-rooms.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-classroom-challenges.sql AND setup-classroom-challenge-rooms.sql.
-- The subscription one is not optional: its trigger refuses to create a
-- classroom in a school with no live term, so this suite gives its school
-- one.
--
-- The thing most worth checking here is that AN EMPTY ROSTER STILL MEANS
-- EVERY CLASS. Every challenge created before this migration has no rows in
-- classroom_challenge_rooms, and if absence ever came to mean "no classes"
-- every one of them would silently empty its own scoreboard.

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
  owner_id uuid := 'd0000000-0000-0000-0000-000000000001';
  mod_id   uuid := 'd0000000-0000-0000-0000-000000000002';
  t1_id    uuid := 'd0000000-0000-0000-0000-000000000003';
  cid      uuid;
  other    uuid;
  rA uuid; rB uuid; rC uuid; foreign_room uuid;
  ch_all   uuid;
  ch_some  uuid;
  ch_tick  uuid;
  st       json;
begin
  insert into auth.users (id, email) values
    (owner_id,'head@r.example'), (mod_id,'dep@r.example'), (t1_id,'tina@r.example')
  on conflict (id) do nothing;

  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('roster-school','Roster School','school',owner_id, now() + interval '6 months')
    returning id into cid;
  insert into community_members (community_id, user_id, role) values
    (cid, owner_id,'owner'), (cid, mod_id,'moderator'), (cid, t1_id,'teacher');

  -- A second school, to prove a challenge cannot reach into one.
  insert into communities (slug, name, kind, owner_user_id, school_expires_at)
    values ('other-school','Other School','school',owner_id, now() + interval '6 months')
    returning id into other;
  insert into community_members (community_id, user_id, role) values (other, owner_id,'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (other,'Someone Else','k-2',null) returning id into foreign_room;

  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room A','k-2',t1_id) returning id into rA;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room B','k-2',t1_id) returning id into rB;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cid,'Room C','k-2',t1_id) returning id into rC;

  -- One answered question each, inside the window, so all three would be on
  -- an unrestricted board.
  insert into classroom_sessions (id, classroom_id, started_by, started_at)
    select gen_random_uuid(), r.id, t1_id, now() from classrooms r where r.community_id = cid;
  insert into classroom_session_answers (session_id, template_id, category, grade_band, prompt, is_correct)
    select s.id,'t','counting','k-2','q', true
      from classroom_sessions s join classrooms r on r.id = s.classroom_id
     where r.community_id = cid;

  perform set_config('test.uid', mod_id::text, false);

  raise notice '';
  raise notice '── A. No roster means every class ──';
  select (classroom_challenge_create(cid,'Whole School', current_date - 1, current_date + 1)->>'id')::uuid
    into ch_all;
  perform t_ok('the old four-argument call still works', ch_all is not null);
  st := classroom_challenge_standings(ch_all);
  perform t_ok('all three classes are on the board',
    (select count(*) from json_array_elements(st->'standings')) = 3);
  perform t_ok('…and it does not report itself as limited',
    (st->>'limited')::boolean = false);
  perform t_ok('the list reports an empty roster',
    (select e->>'classroom_ids' from json_array_elements(classroom_challenge_list(cid)->'items') e
      where (e->>'id')::uuid = ch_all) = '[]');

  raise notice '';
  raise notice '── B. A roster limits the board ──';
  select (classroom_challenge_create(cid,'Just Two', current_date - 1, current_date + 1,
                                     array[rA, rB])->>'id')::uuid into ch_some;
  st := classroom_challenge_standings(ch_some);
  perform t_ok('only the two named classes are on the board',
    (select count(*) from json_array_elements(st->'standings')) = 2);
  perform t_ok('the class left out is absent, not on zero',
    not exists (select 1 from json_array_elements(st->'standings') e where e->>'name' = 'Room C'));
  perform t_ok('the board reports itself as limited',
    (st->>'limited')::boolean);
  perform t_ok('the list carries the two ids',
    (select json_array_length(e->'classroom_ids')
       from json_array_elements(classroom_challenge_list(cid)->'items') e
      where (e->>'id')::uuid = ch_some) = 2);

  raise notice '';
  raise notice '── C. Ticking every class is stored as "every class" ──';
  -- Not as three rows. A school that adds Room D next week should see it
  -- join, which is the whole reason absence is the permissive case.
  select (classroom_challenge_create(cid,'All Ticked', current_date - 1, current_date + 1,
                                     array[rA, rB, rC])->>'id')::uuid into ch_tick;
  perform t_ok('no roster rows were written',
    not exists (select 1 from classroom_challenge_rooms where challenge_id = ch_tick));
  perform t_ok('and the board is not limited',
    (classroom_challenge_standings(ch_tick)->>'limited')::boolean = false);

  raise notice '';
  raise notice '── D. A challenge cannot reach into another school ──';
  perform t_raises('a classroom from another community is refused',
    format('select classroom_challenge_create(%L, ''Poach'', current_date, current_date + 1, array[%L::uuid, %L::uuid])',
           cid, rA, foreign_room));
  perform t_raises('an id that is not a classroom at all is refused',
    format('select classroom_challenge_create(%L, ''Nonsense'', current_date, current_date + 1, array[%L::uuid])',
           cid, gen_random_uuid()));
  perform t_ok('neither attempt left a challenge behind',
    (select count(*) from classroom_challenges where community_id = cid) = 3);

  raise notice '';
  raise notice '── E. An archived class is not a valid pick ──';
  update classrooms set archived_at = now() where id = rC;
  perform t_raises('an archived class is refused',
    format('select classroom_challenge_create(%L, ''Ghost'', current_date, current_date + 1, array[%L::uuid, %L::uuid])',
           cid, rA, rC));
  -- With C archived there are two live classes, so naming both is "all".
  perform t_ok('with C archived, naming A and B is stored as every class',
    not exists (select 1 from classroom_challenge_rooms where challenge_id =
      (classroom_challenge_create(cid,'A and B', current_date, current_date + 1,
                                  array[rA, rB])->>'id')::uuid));
  update classrooms set archived_at = null where id = rC;

  raise notice '';
  raise notice '── F. Deleting a class leaves the challenge standing ──';
  delete from classrooms where id = rB;
  perform t_ok('its roster row went with it',
    not exists (select 1 from classroom_challenge_rooms
                 where challenge_id = ch_some and classroom_id = rB));
  perform t_ok('the challenge itself is untouched',
    exists (select 1 from classroom_challenges where id = ch_some));
  perform t_ok('and the board still carries Room A',
    exists (select 1 from json_array_elements(classroom_challenge_standings(ch_some)->'standings') e
             where e->>'name' = 'Room A'));

  raise notice '';
  raise notice '── G. Who may set one ──';
  perform set_config('test.uid', t1_id::text, false);
  perform t_raises('a teacher still cannot create a challenge',
    format('select classroom_challenge_create(%L, ''Mine'', current_date, current_date + 1, array[%L::uuid])',
           cid, rA));
  perform t_ok('but a teacher can still read the board',
    (classroom_challenge_standings(ch_some)->'standings') is not null);
end $$;
