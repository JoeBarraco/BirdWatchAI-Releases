-- ============================================================
-- BirdWatchAI — community logos
-- Run this in: Supabase Dashboard > SQL Editor > New Query
-- Prerequisites: setup-communities.sql (communities, community_role,
--                community_require_role, community_my_communities)
--
-- A community's own logo — a school crest, a club badge — for the
-- Classroom panel header and the lesson bar.
--
-- Why not the feeder logo (setup-feeder-logos.sql)? The first cut of the
-- school crest borrowed the home feeder's logo, and it fell over on the
-- first real community it met: a community is normally several feeders,
-- each with its own logo or none, so "the school's logo" had no single
-- answer. A community is the thing that IS the school, so it gets the
-- logo.
--
-- Model, and where it differs from feeder logos:
--   * One PUBLIC bucket, community-logos, even for private communities.
--     A crest is not sensitive — it is on the school's sign — and a
--     public URL never expires halfway through a lesson the way a signed
--     one can. What a private community keeps private is its feeders'
--     photos and locations, and none of that is in this bucket.
--   * Uploaded from the website by a signed-in person, not by a device,
--     so the write is checked against Supabase Auth rather than a device
--     key: only the community's OWNER may upload or set it. A logo is the
--     community's identity, like its name; moderators look after feeders
--     and people.
--   * Object paths are {community_id}/logo-{timestamp}.png. The folder is
--     what the upload policy checks; the timestamp means a new logo is a
--     new URL, for the same cache reason feeder logos give.
--   * The browser shrinks the image to 256px PNG before upload, and the
--     bucket refuses anything over 512 KB or not PNG/JPEG/WebP. No SVG:
--     an SVG is a document that can carry script, and this one is shown
--     to every member of the community.
--
-- SAFE TO RE-RUN.
-- ============================================================


-- ────────────────────────────────────────────────────────────────────
-- 1. Column
-- ────────────────────────────────────────────────────────────────────

alter table communities add column if not exists logo_url text;

comment on column communities.logo_url is
  'Community logo. A public community-logos storage URL under this '
  'community''s own folder, set via community_set_logo(); null = none.';


-- ────────────────────────────────────────────────────────────────────
-- 2. Bucket
--
-- The size and type limits are enforced by Storage itself, so a client
-- that skips the browser-side resize still cannot park a 20 MB photo or
-- an SVG here.
-- ────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-logos', 'community-logos', true, 524288,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
   set public             = true,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;


-- ────────────────────────────────────────────────────────────────────
-- 3. Who may upload
--
-- A helper rather than an inline policy expression, because the folder
-- name has to be checked as a uuid BEFORE it is cast to one, and SQL
-- does not promise to evaluate an AND left to right: an inline
-- "looks like a uuid AND community_role(cast...)" can still try the cast
-- on garbage and error. plpgsql runs in order.
--
-- Insert only, like feeder logos. No update and no delete: a changed
-- logo is a new object at a new path, and clearing a logo clears the
-- column, not the file.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_logo_upload_ok(p_object_name text, p_user_id uuid)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  folder text;
begin
  if p_user_id is null or p_object_name is null then
    return false;
  end if;
  folder := split_part(p_object_name, '/', 1);
  if folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return community_role(folder::uuid, p_user_id) = 'owner';
end;
$$;

-- From anon too: Supabase grants new functions to anon explicitly, so
-- revoking from PUBLIC alone leaves a signed-out caller able to reach it.
revoke execute on function community_logo_upload_ok(text, uuid) from public, anon;
grant  execute on function community_logo_upload_ok(text, uuid) to authenticated;

drop policy if exists "Owners upload community logos" on storage.objects;
create policy "Owners upload community logos" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-logos'
    and community_logo_upload_ok(name, auth.uid())
  );


-- ────────────────────────────────────────────────────────────────────
-- 4. Set (or clear) the logo
--
-- The URL must point into THIS community's folder of THIS project's
-- bucket. logo_url is rendered as an <img src> for every member, so an
-- unchecked value would be an outbound request made by every one of
-- them — and pointing at another community's folder would let an owner
-- wear somebody else's crest.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_set_logo(
  p_community_id uuid,
  p_logo_url     text default null
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  if p_logo_url is not null
     and p_logo_url !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/community-logos/'
                        || p_community_id::text || '/[A-Za-z0-9._-]+$') then
    raise exception 'community_set_logo: logo_url must be this community''s community-logos URL';
  end if;

  update communities set logo_url = p_logo_url where id = p_community_id;
  return found;
end;
$$;

revoke execute on function community_set_logo(uuid, text) from public, anon;
grant  execute on function community_set_logo(uuid, text) to authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 5. Hand it to the client
--
-- Private communities are not readable through the REST table (RLS only
-- shows public ones), so everything the site knows about "my
-- communities" comes through this function. Same shape as before plus
-- logo_url; it returns json, so adding a key changes nothing for callers
-- that do not read it. CREATE OR REPLACE keeps the existing grant.
-- ────────────────────────────────────────────────────────────────────

create or replace function community_my_communities()
returns json
language plpgsql security definer
set search_path = public   -- the advisor's "role mutable search_path"
as $$
declare
  result json;
begin
  select json_agg(row_to_json(t) order by t.name) into result
  from (
    select c.id, c.slug, c.name, c.visibility, m.role, c.logo_url
    from communities c
    join community_members m on m.community_id = c.id
    where m.user_id = auth.uid()
  ) t;

  return coalesce(result, '[]'::json);
end;
$$;


-- ============================================================
-- 6. Verify
--
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'community-logos';
--   -- expect: public = true, 524288, {image/png,image/jpeg,image/webp}
--
--   -- Neither function is callable by PUBLIC (revoking from anon alone
--   -- leaves PUBLIC's grant in place):
--   select has_function_privilege('public', 'community_set_logo(uuid,text)', 'EXECUTE'),
--          has_function_privilege('public', 'community_logo_upload_ok(text,uuid)', 'EXECUTE');
--   -- expect: false, false (and the same for 'anon')
-- ============================================================
