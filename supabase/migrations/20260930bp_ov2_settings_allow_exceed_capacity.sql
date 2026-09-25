-- Orders v2's per-company settings (inventory.ov2_settings) gain an
-- opt-in, PER-VENDOR map: when a vendor_id key is true, Pass 1 of the
-- generation engine is allowed to order past a product's configured
-- capacity when capacity alone is what's holding a line short of the
-- Target days-of-supply, instead of always clamping to capacity (see
-- engine.ts's exceedsCapacityForTarget and the
-- 'exceeded_capacity_for_dos_target' LineFlag). Empty/absent = off for that
-- vendor — capacity otherwise remains the one truly hard, never-exceeded
-- ceiling this engine's own minimum/smoothing logic relies on.
--
-- A jsonb map (vendor_id -> boolean), not a plain boolean column, per
-- direct feedback the same day this was first added: different vendors
-- want this on/off independently (e.g. Valvoline on, RelaDyne off) — same
-- "Record<string, boolean>" shape Exception Reporting's own
-- poAlertSuppliers already uses for a per-supplier toggle list. This
-- migration was written and never applied in this same session (no DB
-- credentials in that sandbox), so it's edited in place here rather than
-- adding a second migration for the same still-unapplied feature.
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS allow_exceed_capacity_for_dos_target_vendors jsonb NOT NULL DEFAULT '{}'::jsonb;
