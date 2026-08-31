-- Droptop Orders — replaces the customer-list approach
-- (inventory.droptop_customers / droptop-sync-customers) as the Customer
-- Heatmap's data source. That table pulled EVERY customer Droptop has ever
-- seen at a shop regardless of recency (10,000+ per location in practice —
-- the exact volume concern that prompted this pivot); orders are naturally
-- date-bounded, so a routine pull only ever touches a recent window
-- (default last 30 days) instead of a shop's entire customer history.
--
-- inventory.droptop_customers and droptop-sync-customers are left in place
-- (not dropped — they hold real synced data) but are no longer written to
-- or read by anything going forward; see droptop-sync-orders' own header
-- comment.
--
-- Grain is (company_id, location_id, order_id) — one row per order, not
-- per customer, since a returning customer legitimately places multiple
-- orders and the heatmap should reflect that (an address showing up 3
-- times in 30 days IS 3 real visits' worth of signal, not a duplicate to
-- collapse). lat/lng resolved from inventory.zip_centroids by the order's
-- customer zip, same as the customer-list approach did.
CREATE TABLE IF NOT EXISTS inventory.droptop_orders (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  order_id           text        NOT NULL,
  customer_id        text,
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
  status             text,
  final_price        numeric,
  order_finalized_at timestamptz,
  order_scheduled_at timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  last_change_source text        NOT NULL DEFAULT 'droptop',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_orders_location_date ON inventory.droptop_orders (company_id, location_id, order_finalized_at);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_orders_zip ON inventory.droptop_orders (zip);

ALTER TABLE inventory.droptop_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_orders_select" ON inventory.droptop_orders;
CREATE POLICY "droptop_orders_select" ON inventory.droptop_orders FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only.

-- Seed a schedule row (Config -> Data Connections), same as every other
-- Droptop sync. Off by default.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT company_id, 'droptop_orders', 'interval', 1440
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
