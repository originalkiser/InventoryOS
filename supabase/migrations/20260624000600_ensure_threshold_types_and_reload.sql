-- Idempotently add per-rule threshold type columns to inventory.recount_config,
-- then force PostgREST to reload its schema cache.
-- Safe to run even if 20260624000200 already ran — IF NOT EXISTS is a no-op.

ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS var_med_threshold_type text NOT NULL DEFAULT 'percentage'
    CHECK (var_med_threshold_type IN ('percentage', 'dollar')),
  ADD COLUMN IF NOT EXISTS var_last_threshold_type text NOT NULL DEFAULT 'percentage'
    CHECK (var_last_threshold_type IN ('percentage', 'dollar'));

-- Back-fill from legacy threshold_type if present
UPDATE inventory.recount_config
SET
  var_med_threshold_type  = COALESCE(threshold_type, 'percentage'),
  var_last_threshold_type = COALESCE(threshold_type, 'percentage')
WHERE var_med_threshold_type = 'percentage'
  AND threshold_type IS NOT NULL
  AND threshold_type <> 'percentage';

-- Force PostgREST schema cache reload
SELECT pg_notify('pgrst', 'reload schema');
