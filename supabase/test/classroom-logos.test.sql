-- Behaviour tests for setup-classroom-logos.sql (the upload rule and
-- classroom_set_logo; classroom_list's extra column is checked on a real
-- database, since the stub has none of the columns it selects).
--
-- Order: stub-schema.sql, then setup-classroom-logos.sql up to the
-- classroom_list section (sed '/-- classroom_list as it is/q' and add
-- "commit;"), then this file.

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
  own uuid := 'f2000000-0000-0000-0000-0000000000a1';
  tch uuid := 'f2000000-0000-0000-0000-0000000000a2';
  oth uuid := 'f2000000-0000-0000-0000-0000000000a3';
  cid uuid; cid2 uuid; mine uuid; theirs uuid; u text;
begin
  insert into communities (slug, name, kind, owner_user_id) values ('lg', 'Logo School', 'school', own) returning id into cid;
  insert into communities (slug, name, kind, owner_user_id) values ('lg2', 'Other School', 'school', oth) returning id into cid2;
  insert into community_members (community_id, user_id, role) values (cid, own, 'owner'), (cid, tch, 'teacher'), (cid2, oth, 'owner');
  insert into classrooms (community_id, name, teacher_user_id) values (cid, 'Room T', tch) returning id into mine;
  insert into classrooms (community_id, name, teacher_user_id) values (cid, 'Room O', own) returning id into theirs;

  perform t_ok('A1 the owner may still upload the community logo', community_logo_upload_ok(cid || '/logo-1.png', own));
  perform t_ok('A2 a teacher may not upload the community logo', not community_logo_upload_ok(cid || '/logo-1.png', tch));
  perform t_ok('A3 a teacher may upload their own class''s logo', community_logo_upload_ok(cid || '/classes/' || mine || '/logo-1.png', tch));
  perform t_ok('A4 but not another teacher''s class', not community_logo_upload_ok(cid || '/classes/' || theirs || '/logo-1.png', tch));
  perform t_ok('A5 the owner may upload any class''s logo', community_logo_upload_ok(cid || '/classes/' || mine || '/logo-1.png', own));
  perform t_ok('A6 a class filed under the wrong community is refused', not community_logo_upload_ok(cid2 || '/classes/' || mine || '/logo-1.png', oth));
  perform t_ok('A7 an outsider may upload nothing here', not community_logo_upload_ok(cid || '/classes/' || mine || '/logo-1.png', oth));
  perform t_ok('A8 a bare classes/ folder with no file is refused', not community_logo_upload_ok(cid || '/classes/' || mine || '/', tch));

  perform set_config('test.uid', tch::text, true);
  u := 'https://lsamggztfizmkyljdgwq.supabase.co/storage/v1/object/public/community-logos/' || cid || '/classes/' || mine || '/logo-9.png';
  perform classroom_set_logo(mine, u);
  perform t_ok('B1 a teacher sets their class''s logo', (select logo_url from classrooms where id = mine) = u);
  perform t_raises('B2 a URL from another class is refused', format('select classroom_set_logo(%L, %L)', mine,
      'https://lsamggztfizmkyljdgwq.supabase.co/storage/v1/object/public/community-logos/' || cid || '/classes/' || theirs || '/x.png'));
  perform t_raises('B3 an outside URL is refused', format('select classroom_set_logo(%L, %L)', mine, 'https://evil.example/x.png'));
  perform t_raises('B4 not another teacher''s class', format('select classroom_set_logo(%L, null)', theirs));
  perform classroom_set_logo(mine, null);
  perform t_ok('B5 clearing it', (select logo_url from classrooms where id = mine) is null);
end $$;
