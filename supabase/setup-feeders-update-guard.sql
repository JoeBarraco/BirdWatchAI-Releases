-- ────────────────────────────────────────────────────────────────────────────
-- Defense-in-depth for the feeders table.
--
-- BACKGROUND:
-- The current RLS policies allow anon UPDATE with qual=true — meaning anyone
-- with the public anon key (hardcoded in every install, visible in browser
-- devtools on the community page) can PATCH any feeder row to anything.
-- Concrete impact:
--   * Hijack a feeder by rewriting device_key → the legitimate owner's next
--     share creates an orphan; the attacker keeps receiving uploads.
--   * Set subscription_tier='pro' on any feeder → free Pro for the world,
--     bypassing the entire tiering work.
--   * Forge subscription_granted_by → fake the audit trail.
--   * Rename feeders (annoying but recoverable).
--
-- CONSTRAINT: We have live WinForms installs (and the new web server) doing
-- direct PostgREST PATCH calls to update display_name, share_level,
-- app_version, last_seen_at, etc. Replacing the policy outright would break
-- every existing install until they upgrade.
--
-- APPROACH: A BEFORE UPDATE trigger that runs as the calling role (no
-- SECURITY DEFINER) and rejects mutations to the protected columns when the
-- caller is 'anon'. The mutable columns the clients actually use stay
-- writable, so existing WinForms and web-server installs keep working
-- unchanged. Legitimate tier changes already flow through
-- admin_set_feeder_tier (SECURITY DEFINER) which runs as the function's
-- owner — current_user there is not 'anon', so the trigger no-ops and the
-- RPC can update freely.
--
-- This is the minimal hotfix. A future migration should also move
-- display_name / share_level behind a security-definer RPC keyed on the
-- license key (the only thing tying a request to a real owner from
-- anywhere), at which point the anon UPDATE policy can be dropped
-- entirely. By then the WinForms app will be on a release that uses the
-- RPC. This file does NOT make that change — it just closes the worst
-- holes today.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function feeders_anon_update_guard()
returns trigger
language plpgsql
as $$
begin
    -- Service role and SECURITY DEFINER RPCs run as their definer (usually
    -- 'postgres'), not 'anon', so they skip the guard. Only direct
    -- anon-key REST writes are gated.
    if current_user <> 'anon' then
        return new;
    end if;

    -- Identity / ownership columns — must never change via anon.
    if new.id is distinct from old.id then
        raise exception 'feeders.id is immutable';
    end if;
    if new.device_key is distinct from old.device_key then
        raise exception 'feeders.device_key cannot be changed via anon (use the appropriate RPC).';
    end if;
    if coalesce(new.created_at, old.created_at) is distinct from old.created_at then
        raise exception 'feeders.created_at is immutable';
    end if;

    -- Subscription columns — must only flow through admin_set_feeder_tier
    -- (today) or a future Stripe webhook running as service_role.
    if new.subscription_tier is distinct from old.subscription_tier then
        raise exception 'feeders.subscription_tier must be changed via admin_set_feeder_tier';
    end if;
    if new.subscription_renews_at is distinct from old.subscription_renews_at then
        raise exception 'feeders.subscription_renews_at is read-only via anon';
    end if;
    if new.subscription_granted_by is distinct from old.subscription_granted_by then
        raise exception 'feeders.subscription_granted_by is read-only via anon';
    end if;
    if new.subscription_granted_at is distinct from old.subscription_granted_at then
        raise exception 'feeders.subscription_granted_at is read-only via anon';
    end if;

    return new;
end;
$$;

drop trigger if exists feeders_anon_update_guard_trg on feeders;
create trigger feeders_anon_update_guard_trg
    before update on feeders
    for each row execute function feeders_anon_update_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- Sanity check: run after applying.
--
--   -- Should raise: 'feeders.subscription_tier must be changed via …'
--   set role anon;
--   update feeders set subscription_tier='pro' where id = '<some real id>';
--   reset role;
--
--   -- Should still succeed (display_name is unguarded — WinForms compat):
--   set role anon;
--   update feeders set display_name='renamed' where id = '<some real id>';
--   reset role;
--
--   -- admin_set_feeder_tier (SECURITY DEFINER) should still work normally.
-- ────────────────────────────────────────────────────────────────────────────
