-- ════════════════════════════════════════════════════════════════════
--  One-time rarity re-classification of shared history  (2026-08-22)
-- ════════════════════════════════════════════════════════════════════
--
--  WHY
--  The server's static rarity table had 43 entries and returned
--  "very-rare" for anything missing from it. That stamped the entire long
--  tail of real birds with the TOP rarity tier: all 129 "Very Rare" rows
--  on this feed were table misses, not rarity judgements — 84
--  Yellow-throated Warblers, 35 Pine Warblers, both routine Florida
--  winter feeder birds. Meanwhile "Rare" had ZERO rows across 9,634
--  detections, because that band needs a frequency in [1,5) and only four
--  table entries qualified, three of them boreal species.
--
--  birdwatchai-server 9cb9bc3 fixes the classifier: a table miss now
--  returns null instead of "very-rare", and the table grew 43 -> 160
--  entries. That corrects NEW detections only. This script corrects the
--  history already shared here.
--
--  SCOPE — deliberately a fixed species list, not a port of the 160-entry
--  table. Duplicating that table in SQL would create two copies that
--  drift apart the moment someone edits the C# one. This is a
--  point-in-time correction of the 11 species actually present on this
--  feed; every future detection gets its rarity from the app at insert
--  time, so there is nothing ongoing for SQL to own.
--
--  PRESERVES OPERATOR KNOWLEDGE. Species absent from the list below are
--  not touched. That matters most for "Squirrel" (165 rows, labelled
--  Common): the bird-frequency table has no opinion about mammals, so the
--  classifier now returns null for it. Sweeping that to null would throw
--  away a label the operator set by hand.
--
--  Expected: 351 rows change — 134 rarity corrections and 217 blank
--  fills (rows shared before the local rarity was known).
--
--  Run the whole file top to bottom. Idempotent: a second run reports
--  0 changed rows and leaves the original backup table intact.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. Backup ───────────────────────────────────────────────────────
-- In-database, so rollback needs nothing but this project. Created only
-- on the first run, so re-running can't overwrite the pre-sweep state
-- with post-sweep values.
create table if not exists rarity_sweep_backup_20260822 as
select id, species, rarity, now() as captured_at
  from community_detections;

-- Belt and braces: nobody but the owner should read or touch it.
alter table rarity_sweep_backup_20260822 enable row level security;

select count(*) as rows_backed_up from rarity_sweep_backup_20260822;


-- ── 2. Re-classify ──────────────────────────────────────────────────
with target(species, rarity) as (
    values
        -- Corrections: were "Very Rare" purely because the species was
        -- missing from the old 43-entry table.
        ('Yellow-throated Warbler', 'Rare'),      -- 3% — uncommon at feeders, not exceptional
        ('Pine Warbler',            'Uncommon'),  -- 6% — routine SE feeder bird, takes suet
        ('Palm Warbler',            'Rare'),      -- 4% — common in FL, rarely at feeders
        ('Common Yellowthroat',     'Rare'),      -- 2% — widespread but skulking
        ('Hermit Thrush',           'Rare'),      -- 4% — regular winter, occasional at feeders

        -- Blank fills: these rows were shared before the local rarity was
        -- resolved, so they carry '' while their siblings carry a value.
        -- Same species, same rarity — no reason for them to disagree.
        ('Northern Cardinal',       'Common'),
        ('Tufted Titmouse',         'Common'),
        ('Carolina Wren',           'Common'),
        ('Carolina Chickadee',      'Common'),
        ('Red-bellied Woodpecker',  'Common'),
        ('Gray Catbird',            'Uncommon')
)
update community_detections d
   set rarity = t.rarity
  from target t
 where d.species = t.species
   -- `is distinct from` so SQL NULL and '' are both caught, and rows
   -- already correct are left alone.
   and d.rarity is distinct from t.rarity;


-- ── 3. What changed ─────────────────────────────────────────────────
select b.species,
       coalesce(nullif(b.rarity, ''), '(blank)') as was,
       coalesce(nullif(d.rarity, ''), '(blank)') as now,
       count(*)                                  as rows
  from rarity_sweep_backup_20260822 b
  join community_detections d on d.id = b.id
 where b.rarity is distinct from d.rarity
 group by 1, 2, 3
 order by rows desc;


-- ── 4. Feed-wide rarity mix after the sweep ─────────────────────────
-- "Very Rare" should be 0, "Rare" should hold the 134 corrected rows,
-- and Squirrel's 165 Common rows must be untouched.
select coalesce(nullif(rarity, ''), '(blank)') as rarity, count(*) as rows
  from community_detections
 group by 1
 order by rows desc;


-- ════════════════════════════════════════════════════════════════════
--  Verify (run separately)
-- ════════════════════════════════════════════════════════════════════
-- Preserve rule held?  Expect: Common | 165
--
--   select rarity, count(*) from community_detections
--    where species = 'Squirrel' group by 1;
--
-- Badge effect — derived, so they re-score on the next page load:
--
--   select display_name, rare_count, very_rare_count, rare_plus_count
--     from feeder_badge_stats order by rare_plus_count desc;
--
-- ════════════════════════════════════════════════════════════════════
--  Rollback (only if needed)
-- ════════════════════════════════════════════════════════════════════
--   update community_detections d
--      set rarity = b.rarity
--     from rarity_sweep_backup_20260822 b
--    where b.id = d.id
--      and d.rarity is distinct from b.rarity;
--
-- Once you're satisfied — a week or so of the dashboard looking right:
--
--   drop table rarity_sweep_backup_20260822;
