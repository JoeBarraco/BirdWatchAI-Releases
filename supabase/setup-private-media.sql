-- ============================================================
-- BirdWatchAI — private media buckets
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- Prerequisite: setup-communities.sql
--
-- Closes the gap left open by setup-communities.sql. RLS hides a private
-- feeder's ROW, but its photos and videos live in public storage buckets
-- (/storage/v1/object/public/...), so anyone holding a URL keeps the
-- media forever regardless of community visibility. For a feeder on a
-- school playground that is the difference between "unlisted" and
-- "private".
--
-- Model:
--   * Private feeders upload to detection-{images,videos}-private.
--   * Those buckets are not public, so there is no readable URL at all.
--   * Members mint a short-lived signed URL per object. Supabase checks
--     storage RLS when signing, so the policy below is the whole
--     enforcement — no service key and no edge function involved.
--
-- Object paths are {device_key}/{filename}, which is what lets a policy
-- map an object back to a feeder and therefore to a community.
--
-- SAFE TO RE-RUN.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────
-- 1. Buckets
-- ────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('detection-images-private', 'detection-images-private', false),
       ('detection-videos-private', 'detection-videos-private', false)
on conflict (id) do update set public = false;


-- ────────────────────────────────────────────────────────────────────
-- 2. Can this user read this object?
--
-- SECURITY DEFINER so it reads `feeders` without going through that
-- table's own RLS policy — the same reasoning as the helpers in
-- setup-communities.sql section 3b, and it keeps the storage policy to a
-- single function call rather than a nested policy cascade evaluated per
-- object.
--
-- storage.foldername(name) splits the object path; element 1 is the
-- device_key the server uploads under.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_can_read_media(p_object_name text, p_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public, storage
as $$
  select p_user_id is not null and exists (
    select 1
    from feeders f
    where f.device_key = (storage.foldername(p_object_name))[1]
      and community_user_sees_feeder(f.id, p_user_id)
  );
$$;

grant execute on function community_can_read_media(text, uuid) to anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 3. Storage policies
--
-- NOTE: creating policies on storage.objects needs owner rights. Running
-- this from the SQL Editor works; if it errors with "must be owner of
-- table objects", create the two policies from Storage > Policies in the
-- dashboard using the same expressions.
-- ────────────────────────────────────────────────────────────────────

-- Upload. Same posture as the existing public buckets: the anon key can
-- insert, which is what lets a feeder publish without holding a secret.
-- That does mean anyone with the key can upload junk into these buckets —
-- a pre-existing exposure, not one introduced here, and the follow-up is
-- to move uploads behind a device_key RPC for both public and private.
drop policy if exists "Feeders upload private media" on storage.objects;
create policy "Feeders upload private media" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id in ('detection-images-private', 'detection-videos-private')
  );

-- Read. This is the enforcement point: Supabase evaluates it when a
-- signed URL is minted, so only a member of a community the feeder
-- publishes into can produce a working link. Anon is deliberately absent
-- — a signed-out visitor cannot sign these at all.
drop policy if exists "Members read private media" on storage.objects;
create policy "Members read private media" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('detection-images-private', 'detection-videos-private')
    and community_can_read_media(name, auth.uid())
  );

-- Moderator deletes run through the moderator-delete-media edge function
-- as service_role, which bypasses RLS — so no delete policy is needed.


-- ============================================================
-- 4. Verify
--
--   -- Buckets exist and are private:
--   select id, public from storage.buckets
--    where id like 'detection-%-private';          -- expect: public = false
--
--   -- A member can read their own private feeder's media. Substitute a
--   -- real object path and the member's auth uuid:
--   select community_can_read_media(
--            '<device_key>/<file>.jpg',
--            '<member auth uuid>');                -- expect: true
--
--   -- A non-member cannot:
--   select community_can_read_media(
--            '<device_key>/<file>.jpg',
--            '00000000-0000-0000-0000-000000000000');  -- expect: false
--
--   -- And signed-out is never allowed:
--   select community_can_read_media('<device_key>/<file>.jpg', null);
--                                                   -- expect: false
--
-- ⚠ STILL PUBLIC after this migration: everything already uploaded. This
-- changes where NEW media goes for feeders that are private at upload
-- time. Moving existing objects when a feeder's visibility changes is a
-- separate sweep — see docs/COMMUNITIES.md. For a new school feeder with
-- no published history, this is sufficient on its own.
-- ============================================================
