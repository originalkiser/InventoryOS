-- Tank Monitors: raw/uncapped capacity + accepted variance baselines.
--
-- raw_capacity: some tanks have their working capacity (on_hand +
-- available_capacity) deliberately reduced below the tank's real physical
-- size — skybitz-tank-sync already reads the SkyBitz feed's own "capacity"
-- column to derive available_capacity, but never persisted the raw value
-- itself. This column stores it, so the Configuration view can show both
-- the (possibly reduced) working capacity and the true uncapped one.
ALTER TABLE inventory.tank_monitors ADD COLUMN IF NOT EXISTS raw_capacity numeric;

-- tank_variance_baselines: one accepted offset per (shop, product) between
-- the tank monitor's on-hand and Droptop's tracked on-hand for the same
-- product. Tank sensor drift and Droptop's own tracking naturally diverge
-- over time (unlogged waste, calibration, etc.) — accepting a baseline here
-- says "this gap is the new normal," so the On Hand view's Variance column
-- nets future readings against it instead of flagging the same
-- long-standing gap forever. Keyed by the resolved/internal product id
-- (same id used to match a tank's product against inventory.product_usage),
-- not the raw tank product_id, since multiple physical tanks on the same
-- keep-fill product are combined into one row before this ever applies.
CREATE TABLE IF NOT EXISTS inventory.tank_variance_baselines (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  location_id  uuid        NOT NULL,
  product_id   text        NOT NULL,
  baseline_qty numeric     NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  accepted_by  uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_tank_variance_baselines_location
  ON inventory.tank_variance_baselines (company_id, location_id);

ALTER TABLE inventory.tank_variance_baselines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tank_variance_baselines_select" ON inventory.tank_variance_baselines;
CREATE POLICY "tank_variance_baselines_select" ON inventory.tank_variance_baselines FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "tank_variance_baselines_insert" ON inventory.tank_variance_baselines;
CREATE POLICY "tank_variance_baselines_insert" ON inventory.tank_variance_baselines FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "tank_variance_baselines_update" ON inventory.tank_variance_baselines;
CREATE POLICY "tank_variance_baselines_update" ON inventory.tank_variance_baselines FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "tank_variance_baselines_delete" ON inventory.tank_variance_baselines;
CREATE POLICY "tank_variance_baselines_delete" ON inventory.tank_variance_baselines FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Variance flagging cushion (percent of a tank's total capacity, added on
-- top of the flat qt floor so small day-to-day noise around an accepted
-- baseline — or around zero, before one exists — doesn't keep re-flagging).
-- Stored as a normal app_settings row (platform.app_settings key
-- 'tank_variance_cushion_pct'), same as every other per-company numeric
-- setting — no schema change needed for it, no seed row required either
-- since useAppSetting's default (14) covers a company that's never touched it.
