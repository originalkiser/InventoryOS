-- Recount config: percentage vs dollar toggle + mean vs median toggle
-- + count type filter + completion max adjustment threshold

ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS threshold_type text NOT NULL DEFAULT 'percentage'
    CHECK (threshold_type IN ('percentage', 'dollar')),
  ADD COLUMN IF NOT EXISTS threshold_value numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS comparison_method text NOT NULL DEFAULT 'median'
    CHECK (comparison_method IN ('mean', 'median')),
  ADD COLUMN IF NOT EXISTS eligible_count_types text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS completion_max_adjustment numeric DEFAULT NULL;

-- Backfill: migrate existing variance_to_median_pct into threshold_value for rows that have it
UPDATE inventory.recount_config
SET
  threshold_value = COALESCE(variance_to_median_pct, 10),
  threshold_type = 'percentage',
  comparison_method = 'median'
WHERE threshold_value = 10;
