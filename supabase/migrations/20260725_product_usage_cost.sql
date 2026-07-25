-- Product Usage: per-unit cost (Total Cost = on_hands × cost_per_unit is derived
-- in the UI). Nullable so existing rows and imports without cost keep working.
ALTER TABLE inventory.product_usage
  ADD COLUMN IF NOT EXISTS cost_per_unit numeric;
