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

Every check prints `PASS` or `FAIL ***`. Grep for `FAIL`. As of the last run:
68 checks, 0 failures.

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
