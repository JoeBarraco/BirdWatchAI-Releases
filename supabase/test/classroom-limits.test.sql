-- Behavior tests for setup-school-classroom-limits.sql.
-- Needs stub-schema.sql, setup-school-subscription.sql,
-- setup-school-purchase.sql and this file's migration applied.

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

create or replace function t_runs(label text, sql text) returns void
language plpgsql as $$
begin
  execute sql;
  raise notice 'PASS %', label;
exception when others then
  raise notice 'FAIL *** % [%]', label, left(sqlerrm, 80);
end $$;

do $$
declare
  owner_id uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  capped   uuid;
  unl      uuid;
  code     text;
  used     int;
begin
  perform set_config('test.uid', owner_id::text, false);
  insert into auth.users (id, email) values (owner_id, 'head@cap.example')
    on conflict (id) do nothing;

  insert into communities (slug, name, kind, owner_user_id,
                           school_expires_at, classroom_limit)
    values ('cap-school', 'Capped School', 'school', owner_id,
            now() + interval '6 months', 2)
    returning id into capped;
  insert into communities (slug, name, kind, owner_user_id,
                           school_expires_at, classroom_limit)
    values ('unl-school', 'Unlimited School', 'school', owner_id,
            now() + interval '6 months', null)
    returning id into unl;
  insert into community_members (community_id, user_id, role)
    select id, owner_id, 'owner' from communities where slug like '%-school';

  raise notice '';
  raise notice '── A. The cap bites ──';
  perform t_runs('first class',
    format('insert into classrooms (community_id, name) values (%L, ''One'')', capped));
  perform t_runs('second class',
    format('insert into classrooms (community_id, name) values (%L, ''Two'')', capped));
  perform t_raises('third class refused',
    format('insert into classrooms (community_id, name) values (%L, ''Three'')', capped));
  select count(*) into used from classrooms where community_id = capped;
  perform t_ok('…and the two existing ones survived', used = 2);

  raise notice '';
  raise notice '── B. Unlimited really is ──';
  perform t_runs('ten classes on a null limit', format($f$
    insert into classrooms (community_id, name)
    select %L, 'Room ' || g from generate_series(1, 10) g $f$, unl));
  perform t_ok('all ten exist',
    (select count(*) from classrooms where community_id = unl) = 10);

  raise notice '';
  raise notice '── C. Usage reporting ──';
  perform t_ok('capped: used 2 of 2, no room',
    (community_classroom_usage(capped)->>'used')::int = 2
    and (community_classroom_usage(capped)->>'limit')::int = 2
    and (community_classroom_usage(capped)->>'room')::boolean = false);
  -- ->> on a JSON null yields SQL NULL, which is the readable test here.
  -- json has no equality operator at all (only jsonb does), so comparing
  -- ->'limit' to 'null'::json does not even compile.
  perform t_ok('unlimited: limit is null, room true',
    (community_classroom_usage(unl)->>'limit') is null
    and (community_classroom_usage(unl)->>'room')::boolean);
  perform t_ok('status carries the usage',
    (community_school_status(capped)->'classrooms'->>'used')::int = 2);

  raise notice '';
  raise notice '── D. Archiving frees a slot ──';
  update classrooms set archived_at = now()
   where community_id = capped and name = 'One';
  perform t_ok('archived one is not counted',
    (community_classroom_usage(capped)->>'used')::int = 1);
  perform t_runs('so a new class fits again',
    format('insert into classrooms (community_id, name) values (%L, ''Three'')', capped));
  perform t_raises('and the cap closes behind it',
    format('insert into classrooms (community_id, name) values (%L, ''Four'')', capped));

  raise notice '';
  raise notice '── E. Downgrading never deletes ──';
  update communities set classroom_limit = 1 where id = unl;
  perform t_ok('all ten classes still there',
    (select count(*) from classrooms where community_id = unl and archived_at is null) = 10);
  perform t_ok('usage reports over the line honestly',
    (community_classroom_usage(unl)->>'used')::int = 10
    and (community_classroom_usage(unl)->>'room')::boolean = false);
  perform t_raises('but no eleventh',
    format('insert into classrooms (community_id, name) values (%L, ''Eleven'')', unl));

  raise notice '';
  raise notice '── F. The older gates still fire first ──';
  update communities set school_expires_at = now() - interval '90 days',
                         classroom_limit = 99 where id = capped;
  perform t_raises('a lapsed school is refused for the TERM, not the cap',
    format('insert into classrooms (community_id, name) values (%L, ''Nope'')', capped));
  update communities set school_expires_at = now() + interval '6 months'
   where id = capped;

  raise notice '';
  raise notice '── G. A renewal code can change the allowance ──';
  update communities set classroom_limit = 2 where id = capped;
  select (community_mint_school_code('ADMIN-OK','head@cap.example',12,null,null,25)->>'code')
    into code;
  perform t_runs('apply a 25-class renewal',
    format('select community_apply_school_code(%L, %L)', code, capped));
  perform t_ok('the allowance moved to 25',
    (select classroom_limit from communities where id = capped) = 25);

  -- A code that says nothing about classrooms must not silently grant
  -- unlimited: null on the code means "leave what they have".
  select (community_mint_school_code('ADMIN-OK','head@cap.example',12)->>'code')
    into code;
  perform t_runs('apply a renewal with no allowance',
    format('select community_apply_school_code(%L, %L)', code, capped));
  perform t_ok('the allowance is UNCHANGED, not wiped to unlimited',
    (select classroom_limit from communities where id = capped) = 25);

  raise notice '';
  raise notice '── H. A school community code carries it too ──';
  select (community_mint_school_community_code(
            'ADMIN-OK','new@cap.example','medium',12,null,null,5)->>'code') into code;
  perform t_runs('redeem it',
    format('select community_redeem_unlock_code(%L, ''capco'', ''Cap Co'', ''private'')', code));
  perform t_ok('new school has 5 classes and 25 feeders',
    (select classroom_limit = 5 and feeder_limit = 25 and kind = 'school'
       from communities where slug = 'capco'));
  perform t_ok('…and a term already running',
    community_school_active((select id from communities where slug = 'capco')));

  -- Unlimited as a real product, not a magic number.
  select (community_mint_school_community_code(
            'ADMIN-OK','big@cap.example','medium',12,null,null,null)->>'code') into code;
  perform t_runs('redeem an unlimited one',
    format('select community_redeem_unlock_code(%L, ''bigco'', ''Big Co'', ''private'')', code));
  perform t_ok('…and it is null, not 9999',
    (select classroom_limit is null from communities where slug = 'bigco'));
end $$;
