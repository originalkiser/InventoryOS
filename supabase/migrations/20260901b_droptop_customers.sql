-- Droptop customer profiles — feeds the Customer Heatmap (marketing) and is
-- one of the tables exposed to the read-only Power BI role below.
--
-- Grain is (company_id, location_id, customer_id): Droptop's get-customers
-- endpoint is filtered by operation_ids but doesn't say *which* operation a
-- returned customer belongs to, so the sync calls it once per location
-- (same one-call-per-shop pattern as droptop-sync-purchase-orders) and
-- tags each row with the location_id it was pulled under. A customer who's
-- visited more than one shop gets one row per shop, not one merged row —
-- that's what lets the heatmap be scoped to a single shop or "all shops"
-- without double-counting inside either view.
--
-- lat/lng are resolved from inventory.zip_centroids by zip at sync time,
-- not from Droptop (which doesn't provide coordinates) — see
-- 20260901_zip_centroids.sql. Null when the zip isn't in that table yet;
-- such rows are excluded from the heatmap rather than mis-plotted.
CREATE TABLE IF NOT EXISTS inventory.droptop_customers (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  customer_id        text        NOT NULL,
  first_name         text,
  last_name          text,
  email              text,
  phone_number       text,
  address            text,
  city               text,
  region             text,
  zip                text,
  country            text,
  lat                numeric,
  lng                numeric,
  tags               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  meta_data          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  active             boolean     NOT NULL DEFAULT true,
  created_timestamp  timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  last_change_source text        NOT NULL DEFAULT 'droptop',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_customers_location ON inventory.droptop_customers (company_id, location_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_customers_zip ON inventory.droptop_customers (zip);

ALTER TABLE inventory.droptop_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_customers_select" ON inventory.droptop_customers;
CREATE POLICY "droptop_customers_select" ON inventory.droptop_customers FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only — no insert/update policy
-- needed for authenticated users (mirrors droptop_purchase_orders).

-- Seed a schedule row so it shows up in Config -> Data Connections like
-- every other Droptop sync. Off by default (customer lists change slowly —
-- a daily or weekly pull is plenty; the user picks the cadence).
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT company_id, 'droptop_customers', 'interval', 1440
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
