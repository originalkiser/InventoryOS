-- Staffing Alerts — user-configured threshold rules across the 6 KPIs
-- Staffing Report already tracks (LHCE, Labor % of Revenue, Daily/Weekly
-- Hours by Employee, Daily/Weekly Hours by Shop), evaluated by a scheduled
-- backend job (staffing-alerts-refresh, same Data Connections dispatcher
-- pattern as every other scheduled sync here) rather than live in the
-- browser — persists between visits, and could notify later without
-- redesigning anything.
--
-- Evaluation period per KPI (fixed, not user-configurable — keeps this
-- from needing a 7th "which period" field per rule): lhce/
-- labor_pct_revenue/daily_hours_shop/daily_hours_employee check YESTERDAY;
-- weekly_hours_shop/weekly_hours_employee check the last COMPLETED week
-- (Sunday-start, matching this app's existing week convention). A shop-
-- or company-level LHCE/Labor % of Revenue rule with scope 'all' is
-- evaluated once PER SHOP (not one combined company-wide number) — "apply
-- to all shops" means every shop gets checked against the same threshold,
-- not that the shops get rolled up into one company figure first.
CREATE TABLE IF NOT EXISTS inventory.staffing_alert_rules (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  kpi            text        NOT NULL CHECK (kpi IN (
                    'lhce', 'labor_pct_revenue', 'daily_hours_employee',
                    'weekly_hours_employee', 'daily_hours_shop', 'weekly_hours_shop'
                  )),
  operator       text        NOT NULL CHECK (operator IN ('gt', 'lt', 'between')),
  threshold_low  numeric     NOT NULL,
  threshold_high numeric,    -- only meaningful (and required) when operator = 'between'
  scope          text        NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'selected')),
  location_ids   uuid[]      NOT NULL DEFAULT '{}',  -- only meaningful when scope = 'selected'
  enabled        boolean     NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory.staffing_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staffing_alert_rules_select" ON inventory.staffing_alert_rules;
CREATE POLICY "staffing_alert_rules_select" ON inventory.staffing_alert_rules FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "staffing_alert_rules_manage" ON inventory.staffing_alert_rules;
CREATE POLICY "staffing_alert_rules_manage" ON inventory.staffing_alert_rules FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Snapshot-style, not a history log: each run replaces this company's
-- entire violation set with whatever's true as of that run (see the
-- Edge Function's own header comment) — "builds a table looking for
-- those configurations" implies current state, not an audit trail.
-- rule_snapshot freezes the kpi/operator/thresholds at evaluation time so
-- a later rule edit doesn't retroactively relabel an already-detected row.
CREATE TABLE IF NOT EXISTS inventory.staffing_alert_violations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid        NOT NULL REFERENCES inventory.staffing_alert_rules(id) ON DELETE CASCADE,
  company_id      uuid        NOT NULL,
  location_id     uuid,
  shop_label      text,
  droptop_user_id text,
  employee_name   text,
  period_start    date        NOT NULL,
  period_end      date        NOT NULL,
  actual_value    numeric     NOT NULL,
  rule_snapshot   jsonb       NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_staffing_alert_violations_company ON inventory.staffing_alert_violations (company_id, rule_id);

ALTER TABLE inventory.staffing_alert_violations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staffing_alert_violations_select" ON inventory.staffing_alert_violations;
CREATE POLICY "staffing_alert_violations_select" ON inventory.staffing_alert_violations FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only.

-- Seed a disabled-by-default daily schedule, same precedent as every
-- other connection (see 20260908d_monday_locations_schedule.sql) — an
-- admin turns it on from Data Connections once the rules built on the
-- Alerts tab have been reviewed. daily_time left null (fires once the
-- admin sets a time from the Data Connections card, same as any other
-- 'daily'-mode schedule with no time set yet).
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode)
SELECT DISTINCT company_id, 'staffing_alerts', 'daily'
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
