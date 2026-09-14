-- Splits the generic 'm5' classification bucket into its 5 specific
-- sub-categories (Air Filter, Cabin Air Filter, Wiper Blades, Additives,
-- Tire Rotation) — needed for the Staffing Report's per-KPI M5 breakdown
-- (Tire Rotation %, Air Filter %, etc., not just one combined M5%) and the
-- Manager Performance table. The original migration's own comment argued
-- M5% only ever needs count(m5)/count(oil_change), never which of the 5 a
-- package is — true for the aggregate M5% metric alone, but not once the
-- sub-category percentages themselves became something the app needs to
-- show individually.
--
-- Real production data (2026-09-30) confirmed a clean, unambiguous mapping
-- for every package name previously seeded as 'm5' — no re-classification
-- guesswork needed for the 6 already-classified rows.
-- Constraint dropped BEFORE the re-classification UPDATEs below, not after
-- — the old constraint still permitting 'm5' as a source value doesn't
-- help once the UPDATEs try to SET a not-yet-allowed target value like
-- 'air_filter', so there's no ordering that avoids dropping it first.
ALTER TABLE inventory.droptop_package_classification DROP CONSTRAINT IF EXISTS droptop_package_classification_classification_check;

UPDATE inventory.droptop_package_classification SET classification = 'air_filter', updated_at = now()
  WHERE classification = 'm5' AND package_name = 'ENGINE AIR FILTER';
UPDATE inventory.droptop_package_classification SET classification = 'cabin_air_filter', updated_at = now()
  WHERE classification = 'm5' AND package_name = 'CABIN AIR FILTER';
UPDATE inventory.droptop_package_classification SET classification = 'wiper_blades', updated_at = now()
  WHERE classification = 'm5' AND package_name IN ('WIPER BLADE REPLACEMENT', 'Wiper Blade Replacement');
UPDATE inventory.droptop_package_classification SET classification = 'additives', updated_at = now()
  WHERE classification = 'm5' AND package_name = 'Additives';
UPDATE inventory.droptop_package_classification SET classification = 'tire_rotation', updated_at = now()
  WHERE classification = 'm5' AND package_name = 'Tire Rotation';

-- Any 'm5' row this migration's own mapping above somehow missed (a
-- differently-cased or franchise-specific name variant) falls back to
-- 'additives' rather than silently keeping an now-invalid 'm5' value that
-- would just stop counting toward M5% at all — visibly wrong (grouped
-- under the wrong sub-category on the Package Mapping page, easy to spot
-- and fix there) beats silently wrong (quietly dropped out of M5%
-- entirely).
UPDATE inventory.droptop_package_classification SET classification = 'additives', updated_at = now()
  WHERE classification = 'm5';

ALTER TABLE inventory.droptop_package_classification ADD CONSTRAINT droptop_package_classification_classification_check
  CHECK (classification IN ('oil_change', 'air_filter', 'cabin_air_filter', 'wiper_blades', 'additives', 'tire_rotation', 'none'));
