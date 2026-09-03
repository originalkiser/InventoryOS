-- Droptop Orders: promote fields that were only ever inside raw_data into
-- real, queryable columns/tables. Confirmed via inspecting 25 real recent
-- payloads that nothing was actually being lost (raw_data already carries
-- the full order object), but a lot of genuinely useful data — workflow
-- timing, who worked the order, vehicle detail, payment/tax breakdown,
-- fleet-account info — sat unreachable without a JSON-path query against a
-- 190,000+ row table. Every column/table here is a straight extraction of
-- something already present in raw_data; the backfill script (run once,
-- separately, not part of this migration) populates them for every
-- already-synced order with zero re-sync from Droptop needed.
--
-- Singular per-order fields (workflow timestamps, bay, order owner,
-- pay_status, tax_exempt_total, fleet account) go on the header row.
-- Everything that's genuinely an array (vehicles, servicing_positions,
-- payments, taxes, declined items) gets its own child table, same
-- "header + item tables" shape as droptop_order_packages/_products.

ALTER TABLE inventory.droptop_orders
  ADD COLUMN IF NOT EXISTS order_opened_at            timestamptz,
  ADD COLUMN IF NOT EXISTS order_sent_to_bay_at        timestamptz,
  ADD COLUMN IF NOT EXISTS order_service_completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS order_last_updated_at       timestamptz,
  ADD COLUMN IF NOT EXISTS bay_id                      text,
  ADD COLUMN IF NOT EXISTS bay_name                    text,
  ADD COLUMN IF NOT EXISTS order_owner_id              text,
  ADD COLUMN IF NOT EXISTS order_owner_name            text,
  ADD COLUMN IF NOT EXISTS order_owner_email           text,
  ADD COLUMN IF NOT EXISTS pay_status                  text,
  ADD COLUMN IF NOT EXISTS tax_exempt_total            numeric,
  ADD COLUMN IF NOT EXISTS fleet_location_id           text,
  ADD COLUMN IF NOT EXISTS fleet_location_name         text,
  ADD COLUMN IF NOT EXISTS fleet_company_id            text,
  ADD COLUMN IF NOT EXISTS fleet_company_name          text;

CREATE INDEX IF NOT EXISTS idx_inv_droptop_orders_bay ON inventory.droptop_orders (company_id, bay_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_orders_owner ON inventory.droptop_orders (company_id, order_owner_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_orders_fleet_company ON inventory.droptop_orders (company_id, fleet_company_id);

-- Vehicle serviced on the order — VIN, mileage, decoded make/model/year.
-- An order can carry more than one vehicle (a multi-vehicle fleet drop-off).
CREATE TABLE IF NOT EXISTS inventory.droptop_order_vehicles (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id       uuid        NOT NULL,
  vin              text,
  license_plate    text,
  vehicle_name     text,
  mileage          numeric,
  vin_vehicle_make text,
  vin_vehicle_model text,
  vin_vehicle_year integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_vehicles_order ON inventory.droptop_order_vehicles (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_vehicles_vin ON inventory.droptop_order_vehicles (company_id, vin);

-- Who worked the order (technician/bay assignment), independent of
-- order_owner (who created/owns the order in Droptop, not necessarily who
-- performed the service).
CREATE TABLE IF NOT EXISTS inventory.droptop_order_servicing_positions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL,
  user_id       text,
  user_name     text,
  "position"    text,
  vin           text,
  license_plate text,
  vehicle_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_servicing_positions_order ON inventory.droptop_order_servicing_positions (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_servicing_positions_user ON inventory.droptop_order_servicing_positions (company_id, user_id);

-- Payment method/status breakdown — an order can be split across more than
-- one payment (partial card + cash, a later top-up, etc).
CREATE TABLE IF NOT EXISTS inventory.droptop_order_payments (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id         uuid        NOT NULL,
  payment_id         text,
  payment_type       text,
  sub_payment_type   text,
  status             text,
  final_amount       numeric,
  currency           text,
  payment_created_at timestamptz,
  payment_updated_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_payments_order ON inventory.droptop_order_payments (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_payments_type ON inventory.droptop_order_payments (company_id, payment_type);

-- Tax line breakdown.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_taxes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id      uuid        NOT NULL,
  name            text,
  amount          numeric,
  percentage      numeric,
  taxed_subtotal  numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_taxes_order ON inventory.droptop_order_taxes (order_id);

-- Packages/services the customer was offered and declined — upsell
-- conversion tracking. Stored as raw jsonb per item rather than structured
-- columns: every sample order inspected had an empty declined_items, so
-- the real inner shape of a populated one has never actually been
-- observed — safer to keep it whole than guess at fields that might be
-- wrong, matching this app's "don't fabricate structure you haven't seen"
-- convention (see buildGenerationInputs' keep-fill handling for the same
-- principle elsewhere). Promote specific fields to real columns once a
-- real populated example is seen.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_declined_items (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id uuid        NOT NULL,
  item_type  text        NOT NULL CHECK (item_type IN ('package', 'service')),
  raw_data   jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_declined_items_order ON inventory.droptop_order_declined_items (order_id);

ALTER TABLE inventory.droptop_order_vehicles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_vehicles_select" ON inventory.droptop_order_vehicles;
CREATE POLICY "droptop_order_vehicles_select" ON inventory.droptop_order_vehicles FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.droptop_order_servicing_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_servicing_positions_select" ON inventory.droptop_order_servicing_positions;
CREATE POLICY "droptop_order_servicing_positions_select" ON inventory.droptop_order_servicing_positions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.droptop_order_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_payments_select" ON inventory.droptop_order_payments;
CREATE POLICY "droptop_order_payments_select" ON inventory.droptop_order_payments FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.droptop_order_taxes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_taxes_select" ON inventory.droptop_order_taxes;
CREATE POLICY "droptop_order_taxes_select" ON inventory.droptop_order_taxes FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.droptop_order_declined_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_declined_items_select" ON inventory.droptop_order_declined_items;
CREATE POLICY "droptop_order_declined_items_select" ON inventory.droptop_order_declined_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- All five written by the service-role Edge Function only.
