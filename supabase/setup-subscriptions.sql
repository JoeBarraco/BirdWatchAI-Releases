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
-- purge_expired_feeder_media: marks community_detections rows whose media is
-- past its feeder's tier retention. Returns the rows (id, image_url, video_url)
-- so the calling edge function can remove the storage objects. The row itself
-- stays (stats / life-list integrity); only the image_url / video_url get
-- nulled out and media_purged_at gets stamped.
--
-- security definer so it can be invoked by the edge function with the anon
-- key; the function itself only does the safe metadata-only purge.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists purge_expired_feeder_media();

create or replace function purge_expired_feeder_media()
returns table (
    detection_id uuid,
    image_url    text,
    video_url    text
)
language plpgsql security definer
as $$
begin
    return query
    with cutoff as (
        select f.id as feeder_id,
               case f.subscription_tier
                   when 'pro'  then interval '365 days'
                   when 'plus' then interval '90 days'
                   else             interval '7 days'
               end as retention
          from feeders f
    ),
    expired as (
        select d.id, d.image_url, d.video_url
          from community_detections d
          join cutoff c on c.feeder_id = d.feeder_id
         where d.media_purged_at is null
           and (d.image_url is not null or d.video_url is not null)
           and d.detected_at < now() - c.retention
    ),
    updated as (
        update community_detections d
           set image_url       = null,
               video_url       = null,
               media_purged_at = now()
          from expired e
         where d.id = e.id
        returning d.id, e.image_url, e.video_url
    )
    select u.id, u.image_url, u.video_url from updated u;
end;
$$;

grant execute on function purge_expired_feeder_media() to anon;
