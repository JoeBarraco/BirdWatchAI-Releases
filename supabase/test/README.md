# Running the school-subscription tests

`setup-school-subscription.sql` decides whether a school can start a lesson,
which means a mistake in it either gives classroom mode away or stops a class
that has paid for it. Neither failure is visible until a teacher is standing
in front of a room, so it is checked against a real Postgres before it goes
anywhere near Supabase.

```bash
docker run -d --name bwai-pgtest -e POSTGRES_PASSWORD=test postgres:16
docker cp supabase/test/stub-schema.sql                 bwai-pgtest:/tmp/
docker cp supabase/setup-school-subscription.sql        bwai-pgtest:/tmp/
docker cp supabase/setup-school-purchase.sql            bwai-pgtest:/tmp/
docker cp supabase/test/school-subscription.test.sql    bwai-pgtest:/tmp/

docker exec bwai-pgtest psql -U postgres -q -f /tmp/stub-schema.sql
docker exec bwai-pgtest psql -U postgres -q -c "
  insert into communities (slug,name,kind,owner_user_id) values
   ('roland','Roland Park','school','11111111-1111-1111-1111-111111111111'),
   ('birders','Birders','general','11111111-1111-1111-1111-111111111111');
  insert into community_members (community_id,user_id,role)
   select id,'11111111-1111-1111-1111-111111111111','owner' from communities;"
docker exec bwai-pgtest psql -U postgres -q -f /tmp/setup-school-subscription.sql
docker exec bwai-pgtest psql -U postgres -q -f /tmp/setup-school-purchase.sql
docker exec bwai-pgtest psql -U postgres -q -f /tmp/school-subscription.test.sql

docker rm -f bwai-pgtest
```

On Git Bash, prefix the `docker` lines with `MSYS_NO_PATHCONV=1` or the
container paths are rewritten to Windows ones.

For the reminder tests, add:

```bash
docker cp supabase/test/school-reminders.test.sql bwai-pgtest:/tmp/

# The schedule block at the foot of setup-school-reminders.sql needs pg_cron
# and pg_net, which plain postgres:16 has not got. Apply the file up to the
# commit and leave the cron part to Supabase.
sed '/^commit;$/q' supabase/setup-school-reminders.sql > /tmp/reminders-schema.sql
docker cp /tmp/reminders-schema.sql bwai-pgtest:/tmp/
docker exec bwai-pgtest psql -U postgres -q -f /tmp/reminders-schema.sql
docker exec bwai-pgtest psql -U postgres -q -f /tmp/school-reminders.test.sql
```

There are six suites, each needing the migrations it builds on applied first:

| Suite | Needs | Checks |
|---|---|---|
| `school-subscription.test.sql` | subscription + purchase | 68 |
| `school-reminders.test.sql` | + reminders | 37 |
| `classroom-limits.test.sql` | + classroom limits | 25 |
| `feedback-teachers.test.sql` | feedback-teachers only | 18 |
| `challenges.test.sql` | subscription + challenges | 24 |
| `challenge-rooms.test.sql` | + challenge rooms | 20 |
| `challenge-questions.test.sql` | + challenge questions | 16 |

Every check prints `PASS` or `FAIL ***`. Grep for `FAIL`. As of the last run:
206 checks, 0 failures.

The challenge suites need `setup-school-subscription.sql` applied even though
they test neither subscriptions nor money: its trigger refuses to create a
classroom in a school with no live term, so without it the seed fails on a
missing column and the failure looks like a challenge bug.

**In `classroom_challenge_rooms`, no rows means EVERY class**, not none. Every
challenge created before that migration has no rows, so absence has to be the
permissive case; `challenge-rooms.test.sql` section A exists to keep it that
way, because the day it inverts, every existing scoreboard silently empties.

**Run `school-subscription.test.sql` again after any migration that touches a
function it covers.** The classroom-limit work added a parameter to two mint
functions, which `create or replace` turns into a second overload rather than
a replacement — every short-form call then fails with "function is not
unique". That suite caught it; nothing else would have, until a customer's
purchase did.

**`now()` is the transaction timestamp**, and each test's `do $$ … $$` block is
one transaction, so every `now()` inside it is the same instant. Two
`now() + interval '25 days'` expressions in the same block produce a byte-
identical timestamp — which looks like two different terms and is not. That
cost a confusing red `FAIL` on the reminder suite's renewal test, where the
code was right and the test was lying. Use visibly different offsets when a
test means "a different term".

**The suite needs a fresh database.** It creates communities at fixed
addresses, spends codes and moves expiry dates about, so running it twice
against the same container fails about nine checks for reasons that have
nothing to do with the migration. Drop the container and start again rather
than reading those as regressions. Re-running the *migrations* twice is
different, and is worth doing — see below.

The seed is two communities on purpose: one already a school (so the
grandfathering branch runs) and one not (so the "this now costs money" branch
runs). Running the migration a second time against the finished database is
also worth doing by hand — the one regression that would be invisible in
production is a re-run flipping a paying school to `school_perpetual`.

## stub-schema.sql is NOT the real schema

It is the smallest set of tables and functions the migration references, with
the columns it actually touches and nothing else. It exists so the migration
can be executed, not so the application can be.

It will drift. When a test here passes and production disagrees, suspect the
stub first: check the real column against `setup-communities.sql`,
`setup-classrooms.sql` and `setup-community-tiers.sql`, which are the
authority. Do not change the stub to make a test pass without checking that
the real table agrees.

`auth.uid()` is faked from a session setting, so a test chooses who is signed
in with `set_config('test.uid', '<uuid>', false)`. `moderator_session_role`
accepts the literal token `ADMIN-OK`. Neither resembles how Supabase does it;
they only need to return the same shape.

## Re-running an EARLIER migration is not safe just because it is idempotent

Each file is idempotent against itself. That is not the same as being safe to
re-run once a later migration has redefined something in it.
`setup-classroom-challenges.sql` was re-run against production after the two
that follow it, and put back the four-argument `classroom_challenge_create`
beside the five-argument one, the old `classroom_challenge_list` without
`classroom_ids`, and the old `classroom_challenge_standings` without the
roster filter. PostgREST then answered a four-argument call with

    PGRST203: Could not choose the best candidate function between: ...

which is a school unable to create a challenge at all, not a warning.

`fix-challenge-functions.sql` repairs it: both later migrations in one
transaction, drops first, with a check at the foot that raises unless
`classroom_challenge_create` ends with exactly one signature. It was written
against a container in the broken state, and the three challenge suites pass
on the repaired schema.

**Apply the newest migration that mentions a function, not the file that
first created it.** When in doubt, grep the migrations for the function name
and run the last one.
