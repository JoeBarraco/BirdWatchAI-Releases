-- ────────────────────────────────────────────────────────────────────────────
-- Self-serve software licensing.
--
-- Issued license keys live here. The Stripe webhook
-- (functions/stripe-license-webhook) inserts a row per successful
-- checkout.session.completed, mints the signed key, and emails it to the
-- buyer. The account portal reads from this table by email (after a
-- magic-link auth round-trip) so customers can re-download a key without
-- contacting support.
--
-- Key format is the same as the desktop LicenseGeneratorTool:
--     BASE64(JSON) | BASE64(RSA-SHA256-PKCS1 signature)
-- The desktop app's embedded public key continues to verify; the private
-- key moves from the dev machine into a Supabase function secret
-- (LICENSE_PRIVATE_KEY_PEM).
--
-- license_version is here so we can roll the signing key (or expand the
-- payload shape) without invalidating older issued keys — bump the version
-- column when reissuing under a new private key.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists licenses (
    id                   uuid primary key default gen_random_uuid(),
    license_id           text unique not null,         -- "BWA-XXXX-XXXX-XXXX"
    license_key          text not null,                -- full BASE64|BASE64 blob
    license_version      int  not null default 1,

    customer_email       text not null,
    customer_name        text,

    -- Provenance: which payment provider + reference produced this key.
    -- (source='manual' for keys minted with the desktop tool.)
    source               text not null default 'stripe',
    stripe_session_id    text unique,
    stripe_customer_id   text,
    order_reference      text,

    issued_at            timestamptz not null default now(),
    expires_at           timestamptz,                  -- null = perpetual
    revoked_at           timestamptz,
    revoked_reason       text
);

create index if not exists idx_licenses_email on licenses (lower(customer_email));
create index if not exists idx_licenses_stripe_session on licenses (stripe_session_id);

-- ────────────────────────────────────────────────────────────────────────────
-- license_lookup_by_email: portal read path. Returns non-revoked keys for
-- the given email. Caller is expected to have proved ownership of the
-- email first (Supabase auth magic link) — the function takes the email
-- as an argument and the calling edge function decides whether to trust
-- it. Service-role calls always allowed; anon callers should go through
-- the lookup edge function which enforces the auth check.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists license_lookup_by_email(text);
create or replace function license_lookup_by_email(p_email text)
returns table (
    license_id      text,
    license_key     text,
    customer_name   text,
    issued_at       timestamptz,
    expires_at      timestamptz,
    source          text
)
language sql security definer
as $$
    select l.license_id,
           l.license_key,
           l.customer_name,
           l.issued_at,
           l.expires_at,
           l.source
      from licenses l
     where lower(l.customer_email) = lower(trim(p_email))
       and l.revoked_at is null
     order by l.issued_at desc;
$$;

grant execute on function license_lookup_by_email(text) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- revoke_license: admin-only. Used when a refund comes back through Stripe
-- or when a key needs to be invalidated for any reason. Revoked keys stay
-- in the table for audit; the portal just hides them.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists revoke_license(text, text, text, text);
create or replace function revoke_license(
    p_email      text,
    p_password   text,
    p_license_id text,
    p_reason     text default null
) returns json
language plpgsql security definer
as $$
declare
    admin_role text;
begin
    select role into admin_role
      from moderators
     where email = lower(trim(p_email))
       and password_hash = crypt(p_password, password_hash);
    if admin_role is null then
        raise exception 'Invalid moderator credentials';
    end if;
    if admin_role <> 'admin' then
        raise exception 'Admin access required';
    end if;

    update licenses
       set revoked_at     = now(),
           revoked_reason = p_reason
     where license_id = p_license_id
       and revoked_at is null;

    return json_build_object('revoked', found, 'license_id', p_license_id);
end;
$$;

grant execute on function revoke_license(text, text, text, text) to anon;
