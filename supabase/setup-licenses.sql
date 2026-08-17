-- ────────────────────────────────────────────────────────────────────────────
-- Self-serve software licensing.
--
-- Issued license keys live here. Two paths write to this table and they are
-- deliberately equal citizens:
--
--   1. Gumroad (source='gumroad') — the self-serve path. The
--      `gumroad-license-webhook` edge function fires on Gumroad's sale ping,
--      mints the signed key, inserts a row, and emails it to the buyer.
--   2. Manual (source='manual') — Joe running the desktop LicenseGeneratorTool
--      for beta testers, replacements, comps, friends-and-family. Those keys
--      work whether or not they are ever recorded here; `record_manual_license`
--      exists so the ledger and the account portal can see them too.
--
-- (source='stripe' is reserved for the Stripe checkout webhook, kept alongside
-- for the storage-subscription stream. See PRICING-AND-LICENSING.md.)
--
-- Key format is identical for every path — the same as the desktop
-- LicenseGeneratorTool has always produced:
--     BASE64(JSON) | BASE64(RSA-SHA256-PKCS1 signature)
-- signed with the SAME RSA private key. The desktop app and the server app
-- both verify offline against their embedded public key and cannot tell the
-- paths apart. That is the whole point: adding Gumroad does not invalidate a
-- single previously issued key, and hand-minting keeps working forever.
--
-- The private key moves from the dev machine into a Supabase function secret
-- (LICENSE_PRIVATE_KEY_PEM) for the webhook path only; the desktop tool keeps
-- using its local Keys/private_key.xml.
--
-- license_version is here so we can roll the signing key (or expand the
-- payload shape) without invalidating older issued keys — bump the version
-- column when reissuing under a new private key.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists licenses (
    id                   uuid primary key default gen_random_uuid(),
    license_id           text unique not null,         -- "BWA-…" manual, "BWG-…" Gumroad
    license_key          text not null,                -- full BASE64|BASE64 blob
    license_version      int  not null default 1,

    customer_email       text not null,
    customer_name        text,

    -- Provenance: which path produced this key.
    -- Values in use: 'gumroad' | 'manual' | 'stripe'.
    source               text not null default 'gumroad',
    stripe_session_id    text unique,
    stripe_customer_id   text,
    order_reference      text,

    issued_at            timestamptz not null default now(),
    expires_at           timestamptz,                  -- null = perpetual
    revoked_at           timestamptz,
    revoked_reason       text
);

-- Gumroad provenance, added after the original Stripe-only sketch. Written as
-- `add column if not exists` so this whole file stays re-runnable against a
-- database that already has the table.
alter table licenses add column if not exists gumroad_sale_id      text;
alter table licenses add column if not exists gumroad_product_id   text;
alter table licenses add column if not exists gumroad_license_key  text;
alter table licenses add column if not exists is_test              boolean not null default false;

comment on column licenses.gumroad_sale_id is
    'Gumroad sale_id from the ping. Idempotency key — Gumroad retries pings.';
comment on column licenses.gumroad_license_key is
    'Gumroad''s own generated key for the sale, kept for support lookups and as '
    'the input to a future online activation check. NOT what the app validates.';
comment on column licenses.is_test is
    'True for Gumroad test pings. Real keys, but excluded from sales reporting '
    'and safe to delete.';

create index if not exists idx_licenses_email on licenses (lower(customer_email));
create index if not exists idx_licenses_stripe_session on licenses (stripe_session_id);

-- Unique so a retried ping can never mint a second key for one sale. Nullable
-- column, and Postgres allows many NULLs in a unique index, so manual rows are
-- unaffected.
create unique index if not exists idx_licenses_gumroad_sale on licenses (gumroad_sale_id);

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
-- record_manual_license: admin-only. Registers a key that was minted OUTSIDE
-- the webhook — i.e. by the desktop LicenseGeneratorTool — so the ledger and
-- the account portal know about it.
--
-- This is bookkeeping, not activation: a hand-minted key validates offline
-- whether or not this ever gets called. Use it when you want the customer to
-- be able to re-download the key from the portal, or when you might later
-- need to revoke it.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists record_manual_license(text, text, text, text, text, text, timestamptz, text);
create or replace function record_manual_license(
    p_email           text,           -- admin's moderator email
    p_password        text,           -- admin's moderator password
    p_license_id      text,           -- e.g. "BWA-XXXX-XXXX-XXXX"
    p_license_key     text,           -- full BASE64|BASE64 blob
    p_customer_email  text,
    p_customer_name   text default null,
    p_expires_at      timestamptz default null,
    p_order_reference text default null
) returns json
language plpgsql security definer
as $$
declare
    admin_role text;
    inserted   boolean := false;
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

    if coalesce(trim(p_license_id), '') = '' or coalesce(trim(p_license_key), '') = '' then
        raise exception 'license_id and license_key are both required';
    end if;

    insert into licenses (
        license_id, license_key, customer_email, customer_name,
        source, order_reference, expires_at
    ) values (
        trim(p_license_id), trim(p_license_key), lower(trim(p_customer_email)), p_customer_name,
        'manual', p_order_reference, p_expires_at
    )
    on conflict (license_id) do nothing;

    inserted := found;
    return json_build_object(
        'recorded',   inserted,
        'license_id', trim(p_license_id),
        'duplicate',  not inserted
    );
end;
$$;

grant execute on function record_manual_license(text, text, text, text, text, text, timestamptz, text) to anon;

-- ────────────────────────────────────────────────────────────────────────────
-- revoke_license: admin-only. Used when a refund comes back or when a key
-- needs to be invalidated for any reason. Revoked keys stay in the table for
-- audit; the portal just hides them.
--
-- NOTE (deliberate, not an oversight): revoking here does NOT disable an
-- already-activated install. Validation is offline by design, so revocation
-- only stops re-downloads from the portal and marks the row for the day an
-- online activation check exists. The refund path in the Gumroad webhook
-- writes revoked_at directly with the service-role key.
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
