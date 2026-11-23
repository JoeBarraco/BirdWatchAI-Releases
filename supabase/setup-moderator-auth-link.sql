-- ============================================================
-- One sign-in for everyone: moderator sessions from Supabase Auth
-- Run after setup-moderators.sql (needs moderators, moderator_sessions).
-- Idempotent.
-- ============================================================
--
-- Before: moderators had a second, password-based login next to the normal
-- magic-link sign-in, and the navbar showed two sets of in/out buttons.
--
-- Now: a moderator signs in like everyone else. Once the browser holds a
-- Supabase Auth session, it calls moderator_login_from_auth(). If the signed-in
-- account's CONFIRMED email matches a row in `moderators`, this mints exactly
-- the same kind of session token moderator_login() does, so every existing
-- moderator RPC and edge function (all of which take p_token) keeps working
-- unchanged.
--
-- Why matching on email is safe: a magic link proves control of the inbox, and
-- we additionally require auth.users.email_confirmed_at, so an account whose
-- email was never verified cannot claim a moderator's address.
--
-- moderator_login(email, password) is left in place as a fallback (e.g. if
-- auth email delivery is down); the site only offers it from a small link in
-- the sign-in dialog.

create or replace function moderator_login_from_auth()
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  uid   uuid := auth.uid();
  em    text;
  m     record;
  tok   text;
  exp   timestamptz;
begin
  if uid is null then
    return null;
  end if;

  select lower(u.email)
    into em
    from auth.users u
   where u.id = uid
     and u.email_confirmed_at is not null;

  if em is null then
    return null;
  end if;

  select id, role, email, display_name
    into m
    from moderators
   where lower(email) = em;

  if m.id is null then
    return null;   -- signed in, but not a moderator
  end if;

  delete from moderator_sessions where expires_at < now();

  tok := encode(gen_random_bytes(32), 'hex');
  exp := now() + interval '8 hours';

  insert into moderator_sessions (token_hash, moderator_id, expires_at)
  values (encode(digest(tok, 'sha256'), 'hex'), m.id, exp);

  return json_build_object(
    'id',                   m.id,
    'role',                 m.role,
    'email',                m.email,
    'display_name',         m.display_name,
    'must_change_password', false,   -- no password involved on this path
    'token',                tok,
    'expires_at',           exp
  );
end;
$$;

-- Signed-in users only. Revoke PUBLIC as well as anon: Postgres grants EXECUTE
-- to PUBLIC by default (see the note on moderator_session_lookup).
revoke execute on function moderator_login_from_auth() from public;
revoke execute on function moderator_login_from_auth() from anon;
grant  execute on function moderator_login_from_auth() to authenticated;
