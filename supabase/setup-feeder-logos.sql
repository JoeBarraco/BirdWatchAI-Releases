-- ============================================================
-- BirdWatchAI — feeder logos
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- Prerequisites: setup-communities.sql, setup-private-media.sql,
--                setup-feeder-write-tokens.sql
--
-- Lets a feeder owner attach an image — a logo, a crest, a photo of the
-- feeder itself — to their feeder, so the community dashboard, the
-- screensaver and the server's own page can show who a sighting came
-- from rather than just printing a name.
--
-- Model, deliberately the same shape as detection media:
--   * Public feeders upload to  feeder-logos.
--   * Private feeders upload to feeder-logos-private, which is not
--     public, so there is no readable URL and members mint a short-lived
--     signed URL per object.
--   * Object paths are {device_key}/{filename}, which is what lets
--     community_can_read_media() map an object back to a feeder and
--     therefore to a community. Reusing that path convention means this
--     migration needs no new read helper.
--   * feeders.logo_url holds either a public URL or a private://bucket/path
--     marker, exactly as community_detections.image_url already does, so
--     every client that already resolves those markers needs no new
--     branch for logos.
--
-- The write goes through an RPC rather than a PATCH for the same reason
-- the heartbeat does: once the feeders SELECT policy hides a private
-- feeder's row, that feeder cannot see — let alone update — its own row
-- through the anon key.
--
-- SAFE TO RE-RUN.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────
-- 1. Column
--
-- Nullable with no default: "no logo" is the overwhelmingly common
-- state and should cost nothing to represent.
-- ────────────────────────────────────────────────────────────────────

alter table feeders add column if not exists logo_url text;

comment on column feeders.logo_url is
  'Feeder logo/avatar. Either a public storage URL or a private://bucket/path '
  'marker for a feeder that was private at upload time. Set via '
  'community_feeder_set_logo(); null means no logo.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Buckets
-- ────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('feeder-logos', 'feeder-logos', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('feeder-logos-private', 'feeder-logos-private', false)
on conflict (id) do update set public = false;


-- ────────────────────────────────────────────────────────────────────
-- 3. Storage policies
--
-- NOTE: creating policies on storage.objects needs owner rights. Running
-- this from the SQL Editor works; if it errors with "must be owner of
-- table objects", create these from Storage > Policies in the dashboard
-- using the same expressions.
--
-- Upload matches the posture of the existing buckets: the anon key may
-- insert, which is what lets a feeder publish without holding a secret.
--
-- Insert only, deliberately — no update policy, because changing a logo
-- writes a NEW object at a versioned path (logo-{timestamp}.png) rather
-- than overwriting the old one, exactly as detection media does. That is
-- not just consistency: the screensaver caches images on disk keyed by
-- URL, so a stable path would leave every installation showing the old
-- logo out of cache indefinitely. A changed logo must change its URL.
--
-- The cost is an orphaned object per logo change. They are a few KB each
-- and change rarely; the buckets refuse DELETE to anon, so reaping them
-- is the same separate privileged sweep that detection media needs.
-- ────────────────────────────────────────────────────────────────────

drop policy if exists "Feeders upload logos" on storage.objects;
create policy "Feeders upload logos" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id in ('feeder-logos', 'feeder-logos-private')
  );

-- Read, private bucket only. The public bucket needs no select policy:
-- it is served from /storage/v1/object/public/... . Anon is deliberately
-- absent here — a signed-out visitor cannot sign a private feeder's logo
-- at all, which is the same rule its photos already follow.
drop policy if exists "Members read private logos" on storage.objects;
create policy "Members read private logos" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'feeder-logos-private'
    and community_can_read_media(name, auth.uid())
  );


-- ────────────────────────────────────────────────────────────────────
-- 4. Set the logo
--
-- security definer, so it sidesteps both the feeders SELECT policy and
-- feeders_anon_update_guard() — the guard only fires for current_user =
-- 'anon', and inside a definer function that is the owner.
--
-- Clearing is a first-class operation: pass null to remove a logo. The
-- storage object is deliberately NOT deleted here, matching how the rest
-- of the system treats media (the buckets refuse DELETE to anon, so a
-- sweep is a separate, privileged job).
-- ────────────────────────────────────────────────────────────────────

create or replace function community_feeder_set_logo(
  p_device_key  text,
  p_logo_url    text default null,
  p_write_token text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  fid uuid;
begin
  fid := community_feeder_id(p_device_key);
  if fid is null then
    return false;
  end if;
  if not community_feeder_write_ok(fid, p_write_token) then
    raise exception 'community_feeder_set_logo: write token required or incorrect';
  end if;

  -- Reject anything that is neither a storage URL on this project nor one
  -- of our private:// markers. logo_url is rendered as an <img src> on the
  -- dashboard and inside the screensaver, so an unchecked value here is an
  -- arbitrary outbound request made by every viewer of that feeder.
  if p_logo_url is not null
     and p_logo_url !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/feeder-logos/'
     and p_logo_url !~ '^private://feeder-logos-private/' then
    raise exception 'community_feeder_set_logo: logo_url must be a feeder-logos storage URL or marker';
  end if;

  update feeders
     set logo_url   = p_logo_url,
         updated_at = now()
   where id = fid;
  return found;
end;
$$;

revoke execute on function community_feeder_set_logo(text, text, text) from public;
grant  execute on function community_feeder_set_logo(text, text, text) to anon, authenticated;


-- ============================================================
-- 5. Verify
--
--   -- Column exists:
--   select column_name from information_schema.columns
--    where table_name = 'feeders' and column_name = 'logo_url';
--
--   -- Buckets exist with the right visibility:
--   select id, public from storage.buckets where id like 'feeder-logos%';
--   -- expect: feeder-logos = true, feeder-logos-private = false
--
--   -- The function is NOT callable by the public role (the trap from
--   -- CLAUDE.md: revoking from anon alone leaves PUBLIC's grant in place):
--   select has_function_privilege('public',
--            'community_feeder_set_logo(text,text,text)', 'EXECUTE');
--   -- expect: false
--
--   -- A junk URL is refused. Substitute a real device key:
--   select community_feeder_set_logo('<device_key>', 'https://evil.example/x.png');
--   -- expect: ERROR … must be a feeder-logos storage URL or marker
--
--   -- Clearing works:
--   select community_feeder_set_logo('<device_key>', null);   -- expect: true
-- ============================================================
