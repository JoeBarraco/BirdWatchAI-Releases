-- Minimal stand-in for the parts of the BirdWatchAI schema that
-- setup-school-subscription.sql touches. Not the real schema — just enough
-- shape for the migration to compile against and for its behaviour to be
-- exercised.

create extension if not exists pgcrypto;

do $$ begin
  create role anon;            exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated;   exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role;    exception when duplicate_object then null; end $$;

create schema if not exists auth;
create schema if not exists extensions;

-- Whoever the test says is signed in.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create table communities (
    id            uuid primary key default gen_random_uuid(),
    slug          text unique not null,
    name          text not null,
    visibility    text not null default 'public',
    owner_user_id uuid,
    kind          text not null default 'general'
                  check (kind in ('general', 'school')),
    tier          text,
    feeder_limit  int,
    created_at    timestamptz not null default now()
);

create table community_members (
    community_id uuid not null references communities(id) on delete cascade,
    user_id      uuid not null,
    role         text not null check (role in ('owner','moderator','teacher','viewer')),
    primary key (community_id, user_id)
);

create table classrooms (
    id              uuid primary key default gen_random_uuid(),
    community_id    uuid not null references communities(id) on delete cascade,
    name            text not null,
    grade_band      text,
    teacher_user_id uuid,
    archived_at     timestamptz,
    created_at      timestamptz not null default now()
);

create table classroom_sessions (
    id            uuid primary key default gen_random_uuid(),
    classroom_id  uuid not null references classrooms(id) on delete cascade,
    mode          text not null default 'teacher_led',
    started_by    uuid,
    join_code     text,
    voting_open   boolean not null default false,
    correct_count int not null default 0,
    started_at    timestamptz not null default now(),
    ended_at      timestamptz
);

create table community_unlock_codes (
    id                 uuid primary key default gen_random_uuid(),
    code               text unique not null,
    tier               text not null check (tier in ('small','medium','large')),
    feeder_limit       int  not null check (feeder_limit > 0),
    customer_email     text not null,
    customer_name      text,
    source             text not null default 'gumroad',
    gumroad_sale_id    text unique,
    gumroad_product_id text,
    is_test            boolean not null default false,
    issued_at          timestamptz not null default now(),
    redeemed_at        timestamptz,
    redeemed_by        uuid,
    community_id       uuid references communities(id) on delete set null,
    revoked_at         timestamptz,
    revoked_reason     text
);

create or replace function community_role(p_community_id uuid, p_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from community_members
   where community_id = p_community_id and user_id = p_user_id
$$;

create or replace function community_require_role(
  p_community_id uuid, p_user_id uuid, p_roles text[])
returns void language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if p_user_id is null then raise exception 'Sign-in required'; end if;
  r := community_role(p_community_id, p_user_id);
  if r is null or not (r = any(p_roles)) then
    raise exception 'Insufficient permission (have %, need %)', coalesce(r,'none'), p_roles;
  end if;
end $$;

-- Admin-token guard, as used by record_manual_license / community_admin_list.
create or replace function moderator_session_role(p_token text)
returns text language sql stable as $$
  select case when p_token = 'ADMIN-OK' then 'admin'
              when p_token = 'MOD-OK'   then 'moderator' end
$$;
