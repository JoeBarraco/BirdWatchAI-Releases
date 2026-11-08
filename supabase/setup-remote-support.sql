-- ════════════════════════════════════════════════════════════════════
-- BirdWatchAI — remote support sessions
-- Run in: Supabase Dashboard > SQL Editor > New Query. Idempotent.
--
-- Lets an ADMIN moderator open a time-limited SSH tunnel to a feeder that
-- has opted in (Settings → Community → "Allow remote support"), carried over
-- Supabase Realtime broadcast. Design: birdwatchai-server/docs/REMOTE-SUPPORT.md.
--
-- What lives here is only the rendezvous: which feeders are accepting, and
-- which session (= secret channel name) is open for which feeder. No tunnel
-- traffic touches the database — it flows over Realtime broadcast.
--
-- Trust model
--   * Feeders authenticate with device_key + write token. A feeder with no
--     token row is REFUSED (stricter than the legacy write path on purpose:
--     remote support is new, so there is no installed base to stay compatible
--     with, and the device key alone is public).
--   * Admins authenticate with a moderator session token (moderator_login)
--     whose role is 'admin'. Plain moderators cannot open sessions.
--   * The channel name is a 256-bit bearer secret, returned only to the
--     opening admin and to the feeder. Realtime public channels admit anyone
--     who knows the name, so the name must never be logged client-side or
--     exposed by a list RPC. SSH auth on the Pi remains the real gate: the
--     feeder only ever connects tunnel streams to its own 127.0.0.1:22.
--   * Every session is kept (opened_by, opened_at, closed_at) as an audit
--     trail. Sessions are capped at 4 hours.
--
-- Prerequisite: Realtime "public channels" must be allowed for the project
-- (Dashboard > Realtime > Settings). It is on by default.
-- ════════════════════════════════════════════════════════════════════


-- Which feeders are accepting remote support, and when they last checked in.
create table if not exists remote_support_feeders (
  feeder_id    uuid primary key references feeders(id) on delete cascade,
  last_poll_at timestamptz not null default now(),
  app_version  text
);

create table if not exists remote_support_sessions (
  id           uuid primary key default gen_random_uuid(),
  feeder_id    uuid        not null references feeders(id) on delete cascade,
  channel      text        not null unique,
  opened_by    uuid        references moderators(id) on delete set null,
  opened_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  closed_at    timestamptz,
  close_reason text
);

create index if not exists remote_support_sessions_feeder_idx
  on remote_support_sessions (feeder_id, opened_at desc);

-- No anon/authenticated access by any route; only the definer functions
-- below touch these tables.
alter table remote_support_feeders  enable row level security;
alter table remote_support_sessions enable row level security;
revoke all on table remote_support_feeders  from anon, authenticated;
revoke all on table remote_support_sessions from anon, authenticated;

drop policy if exists "Service role full access remote support feeders" on remote_support_feeders;
create policy "Service role full access remote support feeders" on remote_support_feeders
  for all to service_role using (true) with check (true);
drop policy if exists "Service role full access remote support sessions" on remote_support_sessions;
create policy "Service role full access remote support sessions" on remote_support_sessions
  for all to service_role using (true) with check (true);


-- ────────────────────────────────────────────────────────────────────
-- Feeder: "I'm accepting — is a session waiting for me?"
-- Called every ~20 s by feeders with remote support switched on.
-- Returns null, or {session_id, channel, expires_at, opened_by}.
-- Raises on a bad device key / token so a misconfigured feeder sees why.
-- ────────────────────────────────────────────────────────────────────
create or replace function remote_support_poll(
  p_device_key  text,
  p_write_token text,
  p_app_version text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  fid uuid;
  s   record;
begin
  if p_device_key is null or p_write_token is null or length(p_write_token) < 32 then
    raise exception 'remote_support_poll: device key and write token are required';
  end if;

  select f.id into fid
    from feeders f
    join feeder_write_tokens t on t.feeder_id = f.id
   where f.device_key = p_device_key
     and t.token = p_write_token
   limit 1;

  if fid is null then
    raise exception 'remote_support_poll: unknown feeder or wrong write token';
  end if;

  insert into remote_support_feeders (feeder_id, last_poll_at, app_version)
  values (fid, now(), left(p_app_version, 64))
  on conflict (feeder_id) do update
     set last_poll_at = excluded.last_poll_at,
         app_version  = excluded.app_version;

  select rs.id, rs.channel, rs.expires_at, m.email as opened_by
    into s
    from remote_support_sessions rs
    left join moderators m on m.id = rs.opened_by
   where rs.feeder_id = fid
     and rs.closed_at is null
     and rs.expires_at > now()
   order by rs.opened_at desc
   limit 1;

  if s.id is null then
    return null;
  end if;

  return json_build_object(
    'session_id', s.id,
    'channel',    s.channel,
    'expires_at', s.expires_at,
    'opened_by',  s.opened_by
  );
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Admin: feeders currently accepting remote support (checked in within the
-- last 2 minutes). Never returns channel names.
-- ────────────────────────────────────────────────────────────────────
create or replace function remote_support_list(p_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if moderator_session_role(p_token) is distinct from 'admin' then
    raise exception 'remote_support_list: admin moderator session required';
  end if;

  return coalesce((
    select json_agg(json_build_object(
             'feeder_id',      f.id,
             'display_name',   f.display_name,
             'last_poll_at',   r.last_poll_at,
             'app_version',    r.app_version,
             'session_until',  (select max(rs.expires_at) from remote_support_sessions rs
                                 where rs.feeder_id = f.id and rs.closed_at is null and rs.expires_at > now()),
             -- The open session's id, so an admin can close it from the web panel. Not the channel
             -- (that's the bearer secret and is never returned by a list RPC).
             'session_id',     (select rs.id from remote_support_sessions rs
                                 where rs.feeder_id = f.id and rs.closed_at is null and rs.expires_at > now()
                                 order by rs.opened_at desc limit 1)
           ) order by f.display_name)
      from remote_support_feeders r
      join feeders f on f.id = r.feeder_id
     where r.last_poll_at > now() - interval '2 minutes'
  ), '[]'::json);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Admin: open (or extend) a session for one feeder.
-- Returns {session_id, channel, expires_at}. If a session is already open
-- for the feeder it is extended and returned rather than duplicated, so a
-- reconnecting admin lands on the channel the feeder is already sitting in.
-- ────────────────────────────────────────────────────────────────────
create or replace function remote_support_open(
  p_token     text,
  p_feeder_id uuid,
  p_minutes   int default 60
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  mod_id  uuid;
  mins    int := least(greatest(coalesce(p_minutes, 60), 5), 240);
  s       record;
begin
  if moderator_session_role(p_token) is distinct from 'admin' then
    raise exception 'remote_support_open: admin moderator session required';
  end if;
  mod_id := moderator_session_id(p_token);

  if not exists (select 1 from remote_support_feeders r
                  where r.feeder_id = p_feeder_id
                    and r.last_poll_at > now() - interval '2 minutes') then
    raise exception 'remote_support_open: that feeder is not accepting remote support (switched off, or offline)';
  end if;

  update remote_support_sessions
     set expires_at = greatest(expires_at, now() + make_interval(mins => mins))
   where feeder_id = p_feeder_id
     and closed_at is null
     and expires_at > now()
  returning id, channel, expires_at into s;

  if s.id is null then
    insert into remote_support_sessions (feeder_id, channel, opened_by, expires_at)
    values (
      p_feeder_id,
      -- 256 bits from two v4 UUIDs (as feeder_write_tokens does): the channel
      -- name is the secret, so it must not be guessable.
      'bwrs-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      mod_id,
      now() + make_interval(mins => mins)
    )
    returning id, channel, expires_at into s;
  end if;

  return json_build_object('session_id', s.id, 'channel', s.channel, 'expires_at', s.expires_at);
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Admin: close a session. The feeder drops the channel on its next poll.
-- ────────────────────────────────────────────────────────────────────
create or replace function remote_support_close(p_token text, p_session_id uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if moderator_session_role(p_token) is distinct from 'admin' then
    raise exception 'remote_support_close: admin moderator session required';
  end if;

  update remote_support_sessions
     set closed_at = now(), close_reason = left(coalesce(p_reason, 'closed by admin'), 200)
   where id = p_session_id and closed_at is null;
  return found;
end;
$$;


-- ────────────────────────────────────────────────────────────────────
-- Grants. Revoke from PUBLIC *and* anon/authenticated first: Postgres grants
-- EXECUTE to PUBLIC on every new function, and Supabase adds the API roles on
-- top — see the CLAUDE.md gotcha in birdwatchai-server.
-- ────────────────────────────────────────────────────────────────────
revoke execute on function remote_support_poll(text, text, text)    from public, anon, authenticated;
revoke execute on function remote_support_list(text)                from public, anon, authenticated;
revoke execute on function remote_support_open(text, uuid, int)     from public, anon, authenticated;
revoke execute on function remote_support_close(text, uuid, text)   from public, anon, authenticated;

grant execute on function remote_support_poll(text, text, text)     to anon, authenticated;
grant execute on function remote_support_list(text)                 to anon, authenticated;
grant execute on function remote_support_open(text, uuid, int)      to anon, authenticated;
grant execute on function remote_support_close(text, uuid, text)    to anon, authenticated;


-- Verify (expect no rows): nothing here callable by PUBLIC.
-- select proname from pg_proc
--  where pronamespace = 'public'::regnamespace
--    and proname like 'remote_support_%'
--    and has_function_privilege('public', oid, 'EXECUTE');
