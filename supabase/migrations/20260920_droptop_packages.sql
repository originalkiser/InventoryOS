-- Droptop package menu — the *configured* packages per shop (from
-- get-packages, which is per-operation), with the per-shop price and the
-- casual_items (shop supply fee, credit-card fee, discount, oil inflation
-- surcharge, …) that ride along with each. Distinct from the order-line-
-- item data droptop-sync-orders captures: this is "what a shop's menu is
-- set to," not "what it sold." Written only by the droptop-sync-packages
-- edge function.

CREATE TABLE IF NOT EXISTS inventory.droptop_packages (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  -- Resolved from core.locations.droptop_operation_id at sync time; null if
  -- an operation isn't mapped to a location row.
  location_id               uuid,
  operation_id              text        NOT NULL,
  package_id                text        NOT NULL,
  name                      text,
  internal_name             text,
  description               text,
  price                     numeric,
  package_tax_exempt        boolean,
  package_mileage_interval  integer,
  package_time_interval     integer,
  -- services[] kept nested — each carries a pricing_configs[] whose own
  -- `config` is sometimes a string, sometimes an object; normalizing it
  -- buys little and the casual_items child table below is where the
  -- queryable pricing detail actually lives.
  services                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_timestamp         bigint,
  updated_timestamp         bigint,
  raw_data                  jsonb,
  last_synced_at            timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, operation_id, package_id)
);

CREATE INDEX IF NOT EXISTS idx_inv_droptop_packages_company_name ON inventory.droptop_packages (company_id, name);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_packages_location ON inventory.droptop_packages (company_id, location_id);

-- The line items attached to a package that aren't a service or a product
-- — fees, surcharges, discounts. amount is signed (a discount is negative).
CREATE TABLE IF NOT EXISTS inventory.droptop_package_casual_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  package_row_id   uuid        NOT NULL REFERENCES inventory.droptop_packages(id) ON DELETE CASCADE,
  company_id       uuid        NOT NULL,
  location_id      uuid,
  name             text,
  name_french      text,
  amount           numeric,
  quantity         numeric,
  tax_exempt       boolean,
  hidden_on_order  boolean,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_pkg_casual_pkg ON inventory.droptop_package_casual_items (package_row_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_pkg_casual_company_name ON inventory.droptop_package_casual_items (company_id, name);

ALTER TABLE inventory.droptop_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.droptop_package_casual_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "droptop_packages_select" ON inventory.droptop_packages;
CREATE POLICY "droptop_packages_select" ON inventory.droptop_packages FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "droptop_package_casual_items_select" ON inventory.droptop_package_casual_items;
CREATE POLICY "droptop_package_casual_items_select" ON inventory.droptop_package_casual_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Writes are service-role only (the edge function) — no client-side manage
-- policy, matching inventory.droptop_purchase_orders / droptop_orders.
