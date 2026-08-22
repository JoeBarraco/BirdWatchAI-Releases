-- ════════════════════════════════════════════════════════════════════
--  Feeder badges — per-feeder achievement aggregates
-- ════════════════════════════════════════════════════════════════════
--
--  Ports the WinForms app's BadgeService achievements to the community
--  dashboard so feeders can compete on shared sightings.
--
--  DESIGN: this view emits only the RAW AGGREGATES the badge rules need
--  — one row per feeder, ~45 scalar columns plus a species array. The
--  rule table itself lives in docs/js/community-badges.js, mirroring the
--  C# catalog. That split matters:
--
--    * Adding a badge is a one-line JS edit, never a migration.
--    * Badges are DERIVED, never stored, so a species correction (which
--      CommunityShareService already patches upstream) automatically
--      un-earns a badge. That is the problem ReevaluateAllBadges() was
--      fighting locally; here it costs nothing.
--    * 6 rows over the wire instead of ~9.6k detections.
--
--  A persisted feeder_badges table with unlock timestamps was
--  deliberately NOT built. It's the only way to get "🎉 X just earned
--  Century Club" or earned-on dates, and it needs a writer (cron edge
--  function) plus a backfill. Revisit when announcements are wanted.
--
--  SECURITY: security_invoker = true is REQUIRED, not optional. Postgres
--  views default to security_invoker = off, which runs the view as its
--  OWNER and so BYPASSES row-level security on community_detections and
--  feeders — that would leak private-community feeders' stats to anon
--  through the published anon key. With invoker semantics the caller's
--  RLS applies and a private feeder simply produces no row. Same class
--  of mistake as the "revoke execute from anon" trap documented in
--  CLAUDE.md: the safe-looking default is the leaky one.
--
--  TIMEZONE: days are bucketed in America/New_York, not in the viewer's
--  browser timezone (which is what the Stats leaderboard's localDayKey
--  uses). Deliberate — a badge must not appear or vanish depending on
--  who is looking at the page, and it matches the ET convention already
--  used for burned-in caption timestamps.
--
--  Apply: paste into the Supabase SQL editor (project lsamggztfizmkyljdgwq).
--  Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════

drop view if exists feeder_badge_stats;

create view feeder_badge_stats
with (security_invoker = true) as

-- Every shared detection, projected into local (ET) time once so the
-- day/hour/month buckets below all agree with each other.
with d as (
    select
        cd.feeder_id,
        cd.species,
        cd.rarity,
        cd.confidence,
        cd.temperature,
        cd.image_url,
        cd.video_url,
        (cd.detected_at at time zone 'America/New_York')        as local_ts,
        ((cd.detected_at at time zone 'America/New_York'))::date as local_day
    from community_detections cd
    where cd.species is not null
      and cd.species <> ''
),

-- ── One row per feeder-day ──────────────────────────────────────────
-- Powers the daily-activity badges, the streak families, and the
-- weekend/early/late consistency badges.
per_day as (
    select
        feeder_id,
        local_day,
        count(*)                                                  as n,
        count(distinct species)                                   as n_species,
        count(*) filter (where rarity in ('Rare', 'Very Rare'))   as n_rare_plus,
        bool_or(extract(hour from local_ts) <  7)                 as has_early,
        bool_or(extract(hour from local_ts) >= 20)                as has_late
    from d
    group by feeder_id, local_day
),

day_peaks as (
    select
        feeder_id,
        max(n)           as max_day_count,
        max(n_species)   as max_day_species,
        max(n_rare_plus) as max_day_rare_plus
    from per_day
    group by feeder_id
),

-- ── Streaks (gaps-and-islands) ──────────────────────────────────────
-- Consecutive days collapse to a constant when you subtract the row
-- number from the date, so each run of consecutive days shares a grp.
runs_all as (
    select
        feeder_id,
        grp,
        count(*)       as len,
        max(local_day) as run_end
    from (
        select
            feeder_id,
            local_day,
            local_day - (row_number() over (partition by feeder_id order by local_day))::int as grp
        from per_day
    ) s
    group by feeder_id, grp
),

-- "Current" tolerates yesterday as well as today: a feeder that simply
-- hasn't logged a bird yet this morning has not lost its streak.
streak_agg as (
    select
        feeder_id,
        max(len) as longest_streak,
        coalesce(
            max(len) filter (
                where run_end >= ((now() at time zone 'America/New_York')::date - 1)
            ), 0
        ) as current_streak
    from runs_all
    group by feeder_id
),

-- Same island trick over only the days that had a pre-7am detection,
-- and again for post-8pm. Longest run is what the badge asks for.
runs_early as (
    select feeder_id, grp, count(*) as len
    from (
        select
            feeder_id,
            local_day,
            local_day - (row_number() over (partition by feeder_id order by local_day))::int as grp
        from per_day
        where has_early
    ) s
    group by feeder_id, grp
),

runs_late as (
    select feeder_id, grp, count(*) as len
    from (
        select
            feeder_id,
            local_day,
            local_day - (row_number() over (partition by feeder_id order by local_day))::int as grp
        from per_day
        where has_late
    ) s
    group by feeder_id, grp
),

dawn_dusk as (
    select
        coalesce(e.feeder_id, l.feeder_id)  as feeder_id,
        coalesce(e.longest_early_streak, 0) as longest_early_streak,
        coalesce(l.longest_late_streak,  0) as longest_late_streak
    from      (select feeder_id, max(len) as longest_early_streak from runs_early group by feeder_id) e
    full join (select feeder_id, max(len) as longest_late_streak  from runs_late  group by feeder_id) l
           on l.feeder_id = e.feeder_id
),

-- ── Weekend warrior ─────────────────────────────────────────────────
-- "Detections every weekend for a month" → the longest run of
-- consecutive ISO weeks that each contain a Saturday or Sunday sighting.
weekend_weeks as (
    select distinct
        feeder_id,
        (date_trunc('week', local_day))::date as wk
    from per_day
    where extract(isodow from local_day) in (6, 7)
),

weekend_runs as (
    select feeder_id, max(len) as longest_weekend_weeks
    from (
        select feeder_id, grp, count(*) as len
        from (
            select
                feeder_id,
                wk,
                -- Weeks step by 7 days, so divide before differencing.
                (wk - (row_number() over (partition by feeder_id order by wk) * 7)::int) as grp
            from weekend_weeks
        ) s
        group by feeder_id, grp
    ) r
    group by feeder_id
),

-- ── Everything else, straight off the detection rows ────────────────
base as (
    select
        feeder_id,

        -- Detection milestones / species collection
        count(*)                                                   as total_detections,
        count(distinct species)                                    as distinct_species,
        min(local_ts)                                              as first_shared_at,
        max(local_ts)                                              as last_shared_at,
        count(distinct local_day)                                  as active_days,

        -- Media milestones. NOTE: video_url is only populated when the
        -- feeder has clip sharing enabled in Settings → Community, so
        -- these are partly a config artifact rather than an achievement.
        count(*) filter (where image_url is not null and image_url <> '') as image_count,
        count(*) filter (where video_url is not null and video_url <> '') as video_count,

        -- Rarity hunter. Community rarity vocabulary is
        -- Common/Uncommon/Rare/Very Rare (CommunityShareService
        -- .ToCommunityRarity); older rows carry ''. There is no
        -- "Exceptional" tier server-side, so the app's *_exceptional
        -- badges have no counterpart here and are not in the JS catalog.
        count(*) filter (where rarity = 'Uncommon')                       as uncommon_count,
        count(*) filter (where rarity = 'Rare')                           as rare_count,
        count(*) filter (where rarity = 'Very Rare')                      as very_rare_count,
        count(*) filter (where rarity in ('Rare', 'Very Rare'))           as rare_plus_count,
        count(distinct species) filter (where rarity in ('Rare', 'Very Rare')) as rare_species,

        -- Weather warrior (temperature is populated on ~99.5% of rows)
        min(temperature)                                    as min_temp,
        max(temperature)                                    as max_temp,
        count(*) filter (where temperature <  10)           as below_10_count,
        count(*) filter (where temperature <  32)           as below_32_count,
        count(*) filter (where temperature <  40)           as below_40_count,
        count(*) filter (where temperature >  80)           as above_80_count,
        count(*) filter (where temperature >  90)           as above_90_count,
        count(*) filter (where temperature > 100)           as above_100_count,
        count(distinct width_bucket(temperature, 32, 85, 3))
            filter (where temperature is not null)          as temp_buckets,

        -- Special achievements
        max(confidence)                                             as max_confidence,
        count(*) filter (where confidence >= 95)                    as conf_95_count,
        count(*) filter (where extract(hour from local_ts) < 5)     as midnight_count,
        count(*) filter (where extract(hour from local_ts) = 5)     as dawn_count,

        -- Season coverage: 1=winter 2=spring 3=summer 4=fall
        count(distinct ((extract(month from local_ts)::int % 12) / 3)) as season_count,

        -- Holiday watcher: New Year's Day, Independence Day, Christmas
        -- Eve/Day, New Year's Eve, and US Thanksgiving (4th Thursday of
        -- November — i.e. an ISO-Thursday falling on the 22nd–28th).
        count(*) filter (
            where (extract(month from local_ts), extract(day from local_ts))
                    in ((1,1), (7,4), (12,24), (12,25), (12,31))
               or (extract(month from local_ts) = 11
                   and extract(isodow from local_ts) = 4
                   and extract(day from local_ts) between 22 and 28)
        ) as holiday_count,

        count(*) filter (
            where extract(month from local_ts) = 1 and extract(day from local_ts) = 1
        ) as new_year_count,

        -- Species families are name-substring rules in the app, so the
        -- distinct species list is all the JS catalog needs.
        --
        -- Caveat the JS handles, not the SQL: the detector also reports
        -- non-birds ("Squirrel" is live in this data), so the catalog
        -- filters species_list through a not-a-bird list before counting
        -- toward the species-collection ladder. distinct_species above
        -- stays raw so it keeps matching the Stats leaderboard's column.
        array_agg(distinct species order by species) as species_list

    from d
    group by feeder_id
),

-- Per-species detection counts, for the three app badges that key off a
-- single species' volume rather than its presence (cardinal_collector,
-- blue_jay_buddy, robin_regular). Bounded by distinct species — 16 today
-- — so it costs nothing to ship the whole map and let JS match names.
per_species as (
    select feeder_id, species, count(*) as n
    from d
    group by feeder_id, species
),

species_counts as (
    select feeder_id, jsonb_object_agg(species, n) as species_counts
    from per_species
    group by feeder_id
),

-- Anniversary: a sighting on the (month, day) the feeder first shared,
-- at least a full year later.
anniversary as (
    select
        d.feeder_id,
        count(*) as anniversary_count
    from d
    join base b on b.feeder_id = d.feeder_id
    where extract(month from d.local_ts) = extract(month from b.first_shared_at)
      and extract(day   from d.local_ts) = extract(day   from b.first_shared_at)
      and d.local_ts >= b.first_shared_at + interval '1 year'
    group by d.feeder_id
)

select
    f.id                                            as feeder_id,
    f.display_name,
    f.created_at                                    as joined_at,

    b.total_detections,
    b.distinct_species,
    b.first_shared_at,
    b.last_shared_at,
    b.active_days,

    -- Two different tenure clocks, and the difference is not academic.
    --
    -- days_since_joined is when the feeder row was created here.
    -- days_of_history is how far back its earliest shared sighting goes.
    --
    -- They diverge sharply because the three original feeders had their
    -- WinForms history BACKFILLED: they registered in June 2026 but
    -- carry sightings from January, so days_since_joined (70) is smaller
    -- than active_days (177) — a nonsensical basis for a tenure ladder.
    -- The dedication/loyalty badges therefore key off days_of_history,
    -- which is the honest analogue of the app's "days since first use".
    greatest(0, ((now() at time zone 'America/New_York')::date - (f.created_at at time zone 'America/New_York')::date))::int
        as days_since_joined,
    greatest(0, ((now() at time zone 'America/New_York')::date - b.first_shared_at::date))::int
        as days_of_history,

    coalesce(dp.max_day_count,     0) as max_day_count,
    coalesce(dp.max_day_species,   0) as max_day_species,
    coalesce(dp.max_day_rare_plus, 0) as max_day_rare_plus,

    coalesce(sa.current_streak, 0) as current_streak,
    coalesce(sa.longest_streak, 0) as longest_streak,
    coalesce(dd.longest_early_streak, 0) as longest_early_streak,
    coalesce(dd.longest_late_streak,  0) as longest_late_streak,
    coalesce(wr.longest_weekend_weeks, 0) as longest_weekend_weeks,

    b.image_count,
    b.video_count,

    b.uncommon_count,
    b.rare_count,
    b.very_rare_count,
    b.rare_plus_count,
    b.rare_species,

    b.min_temp,
    b.max_temp,
    case when b.min_temp is null or b.max_temp is null then 0
         else (b.max_temp - b.min_temp) end as temp_range,
    b.below_10_count,
    b.below_32_count,
    b.below_40_count,
    b.above_80_count,
    b.above_90_count,
    b.above_100_count,
    coalesce(b.temp_buckets, 0) as temp_buckets,

    b.max_confidence,
    b.conf_95_count,
    b.midnight_count,
    b.dawn_count,
    b.season_count,
    b.holiday_count,
    b.new_year_count,
    coalesce(an.anniversary_count, 0) as anniversary_count,

    coalesce(b.species_list, array[]::text[])    as species_list,
    coalesce(sc.species_counts, '{}'::jsonb)     as species_counts

from feeders f
-- INNER join on purpose: a feeder that has never shared a sighting gets
-- no row at all, and feederBadgeStripHtml() then returns '' so its card
-- simply omits the badge section rather than showing an all-zero shell.
join      base           b  on b.feeder_id  = f.id
left join day_peaks      dp on dp.feeder_id = f.id
left join streak_agg     sa on sa.feeder_id = f.id
left join dawn_dusk      dd on dd.feeder_id = f.id
left join weekend_runs   wr on wr.feeder_id = f.id
left join anniversary    an on an.feeder_id = f.id
left join species_counts sc on sc.feeder_id = f.id;


comment on view feeder_badge_stats is
    'Per-feeder badge aggregates. Rules live in docs/js/community-badges.js. '
    'Days bucketed in America/New_York. security_invoker=true so feeders/'
    'community_detections RLS still applies — do not remove it.';

-- Readable by the dashboard's anon key and by signed-in users. RLS on
-- the underlying tables (not this grant) is what hides private feeders.
grant select on feeder_badge_stats to anon, authenticated;


-- ── Verify ──────────────────────────────────────────────────────────
-- Confirm invoker semantics survived the deploy (must report 'true'):
--
--   select c.relname,
--          (select option_value
--             from pg_options_to_table(c.reloptions)
--            where option_name = 'security_invoker') as security_invoker
--     from pg_class c
--    where c.relname = 'feeder_badge_stats';
--
-- Smoke-test the numbers:
--
--   select display_name, total_detections, distinct_species,
--          current_streak, longest_streak, rare_plus_count,
--          min_temp, max_temp, active_days
--     from feeder_badge_stats
--    order by total_detections desc;
