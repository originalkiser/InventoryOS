-- ============================================================
-- Orders v2 — 'biweekly' delivery schedule type.
--
-- ov2_location_schedules already covers 'weekly' (one fixed weekday),
-- 'week_ab' (alternating weekdays driven by an uploaded A/B calendar), and
-- 'plus_business_days' (a flat turnaround). None of those fit a shop that
-- just needs "every other Thursday, starting from this known date" set up
-- proactively for a brand-new shop with no order history and no uploaded
-- calendar yet — 'week_ab' requires a real calendar upload, which is the
-- wrong tool for a simple formula-based pattern.
--
-- 'biweekly' reuses the existing delivery_dow column for the weekday and
-- adds one new column, biweekly_anchor_date — any known "on" delivery date
-- (doesn't need to be the very first one ever, just a real occurrence).
-- resolveDeliveryDate() (engine.ts) computes parity from the number of
-- weeks between the anchor's own week and a candidate week.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE inventory.ov2_location_schedules
  ADD COLUMN IF NOT EXISTS biweekly_anchor_date date;

COMMENT ON COLUMN inventory.ov2_location_schedules.biweekly_anchor_date IS
  'biweekly only: any real delivery date that falls on an "on" week — the reference point resolveDeliveryDate() computes every-other-week parity from.';

ALTER TABLE inventory.ov2_location_schedules
  DROP CONSTRAINT IF EXISTS ov2_location_schedules_schedule_type_check;
ALTER TABLE inventory.ov2_location_schedules
  ADD CONSTRAINT ov2_location_schedules_schedule_type_check
    CHECK (schedule_type IN ('weekly', 'week_ab', 'plus_business_days', 'biweekly'));

NOTIFY pgrst, 'reload schema';
