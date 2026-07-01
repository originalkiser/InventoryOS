-- Add per-rule threshold type columns to recount_config.
-- Safe to re-run (ADD COLUMN IF NOT EXISTS).

ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS var_med_threshold_type text NOT NULL DEFAULT 'percentage'
    CHECK (var_med_threshold_type IN ('percentage', 'dollar')),
  ADD COLUMN IF NOT EXISTS var_last_threshold_type text NOT NULL DEFAULT 'percentage'
    CHECK (var_last_threshold_type IN ('percentage', 'dollar'));

-- Back-fill from legacy threshold_type if it exists
UPDATE inventory.recount_config
SET
  var_med_threshold_type = COALESCE(threshold_type, 'percentage'),
  var_last_threshold_type = COALESCE(threshold_type, 'percentage')
WHERE var_med_threshold_type = 'percentage' AND threshold_type IS NOT NULL;
