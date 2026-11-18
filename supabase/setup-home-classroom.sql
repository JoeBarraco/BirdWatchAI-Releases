-- ============================================================
-- BirdWatchAI Home Classroom — Classroom for a family, at home
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- Run AFTER setup-school-subscription.sql, setup-school-purchase.sql and
-- setup-school-classroom-limits.sql.
--
-- WHAT IT IS
-- A parent with a BirdWatchAI feeder runs the same lessons a school does,
-- for their own children, on the TV or a tablet. Each child is a "class"
-- with their own grade band. A yearly term, with a 30-day free trial.
--
-- HOW: A PRIVATE ONE-FAMILY COMMUNITY, NOT A CLASSROOM WITHOUT ONE ⚠
-- Classrooms belong to a school community, and that is load-bearing:
-- trg_classrooms_school refuses a classroom anywhere else, every access
-- check (classroom_require_manage and the eighteen functions behind it)
-- goes through the community's roles, the term lives on the community
-- (school_expires_at), and RLS hides a private community's feeders and
-- detections from everyone outside it. A classroom with no community would
-- mean reopening all of that. So a Home Classroom IS a community — private,
-- kind 'school', one member (the parent, as owner), up to three feeders —
-- marked is_home so the site can call it a family and leave out the parts
-- of school that make no sense at home. Everything else just works.
--
-- WHAT THIS FILE ADDS
--   1. communities.is_home, and community_unlock_codes.for_home.
--   2. home_classroom_start: a signed-in person makes their Home
--      Classroom, with a 30-day trial term. One trial per person, ever.
--   3. community_apply_school_code learns that a home code only fits a
--      home community. Without this a Home Classroom code, priced for a
--      family, would extend a whole SCHOOL's term just as well.
--   4. community_mint_home_code: the admin mints a paid home code (12
--      months, 4 children by default) until a Gumroad product does it.
--   5. community_my_communities also returns kind and is_home.
-- ============================================================

begin;

alter table communities
  add column if not exists is_home boolean not null default false;
alter table community_unlock_codes
  add column if not exists for_home boolean not null default false;

-- Who has had a trial. Kept apart from communities so deleting a Home
-- Classroom does not hand out a second free month.
create table if not exists home_classroom_trials (
  user_id      uuid primary key,
  community_id uuid references communities(id) on delete set null,
  started_at   timestamptz not null default now()
);
alter table home_classroom_trials enable row level security;
revoke all on home_classroom_trials from public, anon, authenticated;

create or replace function home_classroom_trial_days() returns int
language sql immutable as $$ select 30 $$;
create or replace function home_classroom_child_limit() returns int
language sql immutable as $$ select 4 $$;
revoke execute on function home_classroom_trial_days()   from public, anon, authenticated;
revoke execute on function home_classroom_child_limit()  from public, anon, authenticated;


-- ── 2. Start a Home Classroom ────────────────────────────────────────
--
-- Returns the person's Home Classroom, making it if there is none. Asking
-- twice gives the same one back rather than an error: the button may be
-- pressed twice, and the second press should not be a failure.
create or replace function home_classroom_start(p_name text default null)
returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  uid    uuid := auth.uid();
  c      communities%rowtype;
  v_name text := left(coalesce(nullif(trim(p_name), ''), 'Our Home Classroom'), 80);
  v_slug text;
  trial  boolean;
  alpha  constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  i      int;
begin
  if uid is null then
    raise exception 'Sign in first';
  end if;

  select * into c from communities
   where is_home and owner_user_id = uid
   order by created_at limit 1;
  if c.id is not null then
    return json_build_object('community_id', c.id, 'slug', c.slug, 'name', c.name,
                             'expires_at', c.school_expires_at, 'created', false);
  end if;

  perform pg_advisory_xact_lock(hashtext('home_classroom_start:' || uid::text));
  trial := not exists (select 1 from home_classroom_trials where user_id = uid);

  loop
    v_slug := 'home-';
    for i in 1..8 loop
      v_slug := v_slug || substr(alpha, 1 + floor(random() * length(alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from communities where slug = v_slug);
  end loop;

  insert into communities (slug, name, visibility, owner_user_id, suppress_location,
                           tier, feeder_limit, kind, is_home,
                           school_expires_at, classroom_limit)
  values (v_slug, v_name, 'private', uid, true,
          'small', 3, 'school', true,
          -- No trial left: no term at all, which community_school_state
          -- reads as 'lapsed' straight away. NOT now(): a term that ends now
          -- would still get the schools' 30-day grace, a free month by the
          -- back door. A code applied later starts the term from today.
          case when trial then now() + make_interval(days => home_classroom_trial_days())
               else null end,
          home_classroom_child_limit())
  returning * into c;

  insert into community_members (community_id, user_id, role)
  values (c.id, uid, 'owner')
  on conflict (community_id, user_id) do nothing;

  if trial then
    insert into home_classroom_trials (user_id, community_id) values (uid, c.id);
  end if;

  return json_build_object('community_id', c.id, 'slug', c.slug, 'name', c.name,
                           'expires_at', c.school_expires_at, 'created', true,
                           'trial', trial);
end;
$$;
revoke execute on function home_classroom_start(text) from public, anon;
grant  execute on function home_classroom_start(text) to authenticated;


-- ── 3. A home code fits a home community only ────────────────────────
-- The function as setup-school-classroom-limits.sql left it, with one
-- check added before the code is spent. A school code on a Home
-- Classroom is allowed: it costs more and buys at least as much.
create or replace function community_apply_school_code(p_code text, p_community_id uuid)
returns json
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  c           communities%rowtype;
  v_code_id   uuid;
  v_months    int;
  v_rooms     int;
  v_has_rooms boolean;
  v_base      timestamptz;
  v_new       timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign-in required';
  end if;

  perform community_require_role(p_community_id, auth.uid(), array['owner']);

  select * into c from communities where id = p_community_id;
  if c.id is null then
    raise exception 'Community not found';
  end if;

  if c.school_perpetual then
    raise exception
      'This community already has school mode permanently. Save the code '
      'for another one.';
  end if;

  if not c.is_home and exists (
       select 1 from community_unlock_codes
        where code = upper(trim(p_code)) and product = 'school' and for_home
          and redeemed_at is null and revoked_at is null) then
    raise exception 'That is a Home Classroom code. It works on a Home Classroom, not on a school';
  end if;

  update community_unlock_codes
     set redeemed_at = now(),
         redeemed_by = auth.uid()
   where code = upper(trim(p_code))
     and product = 'school'
     and redeemed_at is null
     and revoked_at is null
  returning id, school_months, classroom_limit,
            (classroom_limit is not null)
    into v_code_id, v_months, v_rooms, v_has_rooms;

  if v_code_id is null then
    raise exception 'That code is not valid, or has already been used';
  end if;

  v_base := case
              when c.school_expires_at is not null
               and c.school_expires_at > now() then c.school_expires_at
              else now()
            end;
  v_new := v_base + make_interval(months => v_months);

  update communities
     set school_expires_at = v_new,
         kind              = 'school',
         classroom_limit   = case when v_has_rooms then v_rooms
                                  else classroom_limit end
   where id = p_community_id;

  update community_unlock_codes
     set community_id = p_community_id
   where id = v_code_id;

  return json_build_object(
    'community_id', p_community_id,
    'months',       v_months,
    'expires_at',   v_new,
    'classrooms',   community_classroom_usage(p_community_id),
    'state',        community_school_state(p_community_id));
end;
$function$;


-- ── 4. Minting a home code (admin) ───────────────────────────────────
-- Same shape and guard as community_mint_school_code; BWH- instead of
-- BWS- so a code says at a glance which kind it is.
create or replace function community_mint_home_code(
  p_token           text,
  p_customer_email  text,
  p_months          int  default 12,
  p_customer_name   text default null,
  p_order_reference text default null,
  p_children        int  default null
)
returns json
language plpgsql security definer
set search_path to 'public', 'extensions'
as $function$
declare
  admin_role text;
  alphabet   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate  text;
  made       text;
  rnd        bytea;
  i          int;
  attempt    int;
  kids       int := coalesce(p_children, home_classroom_child_limit());
begin
  admin_role := moderator_session_role(p_token);
  if admin_role is null or admin_role <> 'admin' then
    raise exception 'Admin access required';
  end if;
  if coalesce(trim(p_customer_email), '') = '' then
    raise exception 'customer_email is required';
  end if;
  if p_months is null or p_months < 1 or p_months > 60 then
    raise exception 'months must be between 1 and 60';
  end if;
  if kids < 1 or kids > 10 then
    raise exception 'children must be between 1 and 10';
  end if;

  for attempt in 1..5 loop
    rnd := gen_random_bytes(12);
    candidate := 'BWH';
    for i in 1..12 loop
      if i % 4 = 1 then candidate := candidate || '-'; end if;
      candidate := candidate || substr(alphabet, 1 + (get_byte(rnd, i - 1) % 32), 1);
    end loop;
    begin
      insert into community_unlock_codes
        (code, product, school_months, classroom_limit, for_home, customer_email,
         customer_name, source, order_reference)
      values
        (candidate, 'school', p_months, kids, true, lower(trim(p_customer_email)),
         p_customer_name, 'manual', nullif(trim(p_order_reference), ''))
      returning code into made;
      exit;
    exception when unique_violation then
      made := null;
    end;
  end loop;
  if made is null then
    raise exception 'Could not mint a unique code; try again';
  end if;
  return json_build_object('code', made, 'months', p_months, 'children', kids,
                           'email', lower(trim(p_customer_email)));
end;
$function$;
revoke execute on function community_mint_home_code(text, text, int, text, text, int) from public, anon;
grant  execute on function community_mint_home_code(text, text, int, text, text, int) to authenticated;


-- ── 5. My communities, with kind and is_home ─────────────────────────
create or replace function community_my_communities()
returns json
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  result json;
begin
  select json_agg(row_to_json(t) order by t.name) into result
  from (
    select c.id, c.slug, c.name, c.visibility, m.role, c.logo_url,
           c.kind, c.is_home
    from communities c
    join community_members m on m.community_id = c.id
    where m.user_id = auth.uid()
  ) t;

  return coalesce(result, '[]'::json);
end;
$function$;

commit;
