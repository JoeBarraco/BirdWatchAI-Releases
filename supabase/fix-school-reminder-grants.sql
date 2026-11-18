-- ============================================================
-- Close the school-reminder functions to everyone but the server
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Found 2026-11-18 while checking grants after setup-home-trial-no-grace.sql.
-- setup-school-reminders.sql GRANTed these to service_role but never
-- REVOKEd the default EXECUTE that Postgres gives PUBLIC on every new
-- function (the PUBLIC-grant trap again), so with the publishable key:
--   * school_terms_due_reminders() returned each school's owner email and
--     name whenever its term was within 30 days of ending;
--   * school_reminder_mark(...) let anyone mark a reminder as sent, which
--     silences that school's renewal emails;
--   * community_school_reminder_stage(uuid) answered for any community id.
-- Only the school-term-reminders edge function calls them, with the service
-- role, so nothing else loses anything. setup-school-reminders.sql now
-- revokes them too, so a re-run does not reopen this.
-- ============================================================

begin;
revoke execute on function school_terms_due_reminders()                          from public, anon, authenticated;
revoke execute on function school_reminder_mark(uuid, text, timestamptz, text)     from public, anon, authenticated;
revoke execute on function community_school_reminder_stage(uuid)                   from public, anon, authenticated;
grant  execute on function school_terms_due_reminders()                          to service_role;
grant  execute on function school_reminder_mark(uuid, text, timestamptz, text)     to service_role;
grant  execute on function community_school_reminder_stage(uuid)                   to service_role;
commit;
