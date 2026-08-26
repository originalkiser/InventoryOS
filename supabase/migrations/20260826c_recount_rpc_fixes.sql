-- Two fixes for the recount pipeline's RPCs, both surfaced once
-- inventory.count_products grew large (Droptop's daily feed added
-- thousands of rows per pull):
--
-- 1. Both get_product_expectation_exceptions and get_unconfigured_oil_on_hand
--    run a DISTINCT ON (location_id, product_id) ... ORDER BY ... created_at
--    DESC per (company, month) to get the latest snapshot row. The only
--    existing index (company_id, count_month) filters but can't satisfy that
--    sort, so Postgres sorts the whole filtered set — fine at a few thousand
--    rows, a statement-timeout candidate at the scale this table is now at.
--    A composite index covering the full filter+sort lets both RPCs use an
--    index scan instead.
--
-- 2. get_unconfigured_oil_on_hand checked location_order_config using the
--    on-hand row's product_id as-is. When a shop's order config uses a
--    RENAMED product_id (recorded in inventory.product_id_mappings) but the
--    count data still carries the old one — e.g. R1540/R540, mapped to
--    ROT-T4-15W40D/ROT-T6-5W40 in Product Mapping — that lookup missed the
--    real config row and flagged the product as unconfigured even though a
--    human already configured it, just under the current name. Resolve
--    old -> new (case/whitespace-insensitive, matching the convention
--    already used client-side in LocationLookupPage.tsx) before checking.

CREATE INDEX IF NOT EXISTS idx_inv_count_products_latest_snapshot
  ON inventory.count_products (company_id, count_month, location_id, product_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_unconfigured_oil_on_hand(
  p_company_id  uuid,
  p_count_month text
)
RETURNS TABLE (
  location_id uuid,
  product_id  text,
  category    text,
  on_hand     numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH latest_oh AS (
    SELECT DISTINCT ON (cp.location_id, cp.product_id)
      cp.location_id, cp.product_id::text AS product_id,
      cp.category, COALESCE(cp.on_hand, 0)::numeric AS on_hand
    FROM inventory.count_products cp
    WHERE cp.company_id = p_company_id
      AND cp.count_month = p_count_month::date
      AND cp.location_id IS NOT NULL
    ORDER BY cp.location_id, cp.product_id, cp.created_at DESC
  ),
  resolved AS (
    -- The product_id a shop's order config would use for this on-hand row,
    -- if it's been renamed since the count was taken; otherwise unchanged.
    SELECT
      l.location_id,
      l.product_id AS raw_product_id,
      COALESCE(pim.new_product_id, l.product_id) AS configured_product_id,
      l.category, l.on_hand
    FROM latest_oh l
    LEFT JOIN inventory.product_id_mappings pim
      ON pim.company_id = p_company_id
      AND lower(trim(pim.old_product_id)) = lower(trim(l.product_id))
  )
  SELECT r.location_id, r.raw_product_id AS product_id, r.category, r.on_hand
  FROM resolved r
  JOIN inventory.category_expectations ce
    ON ce.company_id = p_company_id
    AND lower(ce.category) = lower(r.category)
    AND ce.is_engine_oil = true
  WHERE r.on_hand > 0
    AND NOT EXISTS (
      SELECT 1 FROM inventory.location_order_config loc
      WHERE loc.company_id = p_company_id
        AND loc.location_id = r.location_id
        AND lower(trim(loc.product_id)) = lower(trim(r.configured_product_id))
    )
    AND NOT EXISTS (
      SELECT 1 FROM inventory.oil_on_hand_exceptions ex
      WHERE ex.company_id = p_company_id
        AND ex.location_id = r.location_id
        AND lower(trim(ex.product_id)) = lower(trim(r.raw_product_id))
    )
  ORDER BY r.location_id, r.raw_product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_unconfigured_oil_on_hand(uuid, text) TO authenticated;
