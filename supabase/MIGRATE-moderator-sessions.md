# Migration: moderator sessions replace replayed passwords

## What changed and why

The community dashboard used to authenticate every privileged moderator call by
re-sending the moderator's **email + password**. To make that possible the
browser kept the password in `sessionStorage` in plaintext for the whole visit:

```js
sessionStorage.setItem('bwai-mod-pass', password);   // gone
```

`sessionStorage` is readable by any script running on the page, so a single XSS,
a malicious browser extension, or anyone with access to the machine could lift a
working copy of the **highest-privilege credential on the site** — and not a
session, the actual reusable password. Moderators can delete other people's
media, merge and delete feeders, and (as admin) mint and remove moderators.

Now:

- `moderator_login(p_email, p_password)` is the **only** function that ever sees
  a password. It mints a random 256-bit token, stores only its SHA-256, and
  returns the token once.
- Every other moderator RPC and both edge functions take `p_token` / `token`.
- The browser keeps the token and nothing else. The password exists only for the
  moment it takes to POST the login.
- Sessions expire: **8 hours idle** (refreshed on each use), **24 hours** hard
  cap from login. They are revocable server-side — logout deletes the row, a
  password change kills every *other* session, a password reset kills all of
  them, and deleting a moderator cascades their sessions away.

Community (non-moderator) sign-in was already fine: it uses Supabase Auth magic
links, so the browser holds a GoTrue JWT + refresh token and never a password.
That path is untouched.

## Deploy order

The client, the RPCs and the edge functions all change shape together, so apply
them in this order. Between steps 1 and 3 moderator actions will fail; feed
browsing, reactions and community sign-in are unaffected throughout.

### 1. SQL — run in Supabase Dashboard → SQL Editor

Run in this order. `setup-moderators.sql` **must** go first: it creates the
`moderator_sessions` table and the `moderator_session_*` helpers that the other
three files' functions call.

1. `supabase/setup-moderators.sql`
2. `supabase/setup-community-engagement.sql`
3. `supabase/setup-communities.sql`
4. `supabase/setup-licenses.sql`

All four are idempotent and re-runnable. Each drops the old password-taking
signature before creating the token-taking one, so the password-based entry
points are *removed*, not merely bypassed.

### 2. Edge functions

```bash
supabase functions deploy moderator-delete-media
supabase functions deploy send-temp-password
```

### 3. Site

Push `docs/`. `community-auth.js` and `community-communities.js` are pinned with
`?v=2` in `community.html` so moderators can't be left on a cached client that
still sends the old shape.

### 4. Verify

- Sign in as a moderator. In DevTools → Application → Session Storage there
  should be a `bwai-mod-token` and **no** `bwai-mod-pass`.
- Edit a detection, delete a detection with media attached, open the flag queue,
  open the comment history.
- As admin: list moderators, invite one, delete a community.
- Sign out, then confirm `select count(*) from moderator_sessions` dropped.
- Confirm the old shape is really gone:

```sql
select proname, pg_get_function_arguments(oid)
  from pg_proc
 where proname like 'moderator%' or proname like 'mod_%'
    or proname in ('get_flag_queue','resolve_flag','revoke_license',
                   'record_manual_license','community_admin_create',
                   'community_admin_list','community_admin_delete')
 order by proname;
```

Only `moderator_login` and `add_moderator` should still take a password.

If a call returns `PGRST202` (function not found), PostgREST is still holding the
old schema cache — `notify pgrst, 'reload schema';` in the SQL editor.

## Also fixed on the way through

- **`mod_*` functions no longer take a caller-supplied `p_user_id`.** They took
  one on trust, so any moderator could write life-list rows or post comments as
  *any* user id. The acting user now comes from the session token.
- **`revoke execute … from public`** added to `moderator_reset_password` and
  `add_moderator`. They already revoked `anon` and `authenticated`, but Postgres
  grants `EXECUTE` to `PUBLIC` on new functions by default, and revoking a role
  does not remove a `PUBLIC` grant. `moderator_reset_password` *returns* a fresh
  temporary password, so if the `PUBLIC` grant was in fact standing, any caller
  could have taken over any moderator account. Worth confirming against the live
  database:

```sql
select proname, proacl from pg_proc
 where proname in ('moderator_reset_password','add_moderator');
```

  An ACL entry with an empty grantee (`=X/postgres`) is the `PUBLIC` grant.

- **`search_path` pinned** (`public, extensions`) on the security-definer
  functions touched here. Most were unpinned and resolved `crypt()` via the
  caller's search path.

## Known limits

- The token lives in `sessionStorage`, so an XSS can still read *it*. That is a
  deliberate, much smaller exposure: 8-hour idle lifetime, server-revocable, and
  useless for changing the password (which still requires the current one). An
  `httpOnly` cookie would close even that, but the dashboard is static GitHub
  Pages talking straight to Supabase — there is no origin server to set one.
- `moderator_login` is still unthrottled and granted to `anon`, so it remains
  open to online password guessing. Not addressed here; it wants a
  failed-attempt counter or a Supabase rate-limit rule.
- A moderator whose `must_change_password` is set gets a full session, same as
  before. Restricting that session to the change-password call only would be
  tighter.
