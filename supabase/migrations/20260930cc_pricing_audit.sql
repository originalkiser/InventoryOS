-- Pricing Audit section (direct ask 2026-10-02) — new sidebar page under
-- Droptop with 5 tabs: Package Pricing Audit (relocated from Package
-- Mapping), Product Pricing Audit (new), Custom Product Pricing (new),
-- Custom Packages (new — replaces Custom Shop Config's JOB going forward,
-- per explicit instruction NOT its data: Custom Shop Config's own tables/
-- page are left untouched), Summary (new).
--
-- custom_product_pricing: a row's mere existence means "this shop's
-- retail/cost pricing for this product is known-custom, exclude it from
-- the Product Pricing Audit going forward" — same "presence = override"
-- convention as every other exception/override table in this app (e.g.
-- menu_board_quart_overrides).
CREATE TABLE IF NOT EXISTS inventory.custom_product_pricing (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  product_id  text NOT NULL,
  notes       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_product_pricing_location ON inventory.custom_product_pricing (company_id, location_id);

-- custom_packages / custom_package_casual_items: the actual per-shop
-- package arrangement (price, included quarts, price/quart, fees), one row
-- per package per shop — deliberately bundled per package (unlike Custom
-- Shop Config's per-FIELD shape), since the real-world need is "this shop
-- has this whole package configured differently," not one field at a time.
-- package_name is plain text (not a hard FK), matching this app's existing
-- no-cross-schema-FK convention for package tags (see Menu Board/Package
-- Mapping's own package_key columns) — sourced from
-- useCustomShopConfigPackageOptions()'s existing union list in the UI, with
-- free-text create for a genuinely new name.
CREATE TABLE IF NOT EXISTS inventory.custom_packages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL,
  location_id             uuid NOT NULL,
  package_name            text NOT NULL,
  internal_package_name   text,
  price                   numeric,
  included_quarts         numeric,
  price_per_quart         numeric,
  supply_fee              numeric,
  oil_inflation_surcharge numeric,
  sort_order              integer NOT NULL DEFAULT 0,
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_packages_location ON inventory.custom_packages (company_id, location_id);

CREATE TABLE IF NOT EXISTS inventory.custom_package_casual_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  custom_package_id uuid NOT NULL REFERENCES inventory.custom_packages(id) ON DELETE CASCADE,
  item_name        text NOT NULL,
  price            numeric,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_package_casual_items_pkg ON inventory.custom_package_casual_items (custom_package_id);

ALTER TABLE inventory.custom_product_pricing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_product_pricing_select" ON inventory.custom_product_pricing;
CREATE POLICY "custom_product_pricing_select" ON inventory.custom_product_pricing FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_product_pricing_manage" ON inventory.custom_product_pricing;
CREATE POLICY "custom_product_pricing_manage" ON inventory.custom_product_pricing FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.custom_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_packages_select" ON inventory.custom_packages;
CREATE POLICY "custom_packages_select" ON inventory.custom_packages FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_packages_manage" ON inventory.custom_packages;
CREATE POLICY "custom_packages_manage" ON inventory.custom_packages FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.custom_package_casual_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "custom_package_casual_items_select" ON inventory.custom_package_casual_items;
CREATE POLICY "custom_package_casual_items_select" ON inventory.custom_package_casual_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_package_casual_items_manage" ON inventory.custom_package_casual_items;
CREATE POLICY "custom_package_casual_items_manage" ON inventory.custom_package_casual_items FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Per-product unit_cost/unit_retail consistency across a caller-supplied
-- set of shops (the client resolves "active + Corporate" via ownerBucket()
-- the same way every other page in this app does — see
-- useInventoryAlerts.ts/useOrdersV2.ts — rather than duplicating that rule
-- in SQL). Same modal-value pattern as get_droptop_package_price_audit
-- (migration 20260930ae): the "expected" value for a product is whichever
-- unit_cost/unit_retail shows up most often across the given shops (ties
-- broken low-to-high), and a row is returned only when a shop's OWN value
-- differs from that. Two independent mismatch flags since cost and retail
-- are audited for different reasons (cost is rarely legitimately custom
-- per shop; retail often is, pending a custom_product_pricing override).
CREATE OR REPLACE FUNCTION public.get_product_pricing_audit(p_location_ids uuid[])
RETURNS TABLE (
  location_id     uuid,
  product_id      text,
  category        text,
  unit_cost       numeric,
  unit_retail     numeric,
  expected_cost   numeric,
  expected_retail numeric,
  cost_mismatch   boolean,
  retail_mismatch boolean
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT pu.location_id, pu.product_id, pu.category, pu.unit_cost, pu.unit_retail
    FROM inventory.product_usage pu
    WHERE pu.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
      AND pu.location_id = ANY(p_location_ids)
      AND (pu.unit_cost IS NOT NULL OR pu.unit_retail IS NOT NULL)
  ),
  cost_counts AS (
    SELECT product_id, unit_cost, count(*) AS cnt FROM scoped WHERE unit_cost IS NOT NULL GROUP BY product_id, unit_cost
  ),
  cost_mode AS (
    SELECT product_id, (array_agg(unit_cost ORDER BY cnt DESC, unit_cost ASC))[1] AS expected_cost
    FROM cost_counts GROUP BY product_id
  ),
  retail_counts AS (
    SELECT product_id, unit_retail, count(*) AS cnt FROM scoped WHERE unit_retail IS NOT NULL GROUP BY product_id, unit_retail
  ),
  retail_mode AS (
    SELECT product_id, (array_agg(unit_retail ORDER BY cnt DESC, unit_retail ASC))[1] AS expected_retail
    FROM retail_counts GROUP BY product_id
  )
  SELECT
    s.location_id, s.product_id, s.category, s.unit_cost, s.unit_retail,
    cm.expected_cost, rm.expected_retail,
    (cm.expected_cost IS NOT NULL AND s.unit_cost IS NOT NULL AND s.unit_cost <> cm.expected_cost) AS cost_mismatch,
    (rm.expected_retail IS NOT NULL AND s.unit_retail IS NOT NULL AND s.unit_retail <> rm.expected_retail) AS retail_mismatch
  FROM scoped s
  LEFT JOIN cost_mode cm ON cm.product_id = s.product_id
  LEFT JOIN retail_mode rm ON rm.product_id = s.product_id
  WHERE (cm.expected_cost IS NOT NULL AND s.unit_cost IS NOT NULL AND s.unit_cost <> cm.expected_cost)
     OR (rm.expected_retail IS NOT NULL AND s.unit_retail IS NOT NULL AND s.unit_retail <> rm.expected_retail);
$function$;

GRANT EXECUTE ON FUNCTION public.get_product_pricing_audit(uuid[]) TO authenticated;
