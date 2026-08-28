-- Automated Checks — daily anomaly detection over the Droptop movement feed
-- (inventory.daily_product_activity, inventory.product_usage) and tank
-- monitors. Flags are written into the EXISTING inventory.exception_reports
-- table (report_type = 'Automated Check', metadata->>'source' = 'automated')
-- rather than a parallel table — this stays part of Exception Reporting, not
-- a second reporting system next to it, per how this was scoped.
--
-- Two new tables support that:
--   1. tank_variance_overrides — once a shop/AM resolves a tank-variance
--      flag and it's a legitimate new baseline, this is the per-product,
--      per-location acceptable variance that stops it re-flagging.
--   2. automated_check_exclusions — growable ignore list, per check type
--      (not shared with inventory.product_on_hand_exceptions, which is
--      specifically the Recount Logic oil-check's exclusion list — a
--      product excluded from THAT check has no necessary relationship to
--      whether it should also be excluded from, say, the abnormal-adjustment
--      check here, so these stay separate tables rather than overloading
--      one table's meaning across two unrelated features).

CREATE TABLE IF NOT EXISTS inventory.tank_variance_overrides (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  location_id    uuid        NOT NULL,
  product_id     text        NOT NULL,
  tank_serials   text[]      NOT NULL DEFAULT '{}',  -- empty = applies to all this product's tanks at this location
  variance_qts   numeric     NOT NULL,
  note           text,
  set_by         uuid,
  set_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);
ALTER TABLE inventory.tank_variance_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tank_variance_overrides_select" ON inventory.tank_variance_overrides;
CREATE POLICY "tank_variance_overrides_select" ON inventory.tank_variance_overrides FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "tank_variance_overrides_manage" ON inventory.tank_variance_overrides;
CREATE POLICY "tank_variance_overrides_manage" ON inventory.tank_variance_overrides FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

CREATE TABLE IF NOT EXISTS inventory.automated_check_exclusions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  location_id  uuid,        -- null = every shop
  product_id   text,        -- null = every product for this check type
  check_type   text         NOT NULL CHECK (check_type IN ('abnormal_adjustment', 'abnormal_receipt', 'zero_on_hand_sale', 'tank_variance')),
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory.automated_check_exclusions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "automated_check_exclusions_select" ON inventory.automated_check_exclusions;
CREATE POLICY "automated_check_exclusions_select" ON inventory.automated_check_exclusions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "automated_check_exclusions_manage" ON inventory.automated_check_exclusions;
CREATE POLICY "automated_check_exclusions_manage" ON inventory.automated_check_exclusions FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Register the new connection with the Data Connections dispatcher — same
-- app-controlled scheduling as the Droptop pulls, disabled by default.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT l.company_id, 'automated_checks', 'interval', 1440
FROM core.locations l
ON CONFLICT (company_id, connection_key) DO NOTHING;
