-- Behaviour tests for setup-classroom-penpals.sql.
--
-- Order:
--   psql -f stub-schema.sql
--   psql -c "alter table community_detections add column if not exists temperature double precision,
--                                             add column if not exists latitude double precision"
--   psql -f ../setup-classroom-penpals.sql
--   psql -f penpals.test.sql

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
  raise notice 'PASS % [%]', label, left(sqlerrm, 60);
end $$;

do $$
declare
  ta uuid := 'a0000000-0000-0000-0000-00000000000a';   -- teacher at school A
  tb uuid := 'b0000000-0000-0000-0000-00000000000b';   -- teacher at school B
  tc uuid := 'c0000000-0000-0000-0000-00000000000c';   -- teacher at school C
  fa uuid := 'fa000000-0000-0000-0000-000000000000';
  fb uuid := 'fb000000-0000-0000-0000-000000000000';
  ca uuid; cb uuid; cc uuid;
  ra uuid; ra2 uuid; rb uuid; rc uuid; rn uuid;
  j json; code text; code2 text; w json;
begin
  insert into communities (slug, name, kind, owner_user_id) values ('pa', 'Alder School', 'school', ta) returning id into ca;
  insert into communities (slug, name, kind, owner_user_id) values ('pb', 'Birch School', 'school', tb) returning id into cb;
  insert into communities (slug, name, kind, owner_user_id) values ('pc', 'Cedar School', 'school', tc) returning id into cc;
  insert into community_members (community_id, user_id, role) values (ca, ta, 'owner'), (cb, tb, 'owner'), (cc, tc, 'owner');
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (ca, 'Room A', '3-5', ta, fa) returning id into ra;
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (ca, 'Room A2', '3-5', ta, fa) returning id into ra2;
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (cb, 'Room B', '3-5', tb, fb) returning id into rb;
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id)
    values (cc, 'Room C', 'k-2', tc, fb) returning id into rc;
  insert into classrooms (community_id, name, grade_band, teacher_user_id)
    values (cc, 'No feeder', 'k-2', tc) returning id into rn;

  -- A: invite
  perform set_config('test.uid', ta::text, true);
  j := classroom_penpal_status(ra);
  perform t_ok('A1 a new class has no pen-pal', j->>'state' = 'none');
  j := classroom_penpal_invite(ra);
  code := j->>'code';
  perform t_ok('A2 an invite makes an 8-letter code', j->>'state' = 'invited' and length(code) = 8);
  perform t_ok('A3 asking again gives the same code', classroom_penpal_invite(ra)->>'code' = code);
  perform t_raises('A4 someone else''s class cannot be invited for',
                   format('select classroom_penpal_invite(%L)', rb));

  -- B: accept
  perform set_config('test.uid', tc::text, true);
  perform t_raises('B1 a class with no feeder cannot pair', format('select classroom_penpal_accept(%L, %L)', rn, code));
  perform set_config('test.uid', ta::text, true);
  perform t_raises('B2 not the same school', format('select classroom_penpal_accept(%L, %L)', ra2, code));
  perform t_raises('B3 not your own code', format('select classroom_penpal_accept(%L, %L)', ra, code));
  perform set_config('test.uid', tb::text, true);
  perform t_raises('B4 a wrong code says only that', format('select classroom_penpal_accept(%L, %L)', rb, 'ZZZZZZZZ'));
  j := classroom_penpal_accept(rb, lower(substr(code, 1, 4)) || '-' || substr(code, 5));
  perform t_ok('B5 lower case and a dash are fine; paired', j->>'state' = 'paired'
               and j->'partner'->>'school' = 'Alder School');
  perform set_config('test.uid', ta::text, true);
  j := classroom_penpal_status(ra);
  perform t_ok('B6 the inviting class sees it too', j->>'state' = 'paired' and j->'partner'->>'name' = 'Room B');

  -- C: one pen-pal per class
  perform set_config('test.uid', tc::text, true);
  perform t_raises('C1 a spent code cannot be used again', format('select classroom_penpal_accept(%L, %L)', rc, code));
  code2 := classroom_penpal_invite(rc)->>'code';
  perform set_config('test.uid', ta::text, true);
  perform t_raises('C2 a paired class cannot accept another', format('select classroom_penpal_accept(%L, %L)', ra, code2));
  perform t_raises('C3 nor invite another', format('select classroom_penpal_invite(%L)', ra));

  -- D: the week, aggregates only
  insert into community_detections (feeder_id, species, image_url, detected_at, temperature, latitude) values
    (fa, 'Northern Cardinal', 'secret-a.jpg', now() - interval '1 day', 40, 39.3621),
    (fa, 'Northern Cardinal', null,           now() - interval '2 day', 42, 39.3621),
    (fa, 'Squirrel',          null,           now() - interval '2 day', 42, 39.3621),
    (fb, 'Blue Jay',          'secret-b.jpg', now() - interval '1 day', 70, 27.9506),
    (fb, 'Northern Cardinal', null,           now() - interval '1 day', 72, 27.9506);
  w := classroom_penpal_week(ra, now() - interval '7 days', now(), array['squirrel'], 'America/New_York');
  perform t_ok('D1 our side: two cardinals, the squirrel left out', (w->'ours'->>'total')::int = 2);
  perform t_ok('D2 their side, named by class and school', (w->'theirs'->>'total')::int = 2
               and w->'theirs'->>'school' = 'Birch School');
  perform t_ok('D3 latitude to the whole degree only', (w->'theirs'->>'lat')::int = 28 and (w->'ours'->>'lat')::int = 39);
  perform t_ok('D4 no photo, feeder or coordinate anywhere', w::text !~ ('(secret|\.jpg|27\.95|39\.36|' || fb::text || ')'));
  perform t_ok('D5 per-day and per-species', json_array_length(w->'ours'->'days') = 2
               and w->'theirs'->'species'->0->>'sp' in ('Blue Jay', 'Northern Cardinal'));
  perform t_raises('D6 at most a month', format('select classroom_penpal_week(%L, now() - interval ''40 days'', now())', ra));
  perform set_config('test.uid', tc::text, true);
  perform t_raises('D7 a stranger cannot read it', format('select classroom_penpal_week(%L, now() - interval ''7 days'', now())', ra));
  perform t_ok('D8 an unpaired class gets nothing', classroom_penpal_week(rc, now() - interval '7 days', now()) is null);

  -- E: ending
  perform set_config('test.uid', tb::text, true);
  perform t_ok('E1 either teacher can end it', classroom_penpal_end(rb)->>'state' = 'none');
  perform set_config('test.uid', ta::text, true);
  perform t_ok('E2 and it is ended for both', classroom_penpal_status(ra)->>'state' = 'none');
  perform t_ok('E3 the data stops', classroom_penpal_week(ra, now() - interval '7 days', now()) is null);
  j := classroom_penpal_accept(ra, code2);
  perform t_ok('E4 a class that is free again can pair anew', j->>'state' = 'paired' and j->'partner'->>'school' = 'Cedar School');
  perform t_raises('E5 the table is not readable directly',
                   'set local role authenticated; select count(*) from classroom_penpals');
end $$;
