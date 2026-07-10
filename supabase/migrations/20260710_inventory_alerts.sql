-- Inventory activity alerts: threshold rules + triggered alerts.
-- Rules match by product_id (exact, case-insensitive) and/or category
-- (substring match on Droptop product_type). Alerts fire when the absolute
-- quantity of an adjustment-type change event meets/exceeds max_adjustment.

CREATE TABLE IF NOT EXISTS inventory.alert_thresholds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  product_id         text,
  category           text,
  max_adjustment     numeric NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  last_change_source text,
  CHECK (product_id IS NOT NULL OR category IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_alert_thresholds_company
  ON inventory.alert_thresholds(company_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS inventory.inventory_alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  location_id         uuid,
  operation_id        text,
  product_id          text,
  category            text,
  change_type         text,
  quantity_change     numeric,
  threshold_id        uuid REFERENCES inventory.alert_thresholds(id) ON DELETE SET NULL,
  -- Droptop inventory_change_id; unique so re-scans never duplicate alerts
  inventory_change_id text UNIQUE,
  event_timestamp     timestamptz,
  acknowledged_at     timestamptz,
  acknowledged_by     uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_alerts_company
  ON inventory.inventory_alerts(company_id, created_at DESC);

-- ─── RLS + grants (matches existing inventory-schema convention) ───────────

ALTER TABLE inventory.alert_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.inventory_alerts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'inventory' AND tablename = 'alert_thresholds' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON inventory.alert_thresholds FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'inventory' AND tablename = 'inventory_alerts' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON inventory.inventory_alerts FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

GRANT ALL ON inventory.alert_thresholds TO authenticated, service_role;
GRANT ALL ON inventory.inventory_alerts TO authenticated, service_role;
