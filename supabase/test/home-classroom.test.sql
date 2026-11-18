-- Behaviour tests for setup-home-classroom.sql.
--
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-school-purchase.sql, setup-school-classroom-limits.sql, then
-- setup-home-classroom.sql.

-- The real table has a logo (setup-community-logos.sql); the stub does not.
alter table communities add column if not exists logo_url text;

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
  raise notice 'PASS % [%]', label, left(sqlerrm, 64);
end $$;

do $$
declare
  mom   uuid := 'e0000000-0000-0000-0000-0000000000a1';
  dad   uuid := 'e0000000-0000-0000-0000-0000000000a2';
  head  uuid := 'e0000000-0000-0000-0000-0000000000a3';
  j json; j2 json; hid uuid; sid uuid; c communities%rowtype; homecode text; schoolcode text;
begin
  insert into auth.users (id, email) values (mom, 'mom@h.example'), (dad, 'dad@h.example'), (head, 'head@s.example')
  on conflict do nothing;

  -- A: start
  perform set_config('test.uid', '', true);
  perform t_raises('A1 signed out cannot start one', 'select home_classroom_start(''x'')');
  perform set_config('test.uid', mom::text, true);
  j := home_classroom_start('The Lopez Kitchen Window');
  hid := (j->>'community_id')::uuid;
  select * into c from communities where id = hid;
  perform t_ok('A2 it is a private, one-family school community marked home',
               c.is_home and c.kind = 'school' and c.visibility = 'private' and c.suppress_location
               and c.owner_user_id = mom and c.name = 'The Lopez Kitchen Window');
  perform t_ok('A3 a trial term (7 days, setup-home-trial-7-days.sql)', c.school_expires_at between now() + interval '6 days' and now() + interval '31 days'
               and (j->>'trial')::boolean);
  perform t_ok('A4 four children and three feeders', c.classroom_limit = 4 and c.feeder_limit = 3);
  perform t_ok('A5 the parent is its owner', community_role(hid, mom) = 'owner');
  perform t_ok('A6 the address is home-xxxxxxxx', c.slug ~ '^home-[a-z0-9]{8}$');
  perform t_ok('A7 it can start lessons', community_school_state(hid) = 'active');
  j2 := home_classroom_start('Something else');
  perform t_ok('A8 pressing again gives the same one back', (j2->>'community_id')::uuid = hid and not (j2->>'created')::boolean);

  -- B: one trial per person, even after deleting
  delete from communities where id = hid;
  j := home_classroom_start(null);
  select * into c from communities where id = (j->>'community_id')::uuid;
  perform t_ok('B1 a second Home Classroom has no trial', not (j->>'trial')::boolean and c.school_expires_at is null);
  perform t_ok('B2 and is lapsed straight away (no grace month)', community_school_state(c.id) = 'lapsed');
  perform t_ok('B3 default name', c.name = 'Our Home Classroom');
  hid := c.id;

  -- C: home codes
  insert into community_unlock_codes (code, product, school_months, classroom_limit, for_home, customer_email, source)
    values ('BWH-AAAA-BBBB-CCCC', 'school', 12, 4, true, 'mom@h.example', 'manual');
  insert into community_unlock_codes (code, product, school_months, classroom_limit, customer_email, source)
    values ('BWS-AAAA-BBBB-CCCC', 'school', 12, 30, 'head@s.example', 'manual');
  j := community_apply_school_code('bwh-aaaa-bbbb-cccc', hid);
  perform t_ok('C1 a home code renews a Home Classroom for a year', community_school_state(hid) = 'active'
               and (select school_expires_at from communities where id = hid) > now() + interval '360 days');
  perform set_config('test.uid', head::text, true);
  insert into communities (slug, name, kind, owner_user_id, school_expires_at, tier, feeder_limit)
    values ('real-school', 'Real School', 'school', head, now() + interval '10 days', 'large', 100) returning id into sid;
  insert into community_members (community_id, user_id, role) values (sid, head, 'owner');
  insert into community_unlock_codes (code, product, school_months, classroom_limit, for_home, customer_email, source)
    values ('BWH-DDDD-EEEE-FFFF', 'school', 12, 4, true, 'x@h.example', 'manual');
  perform t_raises('C2 a home code does NOT renew a school', format('select community_apply_school_code(%L, %L)', 'BWH-DDDD-EEEE-FFFF', sid));
  perform t_ok('C3 and is not spent by trying', (select redeemed_at from community_unlock_codes where code = 'BWH-DDDD-EEEE-FFFF') is null);
  perform set_config('test.uid', mom::text, true);
  j := community_apply_school_code('BWS-AAAA-BBBB-CCCC', hid);
  perform t_ok('C4 a school code still works on a Home Classroom', (j->>'months')::int = 12);

  -- D: privacy
  perform set_config('test.uid', dad::text, true);
  perform t_raises('D1 someone else cannot apply codes to it', format('select community_apply_school_code(%L, %L)', 'BWH-DDDD-EEEE-FFFF', hid));
  j := home_classroom_start('Dad''s');
  perform t_ok('D2 another person gets their own, with their own trial', (j->>'community_id')::uuid <> hid and (j->>'trial')::boolean);

  -- E: my communities
  perform set_config('test.uid', mom::text, true);
  j := community_my_communities();
  perform t_ok('E1 my communities says kind and is_home', (j->0->>'is_home')::boolean and j->0->>'kind' = 'school');
  perform t_raises('E2 the trial table is not readable directly', 'set local role authenticated; select count(*) from home_classroom_trials');
end $$;
