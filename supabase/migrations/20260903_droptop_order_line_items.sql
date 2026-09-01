-- Droptop Orders: package/product line-item detail, plus order-level
-- financial adjustments and a raw_data safety net. Packages and products
-- are the two richest arrays get-orders returns (they carry
-- financial_category, the thing revenue-by-category reporting needs), so
-- they get their own child tables — same "header + item tables" shape as
-- inventory.droptop_purchase_orders/_items. casual_items/coupons/discounts
-- are simpler order-level adjustments, kept as jsonb columns on the header
-- rather than three more tables.

ALTER TABLE inventory.droptop_orders
  ADD COLUMN IF NOT EXISTS subtotal      numeric,
  ADD COLUMN IF NOT EXISTS casual_items  jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS coupons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS discounts     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Full order payload as Droptop returned it — everything above is
  -- extracted from this for querying; kept in full too so a field nobody
  -- thought to pull out yet isn't lost.
  ADD COLUMN IF NOT EXISTS raw_data      jsonb;

CREATE TABLE IF NOT EXISTS inventory.droptop_order_packages (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id                uuid        NOT NULL,
  package_id                text,
  name                      text,
  description               text,
  internal_name             text,
  base_service_price        numeric,
  price                     numeric,
  price_total               numeric,
  price_total_after_discount numeric,
  vin                       text,
  license_plate             text,
  vehicle_name              text,
  financial_category_id     text,
  financial_category_name   text,
  financial_category_code   text,
  coupons                   jsonb       NOT NULL DEFAULT '[]'::jsonb, -- package-level coupons array, kept nested (not worth its own table)
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_packages_order ON inventory.droptop_order_packages (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_packages_fincat ON inventory.droptop_order_packages (company_id, financial_category_code);

CREATE TABLE IF NOT EXISTS inventory.droptop_order_products (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id               uuid        NOT NULL,
  inventory_id             text,
  product_id               text,
  sequence_id              text,
  product_type             text,
  product_type_pcdb_id     text,
  brand_name               text,
  uom                      text,
  restocked                boolean,
  quantity_total           numeric,
  price_total              numeric,
  cost_total               numeric,
  quantity_on_hand         numeric,
  financial_category_id    text,
  financial_category_name  text,
  financial_category_code  text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_products_order ON inventory.droptop_order_products (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_products_product ON inventory.droptop_order_products (company_id, product_id);

ALTER TABLE inventory.droptop_order_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_packages_select" ON inventory.droptop_order_packages;
CREATE POLICY "droptop_order_packages_select" ON inventory.droptop_order_packages FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.droptop_order_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_products_select" ON inventory.droptop_order_products;
CREATE POLICY "droptop_order_products_select" ON inventory.droptop_order_products FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Both written by the service-role Edge Function only.
