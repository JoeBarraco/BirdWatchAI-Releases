-- Behaviour tests for setup-classroom-penpals-public.sql.
--
-- Order: stub-schema.sql, the two detection columns (see penpals.test.sql),
-- setup-classroom-penpals.sql, setup-classroom-penpals-public.sql, this.

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
  pa uuid := 'a1000000-0000-0000-0000-00000000000a';
  pb uuid := 'b1000000-0000-0000-0000-00000000000b';
  pub1 uuid := 'aa100000-0000-0000-0000-000000000000';
  pub2 uuid := 'aa200000-0000-0000-0000-000000000000';
  own  uuid := 'bb100000-0000-0000-0000-000000000000';
  ca uuid; cb uuid; ra uuid; rb uuid; rn uuid; code text; w json;
begin
  insert into communities (slug, name, kind, owner_user_id) values ('fam-a', 'Family A', 'school', pa) returning id into ca;
  insert into communities (slug, name, kind, owner_user_id) values ('fam-b', 'Family B', 'school', pb) returning id into cb;
  insert into community_members (community_id, user_id, role) values (ca, pa, 'owner'), (cb, pb, 'owner');
  -- A: no feeder of its own, learns from two public feeders.
  insert into classrooms (community_id, name, grade_band, teacher_user_id) values (ca, 'Sam', 'k-2', pa) returning id into ra;
  insert into classroom_partner_feeders (classroom_id, feeder_id) values (ra, pub1), (ra, pub2);
  -- B: its own feeder.
  insert into classrooms (community_id, name, grade_band, teacher_user_id, home_feeder_id) values (cb, 'Ava', 'k-2', pb, own) returning id into rb;
  -- N: nothing to watch at all.
  insert into classrooms (community_id, name, grade_band, teacher_user_id) values (ca, 'Nobody', 'k-2', pa) returning id into rn;

  perform t_ok('A1 a class with no home feeder uses its public feeders', classroom_penpal_feeders(ra) = array[pub1, pub2]);
  perform t_ok('A2 a class with one uses only that', classroom_penpal_feeders(rb) = array[own]);

  perform set_config('test.uid', pa::text, true);
  perform t_raises('B1 a class with nothing to watch still cannot pair', format('select classroom_penpal_invite(%L)', rn));
  code := classroom_penpal_invite(ra)->>'code';
  perform t_ok('B2 a public-feeders class can invite', length(code) = 8);
  perform set_config('test.uid', pb::text, true);
  perform t_ok('B3 and be accepted', classroom_penpal_accept(rb, code)->>'state' = 'paired');

  insert into community_detections (feeder_id, species, detected_at, temperature, latitude) values
    (pub1, 'Blue Jay', now() - interval '1 day', 50, 40.1),
    (pub2, 'Blue Jay', now() - interval '2 day', 52, 40.3),
    (pub2, 'Northern Cardinal', now() - interval '2 day', 52, 40.3),
    (own,  'Mourning Dove', now() - interval '1 day', 70, 30.2),
    ('cc000000-0000-0000-0000-000000000000', 'Not ours', now() - interval '1 day', 1, 1);
  perform set_config('test.uid', pa::text, true);
  w := classroom_penpal_week(ra, now() - interval '7 days', now(), '{}', 'America/New_York');
  perform t_ok('C1 our side sums both public feeders', (w->'ours'->>'total')::int = 3);
  perform t_ok('C2 their side is their own feeder', (w->'theirs'->>'total')::int = 1);
  perform t_ok('C3 nobody else''s feeder leaks in', w::text !~ 'Not ours');
  perform t_ok('C4 still latitude to the whole degree', (w->'ours'->>'lat')::int = 40);
end $$;
