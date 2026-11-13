-- Behaviour tests for setup-school-subscription.sql.
-- Each check reports PASS/FAIL; expected failures are caught, not fatal.

\set QUIET on
\pset tuples_only on
\pset format unaligned

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;

-- Did this statement raise, and with what?
create or replace function t_raises(label text, sql text) returns void
language plpgsql as $$
begin
  execute sql;
  raise notice 'FAIL *** % (expected an error, got none)', label;
exception when others then
  raise notice 'PASS % [%]', label, left(sqlerrm, 64);
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
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  other_id uuid := '22222222-2222-2222-2222-222222222222';
  roland   uuid;
  birders  uuid;
  code1    text;
  code2    text;
  code3    text;
  room     uuid;
  sess     uuid;
  exp1     timestamptz;
  exp2     timestamptz;
  n        int;
begin
  select id into roland  from communities where slug = 'roland';
  select id into birders from communities where slug = 'birders';
  perform set_config('test.uid', owner_id::text, false);

  raise notice '';
  raise notice '── 1. Grandfathering ──';
  perform t_ok('existing school got a term, not a perpetual grant',
    (select not school_perpetual and school_expires_at is not null
       from communities where id = roland));
  perform t_ok('that term is ~12 months out',
    (select school_expires_at from communities where id = roland)
      between now() + interval '358 days' and now() + interval '372 days');
  perform t_ok('grandfathered school reads as active',
    community_school_active(roland));
  perform t_ok('grandfathered school state = active',
    community_school_state(roland) = 'active');
  perform t_ok('non-school got no term',
    (select not school_perpetual and school_expires_at is null
       from communities where id = birders));
  perform t_ok('plain community is not active',
    not community_school_active(birders));
  perform t_ok('plain community state = not_school',
    community_school_state(birders) = 'not_school');

  raise notice '';
  raise notice '── 1b. Admin grants a perpetual term by hand ──';
  perform t_raises('a bad admin token cannot set a term',
    'select community_set_school_term(''NOPE'', ''roland'', 12)');
  perform t_raises('an unknown slug is refused',
    'select community_set_school_term(''ADMIN-OK'', ''nosuch'', 12)');
  perform t_runs('admin makes roland perpetual',
    'select community_set_school_term(''ADMIN-OK'', ''roland'', null)');
  perform t_ok('roland is now perpetual with no date',
    (select school_perpetual and school_expires_at is null
       from communities where id = roland));
  perform t_ok('perpetual state = perpetual',
    community_school_state(roland) = 'perpetual');

  raise notice '';
  raise notice '── 2. The free checkbox no longer grants school ──';
  perform t_raises('set_kind(school) without a term is refused',
    format('select community_set_kind(%L, %L)', birders, 'school'));
  perform t_ok('…and the community is still general',
    (select kind from communities where id = birders) = 'general');

  raise notice '';
  raise notice '── 3. Minting ──';
  perform t_raises('mint with a bad admin token is refused',
    'select community_mint_school_code(''NOPE'', ''a@b.com'', 12)');
  perform t_raises('mint with 0 months is refused',
    'select community_mint_school_code(''ADMIN-OK'', ''a@b.com'', 0)');

  select (community_mint_school_code('ADMIN-OK','school@example.com',12,'A School','PO-1')->>'code')
    into code1;
  perform t_ok('minted a code', code1 is not null);
  perform t_ok('code is BWS-prefixed and 16 chars', code1 ~ '^BWS(-[A-Z2-9]{4}){3}$');
  perform t_ok('code has no I/O/0/1', code1 !~ '[IO01]');
  perform t_ok('order_reference stored, not gumroad_sale_id',
    (select order_reference = 'PO-1' and gumroad_sale_id is null
       from community_unlock_codes where code = code1));

  raise notice '';
  raise notice '── 4. Applying a code ──';
  perform set_config('test.uid', other_id::text, false);
  perform t_raises('a non-owner cannot apply a code',
    format('select community_apply_school_code(%L, %L)', code1, birders));
  perform t_ok('…and the code is still unspent',
    (select redeemed_at is null from community_unlock_codes where code = code1));

  perform set_config('test.uid', owner_id::text, false);
  perform t_runs('owner applies the code',
    format('select community_apply_school_code(%L, %L)', code1, birders));

  select school_expires_at into exp1 from communities where id = birders;

  perform t_ok('community became a school',
    (select kind from communities where id = birders) = 'school');
  perform t_ok('term is ~12 months out',
    exp1 between now() + interval '358 days' and now() + interval '372 days');
  perform t_ok('state is active', community_school_state(birders) = 'active');
  perform t_ok('code records the community it was applied to',
    (select community_id from community_unlock_codes where code = code1) = birders);

  perform t_raises('the same code cannot be used twice',
    format('select community_apply_school_code(%L, %L)', code1, birders));
  perform t_ok('…and the term did not move',
    (select school_expires_at from communities where id = birders) = exp1);

  raise notice '';
  raise notice '── 5. Perpetual communities refuse a code ──';
  select (community_mint_school_code('ADMIN-OK','x@example.com',12)->>'code') into code2;
  perform t_raises('applying to a perpetual community is refused',
    format('select community_apply_school_code(%L, %L)', code2, roland));
  perform t_ok('…and that code is still unspent',
    (select redeemed_at is null from community_unlock_codes where code = code2));

  raise notice '';
  raise notice '── 6. A community code is not a school code ──';
  insert into community_unlock_codes (code, product, tier, feeder_limit, customer_email)
  values ('BWC-TEST-TEST-TEST', 'community', 'small', 5, 'c@example.com');
  perform t_raises('a product=community code is rejected',
    format('select community_apply_school_code(%L, %L)', 'BWC-TEST-TEST-TEST', birders));

  raise notice '';
  raise notice '── 7. Running lessons while the term is live ──';
  insert into classrooms (community_id, name, teacher_user_id)
  values (birders, 'Test Class', owner_id) returning id into room;
  perform t_ok('classroom created while active', room is not null);
  insert into classroom_sessions (classroom_id, started_by)
  values (room, owner_id) returning id into sess;
  perform t_ok('session started while active', sess is not null);

  raise notice '';
  raise notice '── 8. Grace window ──';
  update communities set school_expires_at = now() - interval '10 days' where id = birders;
  perform t_ok('state is grace', community_school_state(birders) = 'grace');
  perform t_ok('still counts as active', community_school_active(birders));
  perform t_runs('a lesson can still start in grace',
    format('insert into classroom_sessions (classroom_id, started_by) values (%L, %L)', room, owner_id));
  perform t_runs('a class can still be created in grace',
    format('insert into classrooms (community_id, name, teacher_user_id) values (%L, ''Grace Class'', %L)', birders, owner_id));

  raise notice '';
  raise notice '── 9. Lapsed ──';
  update communities set school_expires_at = now() - interval '40 days' where id = birders;
  perform t_ok('state is lapsed', community_school_state(birders) = 'lapsed');
  perform t_ok('not active', not community_school_active(birders));
  perform t_ok('kind is STILL school (teachers keep their role)',
    (select kind from communities where id = birders) = 'school');
  perform t_raises('a new lesson is refused',
    format('insert into classroom_sessions (classroom_id, started_by) values (%L, %L)', room, owner_id));
  perform t_raises('a new class is refused',
    format('insert into classrooms (community_id, name, teacher_user_id) values (%L, ''Nope'', %L)', birders, owner_id));
  perform t_runs('ending a running session still works',
    format('update classroom_sessions set ended_at = now() where id = %L', sess));
  perform t_runs('scoring a session still works',
    format('update classroom_sessions set correct_count = correct_count + 1 where id = %L', sess));
  select count(*) into n from classroom_sessions where classroom_id = room;
  perform t_ok('nothing was deleted', n >= 2);

  raise notice '';
  raise notice '── 10. Renewal ──';
  select (community_mint_school_code('ADMIN-OK','school@example.com',12)->>'code') into code3;
  perform t_runs('a lapsed school can renew',
    format('select community_apply_school_code(%L, %L)', code3, birders));
  select school_expires_at into exp2 from communities where id = birders;
  perform t_ok('lapsed renewal runs from TODAY, not the old date',
    exp2 between now() + interval '358 days' and now() + interval '372 days');
  perform t_ok('lessons work again', community_school_active(birders));

  -- Early renewal must stack, not reset.
  update communities set school_expires_at = now() + interval '30 days' where id = birders;
  select (community_mint_school_code('ADMIN-OK','school@example.com',12)->>'code') into code3;
  perform community_apply_school_code(code3, birders);
  select school_expires_at into exp2 from communities where id = birders;
  perform t_ok('early renewal stacks onto the remaining term',
    exp2 between now() + interval '388 days' and now() + interval '402 days');

  raise notice '';
  raise notice '── 11. Turning school mode off and on inside a paid term ──';
  perform t_runs('owner deletes the classes first',
    format('delete from classrooms where community_id = %L', birders));
  perform t_runs('owner turns school mode off',
    format('select community_set_kind(%L, ''general'')', birders));
  perform t_runs('owner turns it back on free, because the term is live',
    format('select community_set_kind(%L, ''school'')', birders));

  raise notice '';
  raise notice '── 12. Status payload ──';
  perform t_ok('status: can_start true while active',
    (community_school_status(birders)->>'can_start')::boolean);
  perform t_ok('status: days_left is a number',
    (community_school_status(birders)->>'days_left') ~ '^[0-9]+$');
  perform t_ok('status: perpetual school has null days_left',
    (community_school_status(roland)->>'days_left') is null);
  perform set_config('test.uid', other_id::text, false);
  perform t_raises('a non-member cannot read the status',
    format('select community_school_status(%L)', birders));

  raise notice '';
  raise notice '── 13. Buying a school community outright ──';
  perform set_config('test.uid', other_id::text, false);

  -- A plain community code still makes a plain community.
  select (community_mint_school_community_code('ADMIN-OK','plain@example.com','small',12)->>'code')
    into code1;
  insert into community_unlock_codes (code, product, tier, feeder_limit, customer_email)
  values ('BWC-PLAI-NPLA-INPL', 'community', 'small', 5, 'plain@example.com');
  perform t_runs('a code with no school_months makes a general community',
    'select community_redeem_unlock_code(''BWC-PLAI-NPLA-INPL'', ''plainco'', ''Plain Co'', ''public'')');
  perform t_ok('…and it is not a school',
    (select kind = 'general' and school_expires_at is null
       from communities where slug = 'plainco'));

  -- A school-community code makes a school with the clock already running.
  perform t_runs('a school-community code is redeemable',
    format('select community_redeem_unlock_code(%L, ''newschool'', ''New School'', ''private'')', code1));
  perform t_ok('the new community is a school',
    (select kind = 'school' from communities where slug = 'newschool'));
  perform t_ok('…with a ~12 month term already running',
    (select school_expires_at from communities where slug = 'newschool')
      between now() + interval '358 days' and now() + interval '372 days');
  perform t_ok('…and is not perpetual',
    (select not school_perpetual from communities where slug = 'newschool'));
  perform t_ok('…and carries its tier',
    (select tier = 'small' and feeder_limit = 5 from communities where slug = 'newschool'));
  perform t_ok('…and can start lessons',
    community_school_active((select id from communities where slug = 'newschool')));

  -- The cross-product mistake that would cost a customer a year.
  select (community_mint_school_code('ADMIN-OK','renew@example.com',12)->>'code') into code2;
  perform t_raises('a RENEWAL code cannot create a community',
    format('select community_redeem_unlock_code(%L, ''wrongco'', ''Wrong Co'', ''public'')', code2));
  perform t_ok('…and the renewal code is still unspent',
    (select redeemed_at is null from community_unlock_codes where code = code2));
  perform t_ok('…and no community was created',
    not exists (select 1 from communities where slug = 'wrongco'));
end $$;
