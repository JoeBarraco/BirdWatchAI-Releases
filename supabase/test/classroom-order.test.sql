-- Behaviour tests for classroom_set_order (setup-classroom-order.sql; the
-- classroom_list part is checked on production, the stub lacks its columns).
-- Order: stub-schema.sql, then setup-classroom-order.sql up to its
-- classroom_list section plus "commit;", then this.

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
  own uuid := 'f4000000-0000-0000-0000-0000000000a1'; tch uuid := 'f4000000-0000-0000-0000-0000000000a2';
  cid uuid; cid2 uuid; a uuid; b uuid; c uuid; x uuid;
begin
  insert into communities (slug, name, kind, owner_user_id) values ('ord', 'Order', 'school', own) returning id into cid;
  insert into communities (slug, name, kind, owner_user_id) values ('ord2', 'Order 2', 'school', own) returning id into cid2;
  insert into community_members (community_id, user_id, role) values (cid, own, 'owner'), (cid, tch, 'teacher'), (cid2, own, 'owner');
  insert into classrooms (community_id, name, teacher_user_id) values (cid, 'A', own) returning id into a;
  insert into classrooms (community_id, name, teacher_user_id) values (cid, 'B', tch) returning id into b;
  insert into classrooms (community_id, name, teacher_user_id) values (cid, 'C', own) returning id into c;
  insert into classrooms (community_id, name, teacher_user_id) values (cid2, 'X', own) returning id into x;

  perform set_config('test.uid', own::text, true);
  perform classroom_set_order(array[c, a, b]);
  perform t_ok('A1 the owner orders all three', (select array_agg(name order by sort_order) from classrooms where community_id = cid) = array['C','A','B']);
  perform t_raises('A2 not across communities', format('select classroom_set_order(array[%L, %L]::uuid[])', a, x));
  perform t_raises('A3 not the same class twice', format('select classroom_set_order(array[%L, %L]::uuid[])', a, a));
  perform set_config('test.uid', tch::text, true);
  perform t_raises('B1 a teacher cannot move classes that are not theirs', format('select classroom_set_order(array[%L, %L]::uuid[])', b, a));
  perform t_ok('B2 and nothing changed', (select array_agg(name order by sort_order) from classrooms where community_id = cid) = array['C','A','B']);
  perform classroom_set_order(array[b]);
  perform t_ok('B3 a teacher may place their own', (select sort_order from classrooms where id = b) = 1);
end $$;
