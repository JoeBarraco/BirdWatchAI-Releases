-- ============================================================
-- FIX: Drop the auth trigger that causes "Database error saving new user"
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- The trigger on auth.users was blocking new user creation.
-- The app now auto-creates the profile on first login instead.
drop trigger if exists on_auth_user_created on auth.users;
