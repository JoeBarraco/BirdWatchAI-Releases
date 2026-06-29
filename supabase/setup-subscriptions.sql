-- ────────────────────────────────────────────────────────────────────────────
-- Community subscription tiers — per-feeder media retention.
-- ────────────────────────────────────────────────────────────────────────────
--
-- WHAT this adds:
--   * subscription_tier on every feeder (free | plus | pro)
--   * Retention windows: free=7d, plus=90d, pro=365d (media only — detection
--     rows always live forever for stats / life-list continuity)
--   * media_purged_at marker on community_detections so the feed can render
--     a "📷 photo expired — upgrade to keep future photos" placeholder
--     without breaking the row.
--   * admin_set_feeder_tier RPC so an admin (moderators.role='admin') can
--     grant a tier manually — covers the "I want to provide the service
--     for free to someone" path and the future Stripe webhook path equally.
--   * purge_expired_feeder_media RPC: the nightly job entry point. Marks
--     anything past its tier's retention window so the accompanying
--     edge function can clear the storage objects.
--
-- The migration is idempotent (DROP-then-CREATE for the functions, IF NOT
-- EXISTS for columns) so it's safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

alter table feeders
    add column if not exists subscription_tier text not null default 'free',
    add column if not exists subscription_renews_at timestamptz,
    add column if not exists subscription_granted_by text,
    add column if not exists subscription_granted_at timestamptz;

do $$
begin
    if not exists (
        select 1 from information_schema.table_constraints
        where constraint_name = 'feeders_subscription_tier_chk'
    ) then
        alter table feeders
            add constraint feeders_subscription_tier_chk
            check (subscription_tier in ('free','plus','pro'));
    end if;
end $$;

alter table community_detections
    add column if not exists media_purged_at timestamptz;

create index if not exists idx_community_detections_detected_at
    on community_detections (detected_at);

-- ────────────────────────────────────────────────────────────────────────────
-- admin_set_feeder_tier: admin-only path to grant a tier. Records who set it
-- (granted_by = admin email) and when, so a future Stripe-driven sync can
-- tell admin-granted rows apart from paid ones and not stomp them. Pass
-- p_renews_at = null to make the grant indefinite (the typical case for
-- comped accounts); pass a timestamp to make it auto-downgrade on a date.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists admin_set_feeder_tier(text, text, uuid, text, timestamptz);

create or replace function admin_set_feeder_tier(
    p_email      text,
    p_password   text,
    p_feeder_id  uuid,
    p_tier       text,
    p_renews_at  timestamptz default null
)
returns json
language plpgsql security definer
as $$
declare
    admin_role text;
    admin_email text;
    updated boolean;
begin
    if p_tier not in ('free','plus','pro') then
        raise exception 'Invalid tier %, expected free|plus|pro', p_tier;
    end if;

    select role, email into admin_role, admin_email
    from moderators
    where email = lower(trim(p_email))
      and password_hash = crypt(p_password, password_hash);

    if admin_role is null then
        raise exception 'Invalid moderator credentials';
    end if;
    if admin_role <> 'admin' then
        raise exception 'Admin access required';
    end if;

    update feeders
       set subscription_tier       = p_tier,
           subscription_renews_at  = p_renews_at,
           subscription_granted_by = admin_email,
           subscription_granted_at = now()
     where id = p_feeder_id;
    updated := found;

    return json_build_object(
        'feeder_id',             p_feeder_id,
        'tier',                  p_tier,
        'renews_at',             p_renews_at,
        'granted_by',            admin_email,
        'updated',               updated
    );
end;
$$;

grant execute on function admin_set_feeder_tier(text, text, uuid, text, timestamptz) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- Two-phase media retention.
--
--   Phase 1 — SOFT EXPIRE (visible to public removed, media held for grace):
--     Past tier retention (free=7d, plus=90d, pro=365d), the media URLs are
--     moved off image_url/video_url into archived_image_url/archived_video_url
--     and media_purged_at gets stamped. The public feed no longer shows the
--     photo (the "📷 photo expired (recoverable)" placeholder takes over),
--     but the storage object stays put so a tier upgrade can restore it.
--
--   Phase 2 — HARD DELETE (after a 30-day grace, truly gone):
--     Past media_purged_at + grace_period (30 days), the archived URLs are
--     returned to the caller so the storage objects can be removed, then
--     archived_image_url/archived_video_url get nulled too. media_purged_at
--     stays as the marker that "this row had media once" so the placeholder
--     can still surface ("📷 photo permanently deleted").
--
--   RESTORE (called on tier upgrade): for any row in soft-expired state
--     whose detected_at fits the NEW tier's window, the archived URLs are
--     copied back to image_url/video_url and media_purged_at is cleared.
--     Hard-deleted rows can't be restored (the archive's gone) — this is
--     why the 30-day grace matters.
-- ────────────────────────────────────────────────────────────────────────────

alter table community_detections
    add column if not exists archived_image_url text,
    add column if not exists archived_video_url text;

-- Hard-coded as a sql constant for now. If you ever want different grace
-- periods per tier, lift this to a column on the feeders table.
drop function if exists media_grace_period();
create or replace function media_grace_period() returns interval
    language sql immutable
as $$ select interval '30 days' $$;

grant execute on function media_grace_period() to anon;

-- Tier retention as a re-usable helper so the three functions below stay in
-- sync without copy-pasting the case-expression.
drop function if exists tier_retention(text);
create or replace function tier_retention(p_tier text) returns interval
    language sql immutable
as $$
    select case p_tier
               when 'pro'  then interval '365 days'
               when 'plus' then interval '90 days'
               else             interval '7 days'
           end
$$;

grant execute on function tier_retention(text) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 1: soft_expire_feeder_media — hide media from the public feed by
-- moving the URLs into the archive columns and stamping media_purged_at.
-- Storage objects are NOT touched — that's phase 2.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists soft_expire_feeder_media();
create or replace function soft_expire_feeder_media()
returns table (detection_id uuid)
language plpgsql security definer
as $$
begin
    return query
    with expired as (
        select d.id, d.image_url, d.video_url
          from community_detections d
          join feeders f on f.id = d.feeder_id
         where d.media_purged_at is null
           and (d.image_url is not null or d.video_url is not null)
           and d.detected_at < now() - tier_retention(f.subscription_tier)
    ),
    moved as (
        update community_detections d
           set archived_image_url = coalesce(d.archived_image_url, e.image_url),
               archived_video_url = coalesce(d.archived_video_url, e.video_url),
               image_url          = null,
               video_url          = null,
               media_purged_at    = now()
          from expired e
         where d.id = e.id
        returning d.id
    )
    select m.id from moved m;
end;
$$;

grant execute on function soft_expire_feeder_media() to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- Phase 2: hard_delete_feeder_media — for soft-expired rows whose
-- media_purged_at is past the grace period, return the archived URLs (so the
-- caller can remove the storage objects), then clear the archive columns.
-- media_purged_at stays so the UI can still render the "expired" placeholder.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists hard_delete_feeder_media();
create or replace function hard_delete_feeder_media()
returns table (
    detection_id uuid,
    image_url    text,
    video_url    text
)
language plpgsql security definer
as $$
begin
    return query
    with stale as (
        select d.id, d.archived_image_url, d.archived_video_url
          from community_detections d
         where d.media_purged_at is not null
           and d.media_purged_at < now() - media_grace_period()
           and (d.archived_image_url is not null or d.archived_video_url is not null)
    ),
    cleared as (
        update community_detections d
           set archived_image_url = null,
               archived_video_url = null
          from stale s
         where d.id = s.id
        returning d.id, s.archived_image_url, s.archived_video_url
    )
    select c.id, c.archived_image_url, c.archived_video_url from cleared c;
end;
$$;

grant execute on function hard_delete_feeder_media() to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- restore_recoverable_feeder_media: for the given feeder, restore any
-- soft-expired rows (archive populated, media_purged_at set) whose detected_at
-- fits inside the feeder's CURRENT tier window. Used after a tier upgrade so
-- the user sees their photos come back without manual intervention.
-- Returns the number of rows restored.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists restore_recoverable_feeder_media(uuid);
create or replace function restore_recoverable_feeder_media(p_feeder_id uuid)
returns integer
language plpgsql security definer
as $$
declare
    restored int;
begin
    update community_detections d
       set image_url          = d.archived_image_url,
           video_url          = d.archived_video_url,
           archived_image_url = null,
           archived_video_url = null,
           media_purged_at    = null
      from feeders f
     where d.feeder_id = p_feeder_id
       and f.id = p_feeder_id
       and d.media_purged_at is not null
       and (d.archived_image_url is not null or d.archived_video_url is not null)
       and d.detected_at >= now() - tier_retention(f.subscription_tier);
    get diagnostics restored = row_count;
    return restored;
end;
$$;

grant execute on function restore_recoverable_feeder_media(uuid) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- Optional: schedule the nightly purge via pg_cron.
--
-- Approach A — call the edge function from pg_cron (preferred, since the
-- function also removes the storage objects in addition to nulling the URLs).
-- Replace SUPABASE_URL, ANON_KEY and CRON_SECRET below. The CRON_SECRET must
-- match what's set on the purge-expired-media function:
--     supabase secrets set CRON_SECRET=<long-random>
--
-- /*
--     create extension if not exists pg_cron;
--     select cron.schedule(
--         'purge-expired-community-media',
--         '15 4 * * *',  -- daily at 04:15 UTC
--         $cmd$
--             select net.http_post(
--                 url     := 'https://<SUPABASE_URL>.functions.supabase.co/purge-expired-media',
--                 headers := jsonb_build_object(
--                     'Authorization', 'Bearer <CRON_SECRET>',
--                     'Content-Type',  'application/json'
--                 ),
--                 body    := '{}'::jsonb
--             );
--         $cmd$
--     );
-- */
--
-- Approach B — call the RPC directly from pg_cron. Simpler, but the orphaned
-- storage objects then accumulate until the next edge-function purge runs
-- (admin "Purge expired media" button is fine for that). Use this if you'd
-- rather not deal with edge-function secrets.
--
-- /*
--     create extension if not exists pg_cron;
--     select cron.schedule(
--         'mark-expired-community-media',
--         '15 4 * * *',
--         $cmd$ select count(*) from purge_expired_feeder_media(); $cmd$
--     );
-- */
-- ────────────────────────────────────────────────────────────────────────────
