-- Labor Hour Forecast — uploaded per (shop, date) plan for how many labor
-- hours are budgeted, split hourly-employee vs shop-manager so it can be
-- compared against actual clocked hours (inventory.droptop_time_records,
-- split the same way via a wage-threshold proxy — see the Staffing Report
-- page's own comment on why a proxy: Droptop's time clock data has no
-- role/title field at all, confirmed by scanning every distinct key ever
-- present in its raw payload).
CREATE TABLE IF NOT EXISTS inventory.labor_hour_forecast (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL,
  location_id            uuid        NOT NULL,
  forecast_date          date        NOT NULL,
  hourly_forecast_hours  numeric     NOT NULL DEFAULT 0,
  manager_forecast_hours numeric     NOT NULL DEFAULT 0,
  updated_by             uuid,
  last_change_source     text        NOT NULL DEFAULT 'upload',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, forecast_date)
);
CREATE INDEX IF NOT EXISTS idx_inv_labor_hour_forecast_location_date ON inventory.labor_hour_forecast (company_id, location_id, forecast_date);

ALTER TABLE inventory.labor_hour_forecast ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "labor_hour_forecast_select" ON inventory.labor_hour_forecast;
CREATE POLICY "labor_hour_forecast_select" ON inventory.labor_hour_forecast FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "labor_hour_forecast_manage" ON inventory.labor_hour_forecast;
CREATE POLICY "labor_hour_forecast_manage" ON inventory.labor_hour_forecast FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
