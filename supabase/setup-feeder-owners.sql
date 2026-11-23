-- ════════════════════════════════════════════════════════════════════
-- Feeder owners: link a website account to the feeders it owns.
-- Run after setup-feeder-write-tokens.sql and setup-community-engagement.sql.
-- Idempotent.
--
-- WHY
-- Website accounts and feeders were never linked: `feeders` has no owner,
-- and a feeder is known only by its device_key (public — it is the storage
-- folder name) and its write token (secret, held by the desktop app). So
-- nothing could say "this bird was seen at YOUR feeder", which the life
-- list wants (Nov 2026: mark each species "at my feeder" vs "spotted in
-- the feed").
--
-- HOW (claim with a code from the app)
--   1. The desktop app calls feeder_claim_code_create(device_key, token).
--      The write token is the proof of ownership: only the install that
--      claimed it has it. Returns a short one-time code, valid 15 minutes.
--   2. The signed-in user types that code on the website (account menu →
--      My feeders). feeder_claim(code) records them as an owner.
--
-- ⚠ LEGACY FEEDERS CANNOT BE CLAIMED. A feeder with no write token still
-- accepts writes on device_key alone (see setup-feeder-write-tokens.sql),
-- and device_key is public, so accepting it here would let anyone claim
-- anyone's feeder. feeder_claim_code_create requires a token row AND a
-- matching token. Such a feeder becomes claimable once its app upgrades
-- and claims its write token.
--
-- More than one account may own a feeder (a household), and an owner can
-- remove their own link at any time.
-- ════════════════════════════════════════════════════════════════════

create table if not exists feeder_owners (
  feeder_id  uuid        not null references feeders(id) on delete cascade,
  user_id    uuid        not null,
  claimed_at timestamptz not null default now(),
  primary key (feeder_id, user_id)
);
create index if not exists feeder_owners_user_idx on feeder_owners (user_id);

alter table feeder_owners enable row level security;
drop policy if exists "Owners see their own links" on feeder_owners;
create policy "Owners see their own links" on feeder_owners
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies: only the functions below write.

create table if not exists feeder_claim_codes (
  code       text        primary key,
  feeder_id  uuid        not null references feeders(id) on delete cascade,
  expires_at timestamptz not null
);
-- RLS on, no policies, no grants: unreadable except through the functions.
alter table feeder_claim_codes enable row level security;

-- ── 1. The app asks for a code ─────────────────────────────────────
create or replace function feeder_claim_code_create(p_device_key text, p_token text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  fid   uuid;
  alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- no 0/O, 1/I/L
  raw   text := '';
  i     int;
  exp   timestamptz := now() + interval '15 minutes';
begin
  if p_device_key is null or p_token is null or length(p_token) < 32 then
    return null;
  end if;

  select f.id into fid
    from feeders f
    join feeder_write_tokens t on t.feeder_id = f.id   -- token REQUIRED (no legacy)
   where f.device_key = p_device_key
     and t.token = p_token;

  if fid is null then
    return null;   -- unknown feeder, wrong token, or legacy (unclaimable)
  end if;

  delete from feeder_claim_codes where expires_at < now() or feeder_id = fid;

  -- 8 characters from a 31-letter alphabet: ~8.5e11 combinations, live
  -- for 15 minutes. Retry on the (vanishingly rare) collision.
  loop
    raw := '';
    for i in 1..8 loop
      raw := raw || substr(alpha, 1 + floor(random() * length(alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from feeder_claim_codes where code = raw);
  end loop;

  insert into feeder_claim_codes (code, feeder_id, expires_at) values (raw, fid, exp);

  return json_build_object(
    'code',       substr(raw, 1, 4) || '-' || substr(raw, 5, 4),
    'expires_at', exp
  );
end;
$$;

revoke execute on function feeder_claim_code_create(text, text) from public;
grant  execute on function feeder_claim_code_create(text, text) to anon, authenticated;

-- ── 2. The signed-in user enters it ────────────────────────────────
create or replace function feeder_claim(p_code text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  norm text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  fid  uuid;
  nm   text;
begin
  if uid is null then
    raise exception 'Sign in first';
  end if;

  select c.feeder_id into fid
    from feeder_claim_codes c
   where c.code = norm and c.expires_at > now();

  if fid is null then
    raise exception 'That code is not valid or has expired — get a new one from the app';
  end if;

  insert into feeder_owners (feeder_id, user_id) values (fid, uid)
  on conflict do nothing;
  delete from feeder_claim_codes where code = norm;   -- one use

  select display_name into nm from feeders where id = fid;
  return json_build_object('feeder_id', fid, 'display_name', nm);
end;
$$;

revoke execute on function feeder_claim(text) from public, anon;
grant  execute on function feeder_claim(text) to authenticated;

-- ── The caller's feeders ───────────────────────────────────────────
create or replace function my_feeders()
returns json
language sql security definer stable
set search_path = public
as $$
  select coalesce(json_agg(json_build_object(
           'feeder_id',         f.id,
           'display_name',      f.display_name,
           'is_public',         f.is_public,
           'last_heartbeat_at', f.last_heartbeat_at,
           'claimed_at',        o.claimed_at
         ) order by f.display_name), '[]'::json)
    from feeder_owners o
    join feeders f on f.id = o.feeder_id
   where o.user_id = auth.uid();
$$;

revoke execute on function my_feeders() from public, anon;
grant  execute on function my_feeders() to authenticated;

-- ── Remove your own link ───────────────────────────────────────────
create or replace function feeder_unclaim(p_feeder_id uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  delete from feeder_owners where feeder_id = p_feeder_id and user_id = auth.uid();
  return found;
end;
$$;

revoke execute on function feeder_unclaim(uuid) from public, anon;
grant  execute on function feeder_unclaim(uuid) to authenticated;

-- ── Life list: mark species seen at the list owner's own feeder ────
-- Adds `at_my_feeder` to each entry: true when the species has been
-- detected at any feeder the list's owner has claimed — whether or not
-- they added it from that detection. Life lists are public, so this
-- reveals only a yes/no, never which feeder or where.
create or replace function get_life_list(p_user_id uuid)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  result json;
begin
  select json_agg(json_build_object(
    'species',      l.species,
    'first_seen',   l.first_seen,
    'detection_id', l.detection_id,
    'notes',        l.notes,
    'at_my_feeder', exists (
        select 1
          from community_detections d
          join feeder_owners o on o.feeder_id = d.feeder_id
         where o.user_id = p_user_id
           and d.species = l.species)
  ) order by l.species)
  into result
  from user_life_list l
  where l.user_id = p_user_id;

  return coalesce(result, '[]'::json);
end;
$$;
