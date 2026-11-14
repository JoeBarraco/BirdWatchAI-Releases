-- Behaviour tests for setup-classroom-feedback-instant.sql.
--
-- Needs stub-schema.sql and setup-classroom-feedback-instant.sql.
--
-- NEITHER pg_net NOR vault EXISTS in plain postgres:16, so both are stubbed
-- below. The stub for net.http_post does what the real one does — queues a
-- row and returns — and a drain() stands in for the background worker,
-- running the edge function's logic against the queue afterwards. That is
-- the honest shape: the real call is asynchronous and lands after commit,
-- so draining separately is closer to production than calling inline.
--
-- What is actually being proved: ONE INSERT STATEMENT IS ONE POKE, and a
-- run of separate inserts produces ONE EMAIL rather than one each, because
-- the first delivery claims every unnotified row.

create or replace function t_ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '% %', case when cond then 'PASS' else 'FAIL ***' end, label;
end $$;


-- ── Stubs: pg_net and vault ─────────────────────────────────────────

create schema if not exists net;
create schema if not exists vault;

create table if not exists net.sent (id bigserial primary key, url text, at timestamptz default now());

create or replace function net.http_post(url text, body jsonb, headers jsonb)
returns bigint language plpgsql as $$
begin
  insert into net.sent (url) values (url);
  return currval('net.sent_id_seq');
end $$;

create table if not exists vault.decrypted_secrets (name text primary key, decrypted_secret text);

-- What the edge function does, in one place: mail everything unnotified,
-- send nothing when there is nothing. Returns how many rows it mailed, so a
-- 0 is a silent delivery.
create table if not exists net.emails (id bigserial primary key, rows_mailed int);

create or replace function net_drain() returns void language plpgsql as $$
declare r record; n int;
begin
  for r in select * from net.sent order by id loop
    update classroom_question_feedback set notified_at = now()
     where notified_at is null;
    get diagnostics n = row_count;
    -- The function sends nothing at all when there is nothing new.
    if n > 0 then insert into net.emails (rows_mailed) values (n); end if;
  end loop;
  delete from net.sent;
end $$;


do $$
declare
  owner_id uuid := 'a9000000-0000-0000-0000-000000000001';
  cid      uuid;
begin
  insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('service_role_key','test-key') on conflict (name) do nothing;

  insert into auth.users (id,email) values (owner_id,'head@i.example') on conflict do nothing;
  insert into communities (slug,name,kind,owner_user_id)
    values ('inst-school','Instant School','school',owner_id) returning id into cid;

  -- Sections E and F both passed once against a database where the
  -- migration had silently failed to apply: "nothing was queued" and "the
  -- insert survived" are trivially true when there is no trigger at all. A
  -- suite that passes when the thing under test is absent is worse than no
  -- suite, so this runs first and stops everything if it is missing.
  raise notice '';
  raise notice '── 0. The thing under test is actually installed ──';
  perform t_ok('the trigger exists',
    exists (select 1 from pg_trigger where tgname = 'trg_classroom_feedback_notify'));
  if not exists (select 1 from pg_trigger where tgname = 'trg_classroom_feedback_notify') then
    raise exception 'trg_classroom_feedback_notify is missing — apply setup-classroom-feedback-instant.sql first';
  end if;

  raise notice '';
  raise notice '── A. One flag, one poke ──';
  delete from net.sent; delete from net.emails;
  insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
    values (cid,'flag','unclear','q1',owner_id);
  perform t_ok('the insert queued exactly one request',
    (select count(*) from net.sent) = 1);
  perform net_drain();
  perform t_ok('…which mailed one row', (select count(*) from net.emails) = 1);
  perform t_ok('…and the row is marked notified',
    not exists (select 1 from classroom_question_feedback where notified_at is null));

  raise notice '';
  raise notice '── B. Five rows in ONE statement is still one poke ──';
  delete from net.sent; delete from net.emails;
  insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
    select cid,'flag','unclear','bulk '||g, owner_id from generate_series(1,5) g;
  perform t_ok('one request, not five',
    (select count(*) from net.sent) = 1);
  perform net_drain();
  perform t_ok('one email carrying all five',
    (select count(*) from net.emails) = 1
    and (select rows_mailed from net.emails order by id desc limit 1) = 5);

  raise notice '';
  raise notice '── C. Five SEPARATE inserts collapse to one email ──';
  -- This is the case that matters: a teacher working down a review panel.
  delete from net.sent; delete from net.emails;
  for i in 1..5 loop
    insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
      values (cid,'flag','unclear','burst '||i, owner_id);
  end loop;
  perform t_ok('five requests were queued', (select count(*) from net.sent) = 5);
  perform net_drain();
  perform t_ok('but only ONE email was sent',
    (select count(*) from net.emails) = 1);
  perform t_ok('…carrying all five flags',
    (select rows_mailed from net.emails order by id desc limit 1) = 5);
  perform t_ok('…and the other four deliveries were silent, not empty mails',
    (select count(*) from net.emails) = 1);

  raise notice '';
  raise notice '── D. A suggestion pokes it too ──';
  delete from net.sent; delete from net.emails;
  insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
    values (cid,'suggestion','idea','an idea',owner_id);
  perform t_ok('suggestions are not a special case',
    (select count(*) from net.sent) = 1);

  raise notice '';
  raise notice '── E. Nothing stops a teacher filing a flag ──';
  delete from net.sent; delete from net.emails;
  delete from vault.decrypted_secrets where name = 'service_role_key';
  insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
    values (cid,'flag','wrong','no key',owner_id);
  perform t_ok('no vault secret: nothing queued',
    (select count(*) from net.sent) = 0);
  perform t_ok('…but the flag is saved anyway',
    exists (select 1 from classroom_question_feedback where prompt = 'no key'));
  perform t_ok('…and left unnotified for the daily digest to carry',
    exists (select 1 from classroom_question_feedback
             where prompt = 'no key' and notified_at is null));

  insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('service_role_key','test-key');
end $$;

-- A queue that throws must not take the insert with it. Replacing the stub
-- is the only way to make the real one fail on demand.
create or replace function net.http_post(url text, body jsonb, headers jsonb)
returns bigint language plpgsql as $$
begin
  raise exception 'pg_net is having a bad day';
end $$;

do $$
declare cid uuid;
begin
  select id into cid from communities where slug = 'inst-school';
  raise notice '';
  raise notice '── F. A failing queue never costs a flag ──';
  begin
    insert into classroom_question_feedback (community_id, kind, reason, prompt, created_by)
      values (cid,'flag','wrong','queue down','a9000000-0000-0000-0000-000000000001');
    perform t_ok('the insert survived pg_net throwing', true);
  exception when others then
    perform t_ok('the insert survived pg_net throwing', false);
  end;
  perform t_ok('and the flag is in the table',
    exists (select 1 from classroom_question_feedback where prompt = 'queue down'));
end $$;
