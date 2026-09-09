-- Orders v2 — replace bulk_rounding_decimals (decimal places) with
-- bulk_rounding_increment (round to the nearest multiple of this many
-- gallons). The decimal-place model could land a bulk order on an
-- arbitrary fractional gallon figure no vendor actually ships in; an
-- increment (e.g. 5) rounds UP to the nearest real, orderable quantity
-- instead. The old bulk_rounding_decimals column is left in place,
-- unused, rather than dropped.
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS bulk_rounding_increment numeric NOT NULL DEFAULT 1;
