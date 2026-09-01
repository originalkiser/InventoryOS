-- 1) Grant powerbi_reader access to the Droptop Orders tables added since
--    the role was created (20260901c_powerbi_reader_role.sql only covered
--    droptop_customers/zip_centroids/core.locations, which predate these).
--    Table-level GRANT alone isn't enough — RLS is still enabled on all of
--    these with only a company_id-via-auth.uid() policy, which resolves to
--    nothing for a plain Postgres login with no Supabase auth session, so
--    an explicit SELECT-to-powerbi_reader policy is needed on each one too.
GRANT SELECT ON inventory.droptop_orders TO powerbi_reader;
GRANT SELECT ON inventory.droptop_order_packages TO powerbi_reader;
GRANT SELECT ON inventory.droptop_order_products TO powerbi_reader;

DROP POLICY IF EXISTS "droptop_orders_powerbi" ON inventory.droptop_orders;
CREATE POLICY "droptop_orders_powerbi" ON inventory.droptop_orders FOR SELECT TO powerbi_reader USING (true);
DROP POLICY IF EXISTS "droptop_order_packages_powerbi" ON inventory.droptop_order_packages;
CREATE POLICY "droptop_order_packages_powerbi" ON inventory.droptop_order_packages FOR SELECT TO powerbi_reader USING (true);
DROP POLICY IF EXISTS "droptop_order_products_powerbi" ON inventory.droptop_order_products;
CREATE POLICY "droptop_order_products_powerbi" ON inventory.droptop_order_products FOR SELECT TO powerbi_reader USING (true);

-- 2) inventory.droptop_order_services — captures get-orders' "services"
-- array, which is DIFFERENT from the top-level "products" array already
-- captured in droptop_order_products: services is where a product is
-- actually linked to the package it was used to perform (package_id +
-- its own nested products[], each carrying uom/quantity_total). The
-- top-level products array has no package linkage at all. This is the
-- only source for a stat like "average oil quarts per package" — needed
-- for the Droptop Orders explorer's summary section — so it has to be
-- captured too, even though it wasn't in the original packages/products
-- request.
--
-- The nested products[] is kept as jsonb rather than a further child
-- table — one more level of normalization for what's ultimately just
-- "a few numbers per service" isn't worth it; the app computes stats
-- (like oil quarts by package) by unpacking this jsonb client-side, and
-- Power BI can do the same with Postgres's jsonb operators if needed.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_services (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid        NOT NULL REFERENCES inventory.droptop_orders(id) ON DELETE CASCADE,
  company_id     uuid        NOT NULL,
  package_id     text,
  service_id     text,
  service_name   text,
  vin            text,
  license_plate  text,
  vehicle_name   text,
  products       jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{product_id, uom, quantity_total, ...}]
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_services_order ON inventory.droptop_order_services (order_id);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_order_services_package ON inventory.droptop_order_services (company_id, package_id);

ALTER TABLE inventory.droptop_order_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_services_select" ON inventory.droptop_order_services;
CREATE POLICY "droptop_order_services_select" ON inventory.droptop_order_services FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "droptop_order_services_powerbi" ON inventory.droptop_order_services;
CREATE POLICY "droptop_order_services_powerbi" ON inventory.droptop_order_services FOR SELECT TO powerbi_reader USING (true);
-- Written by the service-role Edge Function only.
