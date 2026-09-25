-- Orders v2's per-company settings (inventory.ov2_settings) gain an
-- opt-in toggle: when true, Pass 1 of the generation engine is allowed to
-- order past a product's configured capacity when capacity alone is what's
-- holding a line short of the Target days-of-supply, instead of always
-- clamping to capacity (see engine.ts's exceedsCapacityForTarget and the
-- 'exceeded_capacity_for_dos_target' LineFlag). Off by default — capacity
-- otherwise remains the one truly hard, never-exceeded ceiling this engine's
-- own minimum/smoothing logic relies on.
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS allow_exceed_capacity_for_dos_target boolean NOT NULL DEFAULT false;
