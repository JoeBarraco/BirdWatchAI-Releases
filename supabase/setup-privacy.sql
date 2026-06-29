-- ────────────────────────────────────────────────────────────────────────────
-- Community privacy add-on + contact email + privacy-lapse grace.
-- ────────────────────────────────────────────────────────────────────────────
--
-- Prereq: setup-subscriptions.sql must have already been applied (this file
-- extends `feeders.subscription_*` and the existing admin_set_feeder_tier
-- RPC). Re-runnable: every DDL is `if not exists` / DROP-then-CREATE.
--
-- WHAT this adds:
--
--   * `feeders.subscription_privacy boolean default false` — when true, the
--     feeder's detections are hidden from the public community feed; only
--     the owner sees them.
--
--   * `feeders.privacy_lapse_grace_until timestamptz` — when a Stripe
--     subscription fails involuntarily (card expired, etc.) the webhook
--     stamps this to now() + 30 days; during the grace window rows STAY
--     private. After the grace runs out the daily cron flips visibility
--     back to public. A user-initiated cancel skips this column and just
--     sets subscription_privacy=false immediately (deliberate cancel is
--     not a surprise).
--
--   * `feeders.contact_email text` — mutable address for renewal mail.
--     The license payload's customer_email is the immutable proof of
--     purchase; contact_email is what we actually mail. Defaults to the
--     license email on first feeder registration but can be PATCHed via
--     the account portal or synced from Stripe's customer.updated webhook.
--
--   * `community_detections.visibility text default 'public'` (constrained
--     to public|private) — the per-row gate. A BEFORE INSERT trigger
--     stamps this from the parent feeder's current subscription_privacy
--     so the client doesn't have to think about it.
--
--   * Updated `admin_set_feeder_tier(..., p_privacy)` — same RPC, one
--     extra parameter. Flipping privacy rewrites the visibility on every
--     existing community_detection for that feeder so a change takes
--     effect on the entire archive immediately, not just future rows.
--
--   * `update_feeder_contact_email(p_device_key, p_email)` — SECURITY
--     DEFINER RPC for the desktop/server clients to set their own
--     feeder's contact_email without going through the anon PATCH path
--     (which is now blocked by the update guard).
--
--   * `start_privacy_lapse_grace(p_feeder_id)` — admin/webhook entry
--     point for involuntary Stripe lapses. Sets the grace timer.
--
--   * `apply_privacy_lapse_after_grace()` — nightly job entry point.
--     For any feeder whose grace has elapsed, flip
--     subscription_privacy=false and rewrite visibility on its
--     detections to 'public'. Returns the count.
--
--   * Replaces the public-read RLS policy on community_detections with a
--     visibility-aware one. Anon SELECT now requires visibility='public'.
--     Owner reads happen via a SECURITY DEFINER RPC (added later in this
--     file).
--
--   * Extends `feeders_anon_update_guard` to also forbid anon PATCH of
--     subscription_privacy / privacy_lapse_grace_until / contact_email
--     (the guard from setup-feeders-update-guard.sql; we replace the
--     function here so this file becomes the source of truth for guarded
--     columns going forward).
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. New columns ──────────────────────────────────────────────────────────
alter table feeders
    add column if not exists subscription_privacy        boolean not null default false,
    add column if not exists privacy_lapse_grace_until   timestamptz,
    add column if not exists contact_email               text;

alter table community_detections
    add column if not exists visibility text not null default 'public';

do $$
begin
    if not exists (
        select 1 from information_schema.table_constraints
        where constraint_name = 'community_detections_visibility_chk'
    ) then
        alter table community_detections
            add constraint community_detections_visibility_chk
            check (visibility in ('public','private'));
    end if;
end $$;

-- Helpful index for the cron + private-feed queries.
create index if not exists idx_community_detections_visibility
    on community_detections (visibility);

create index if not exists idx_feeders_privacy_lapse
    on feeders (privacy_lapse_grace_until)
    where privacy_lapse_grace_until is not null;

-- ── 2. visibility BEFORE INSERT trigger ─────────────────────────────────────
-- Stamps community_detections.visibility from the parent feeder's
-- subscription_privacy at insert time. Clients can also pass visibility
-- explicitly (the server-side dashboard may want to) — that value wins.
create or replace function set_detection_visibility_from_feeder()
returns trigger
language plpgsql
as $$
declare
    feeder_private boolean;
begin
    -- Only stamp when the client didn't pass one. The column has a default
    -- of 'public', so anything other than 'public' is treated as explicit.
    if new.visibility is distinct from 'public' then
        return new;
    end if;

    select subscription_privacy into feeder_private
      from feeders
     where id = new.feeder_id;
    if feeder_private then
        new.visibility := 'private';
    end if;
    return new;
end;
$$;

drop trigger if exists set_detection_visibility_trg on community_detections;
create trigger set_detection_visibility_trg
    before insert on community_detections
    for each row execute function set_detection_visibility_from_feeder();

-- ── 3. Updated admin_set_feeder_tier (adds p_privacy) ───────────────────────
-- We can't change the parameter list of the existing function in place — the
-- 5-arg overload gets dropped, the 6-arg overload created. The edge function
-- always passes p_privacy after this lands.
drop function if exists admin_set_feeder_tier(text, text, uuid, text, timestamptz);
drop function if exists admin_set_feeder_tier(text, text, uuid, text, timestamptz, boolean);

create or replace function admin_set_feeder_tier(
    p_email      text,
    p_password   text,
    p_feeder_id  uuid,
    p_tier       text,
    p_renews_at  timestamptz default null,
    p_privacy    boolean     default null  -- null = leave unchanged
)
returns json
language plpgsql security definer
as $$
declare
    admin_role  text;
    admin_email text;
    updated     boolean;
    prev_privacy boolean;
    new_privacy  boolean;
    rows_flipped int := 0;
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

    select subscription_privacy into prev_privacy
      from feeders
     where id = p_feeder_id;
    new_privacy := coalesce(p_privacy, prev_privacy, false);

    update feeders
       set subscription_tier        = p_tier,
           subscription_renews_at   = p_renews_at,
           subscription_privacy     = new_privacy,
           subscription_granted_by  = admin_email,
           subscription_granted_at  = now(),
           -- Any explicit re-grant clears a pending privacy-lapse grace timer.
           privacy_lapse_grace_until = case
               when new_privacy and prev_privacy is not distinct from true
                    then privacy_lapse_grace_until  -- keep existing grace if still in it
               else null
           end
     where id = p_feeder_id;
    updated := found;

    -- If privacy actually changed, rewrite visibility on every existing
    -- detection for this feeder so the change applies to the whole archive
    -- immediately, not just future rows. The current row visibility values
    -- are not preserved across flips — a "I was private but went public for
    -- a week and now I'm private again" path would re-hide everything,
    -- which is what we want.
    if updated and prev_privacy is distinct from new_privacy then
        update community_detections
           set visibility = case when new_privacy then 'private' else 'public' end
         where feeder_id = p_feeder_id;
        get diagnostics rows_flipped = row_count;
    end if;

    return json_build_object(
        'feeder_id',       p_feeder_id,
        'tier',            p_tier,
        'renews_at',       p_renews_at,
        'privacy',         new_privacy,
        'visibility_flipped', rows_flipped,
        'granted_by',      admin_email,
        'updated',         updated
    );
end;
$$;

grant execute on function admin_set_feeder_tier(text, text, uuid, text, timestamptz, boolean) to anon;

-- ── 4. update_feeder_contact_email ──────────────────────────────────────────
-- Client-side PATCH path for the contact email. Authenticated by the
-- license-derived device_key (which the desktop / server already presents
-- in every community write), not by Supabase Auth — same trust model as the
-- existing feeder writes.
drop function if exists update_feeder_contact_email(text, text);

create or replace function update_feeder_contact_email(
    p_device_key text,
    p_email      text
)
returns json
language plpgsql security definer
as $$
declare
    cleaned text;
    matched int;
begin
    if p_device_key is null or length(trim(p_device_key)) = 0 then
        raise exception 'device_key required';
    end if;

    -- Allow nulling the email (means "remove me from the notification list").
    if p_email is null or length(trim(p_email)) = 0 then
        cleaned := null;
    else
        cleaned := lower(trim(p_email));
        if cleaned !~ '^[^@]+@[^@]+\.[^@]+$' then
            raise exception 'Invalid email format';
        end if;
    end if;

    update feeders
       set contact_email = cleaned
     where device_key = p_device_key;
    get diagnostics matched = row_count;

    if matched = 0 then
        raise exception 'No feeder found for device_key';
    end if;

    return json_build_object('updated', true, 'contact_email', cleaned);
end;
$$;

grant execute on function update_feeder_contact_email(text, text) to anon;

-- ── 5. Privacy-lapse grace ──────────────────────────────────────────────────
-- start_privacy_lapse_grace: called by the Stripe webhook on
-- invoice.payment_failed / customer.subscription.deleted (involuntary). Sets
-- a 30-day grace; nothing changes during the grace except the timer being
-- set. The accompanying notification cron picks this up to remind the owner.
drop function if exists start_privacy_lapse_grace(uuid);

create or replace function start_privacy_lapse_grace(p_feeder_id uuid)
returns timestamptz
language plpgsql security definer
as $$
declare
    grace_until timestamptz;
begin
    grace_until := now() + interval '30 days';
    update feeders
       set privacy_lapse_grace_until = grace_until
     where id = p_feeder_id
       and subscription_privacy = true
       and privacy_lapse_grace_until is null;  -- don't reset an already-running grace
    return grace_until;
end;
$$;

-- Service-role only (Stripe webhook runs as service_role).
grant execute on function start_privacy_lapse_grace(uuid) to service_role;

-- apply_privacy_lapse_after_grace: nightly job. For any feeder whose grace
-- timer has elapsed, flip subscription_privacy=false, rewrite its detection
-- visibilities back to 'public', clear the timer. Returns the count of
-- feeders flipped.
drop function if exists apply_privacy_lapse_after_grace();

create or replace function apply_privacy_lapse_after_grace()
returns integer
language plpgsql security definer
as $$
declare
    flipped int := 0;
begin
    with lapsed as (
        select id from feeders
         where subscription_privacy = true
           and privacy_lapse_grace_until is not null
           and privacy_lapse_grace_until < now()
    ),
    updated as (
        update feeders f
           set subscription_privacy      = false,
               privacy_lapse_grace_until = null
          from lapsed l
         where f.id = l.id
        returning f.id
    ),
    visibility_flip as (
        update community_detections d
           set visibility = 'public'
          from updated u
         where d.feeder_id = u.id
           and d.visibility = 'private'
        returning d.id
    )
    select count(*)::int into flipped from updated;
    return flipped;
end;
$$;

grant execute on function apply_privacy_lapse_after_grace() to anon;

-- ── 6. RLS on community_detections — anon reads filtered by visibility ──────
-- The existing wide-open SELECT policy needs to be replaced. Names vary
-- depending on how the table was created; the user should drop the existing
-- one manually in the Supabase dashboard (see Sanity check below) before
-- applying this file, OR after — the new policy below is restrictive enough
-- that the worst case is "two policies present, the most-permissive wins,
-- and old behavior is preserved." The migration is therefore safe to apply
-- ahead of dropping the old policy.
alter table community_detections enable row level security;

drop policy if exists "Public visibility only for anon" on community_detections;
create policy "Public visibility only for anon"
    on community_detections
    for select
    to anon
    using (visibility = 'public');

-- Owner read happens via a SECURITY DEFINER RPC keyed on device_key. Anon
-- callers pass the license-derived device_key and the RPC scopes to that
-- one feeder's rows regardless of visibility.
drop function if exists list_own_detections(text, int, int);
create or replace function list_own_detections(
    p_device_key text,
    p_limit      int default 200,
    p_offset     int default 0
)
returns setof community_detections
language plpgsql security definer
as $$
declare
    target_feeder uuid;
begin
    select id into target_feeder
      from feeders
     where device_key = p_device_key;
    if target_feeder is null then
        raise exception 'No feeder found for device_key';
    end if;
    return query
        select * from community_detections
         where feeder_id = target_feeder
         order by detected_at desc
         limit greatest(1, least(coalesce(p_limit, 200), 1000))
        offset greatest(0, coalesce(p_offset, 0));
end;
$$;

grant execute on function list_own_detections(text, int, int) to anon;

-- ── 7. Extended feeders_anon_update_guard ───────────────────────────────────
-- Same pattern as the original from setup-feeders-update-guard.sql — replace
-- the function in place, the trigger keeps pointing at the new body. Guards
-- the new privacy / lapse / contact_email columns against direct anon PATCH.
create or replace function feeders_anon_update_guard()
returns trigger
language plpgsql
as $$
declare
    n jsonb := to_jsonb(new);
    o jsonb := to_jsonb(old);
begin
    if current_user <> 'anon' then
        return new;
    end if;

    if new.id is distinct from old.id then
        raise exception 'feeders.id is immutable';
    end if;
    if new.device_key is distinct from old.device_key then
        raise exception 'feeders.device_key cannot be changed via anon (use the appropriate RPC).';
    end if;
    if (n -> 'created_at') is distinct from (o -> 'created_at') then
        raise exception 'feeders.created_at is immutable';
    end if;

    -- Subscription columns — must flow through admin_set_feeder_tier or the
    -- Stripe webhook running as service_role.
    if (n -> 'subscription_tier') is distinct from (o -> 'subscription_tier') then
        raise exception 'feeders.subscription_tier must be changed via admin_set_feeder_tier';
    end if;
    if (n -> 'subscription_renews_at') is distinct from (o -> 'subscription_renews_at') then
        raise exception 'feeders.subscription_renews_at is read-only via anon';
    end if;
    if (n -> 'subscription_granted_by') is distinct from (o -> 'subscription_granted_by') then
        raise exception 'feeders.subscription_granted_by is read-only via anon';
    end if;
    if (n -> 'subscription_granted_at') is distinct from (o -> 'subscription_granted_at') then
        raise exception 'feeders.subscription_granted_at is read-only via anon';
    end if;
    if (n -> 'subscription_privacy') is distinct from (o -> 'subscription_privacy') then
        raise exception 'feeders.subscription_privacy must be changed via admin_set_feeder_tier';
    end if;
    if (n -> 'privacy_lapse_grace_until') is distinct from (o -> 'privacy_lapse_grace_until') then
        raise exception 'feeders.privacy_lapse_grace_until is read-only via anon';
    end if;
    -- contact_email goes through update_feeder_contact_email (SECURITY DEFINER).
    if (n -> 'contact_email') is distinct from (o -> 'contact_email') then
        raise exception 'feeders.contact_email must be changed via update_feeder_contact_email';
    end if;

    return new;
end;
$$;

-- Trigger from setup-feeders-update-guard.sql still points at the function
-- by name; re-asserting here so this file is safe to apply standalone.
drop trigger if exists feeders_anon_update_guard_trg on feeders;
create trigger feeders_anon_update_guard_trg
    before update on feeders
    for each row execute function feeders_anon_update_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- Sanity check (run by hand after applying):
--
--   -- visibility default should be 'public'
--   select column_name, column_default
--     from information_schema.columns
--    where table_name='community_detections' and column_name='visibility';
--
--   -- Privacy flip should rewrite existing rows
--   set role anon;
--   select admin_set_feeder_tier(
--       'admin@example.com', '<password>', '<feeder_id>', 'plus',
--       null, true);
--   -- visibility_flipped should be > 0 for a feeder with existing detections
--   reset role;
--
--   -- Anon should no longer see private detections
--   set role anon;
--   select count(*) from community_detections where visibility='private';
--   reset role;
--   -- expected: 0  (because the policy filters them out)
--
-- Then verify there's no legacy wide-open SELECT policy still attached:
--   select policyname from pg_policies where tablename='community_detections';
-- Should show only "Public visibility only for anon" (plus any
-- service_role-scoped policies). If a legacy "Anyone can read" /
-- "Allow public read" policy is still attached, drop it via the Supabase
-- dashboard.
-- ────────────────────────────────────────────────────────────────────────────
