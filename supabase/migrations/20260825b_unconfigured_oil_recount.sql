-- Recount logic additions: "oil on hand but not configured to order" check,
-- its per-shop/product exception list, and a master toggle to ignore the
-- dollar/count-based rules entirely (Adjustment Count, Oil Adjustment Count,
-- Ending Balance, Variance vs Median, Variance vs Last Month) in favor of
-- only the product-evidenced checks (tank variance, product-range, this new
-- oil check). Safe to re-run.

-- ===========================================================================
-- 1. Per-shop/product exceptions — oil intentionally kept on hand without
--    being in that shop's order config (e.g. phased-out product, a one-off
--    customer need). Excluded from the new check below.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.oil_on_hand_exceptions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  product_id         text        NOT NULL,
  note               text,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_oil_oh_exc_company
  ON inventory.oil_on_hand_exceptions (company_id, location_id);

ALTER TABLE inventory.oil_on_hand_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "oil_oh_exc_select" ON inventory.oil_on_hand_exceptions;
CREATE POLICY "oil_oh_exc_select" ON inventory.oil_on_hand_exceptions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "oil_oh_exc_insert" ON inventory.oil_on_hand_exceptions;
CREATE POLICY "oil_oh_exc_insert" ON inventory.oil_on_hand_exceptions FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "oil_oh_exc_update" ON inventory.oil_on_hand_exceptions;
CREATE POLICY "oil_oh_exc_update" ON inventory.oil_on_hand_exceptions FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "oil_oh_exc_delete" ON inventory.oil_on_hand_exceptions;
CREATE POLICY "oil_oh_exc_delete" ON inventory.oil_on_hand_exceptions FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ===========================================================================
-- 2. Master toggle — when true, RecountLogicTab skips Adjustment Count / Oil
--    Adjustment Count / Ending Balance / Variance vs Median / Variance vs
--    Last Month entirely, regardless of each rule's own enabled state and
--    thresholds (kept, not cleared, so turning this back off restores them).
-- ===========================================================================
ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS ignore_ending_balance boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oil_check_enabled     boolean NOT NULL DEFAULT false;

-- ===========================================================================
-- 3. RPC — engine-oil products with on-hand this period that have no
--    location_order_config row for that (location, product), excluding
--    listed exceptions. Same "latest snapshot, never sum" convention as
--    get_product_expectation_exceptions / fetchTankVarianceCandidates —
--    count_products can carry multiple daily upload rows per period.
-- ===========================================================================
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
  )
  SELECT l.location_id, l.product_id, l.category, l.on_hand
  FROM latest_oh l
  JOIN inventory.category_expectations ce
    ON ce.company_id = p_company_id
    AND lower(ce.category) = lower(l.category)
    AND ce.is_engine_oil = true
  WHERE l.on_hand > 0
    AND NOT EXISTS (
      SELECT 1 FROM inventory.location_order_config loc
      WHERE loc.company_id = p_company_id
        AND loc.location_id = l.location_id
        AND loc.product_id = l.product_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM inventory.oil_on_hand_exceptions ex
      WHERE ex.company_id = p_company_id
        AND ex.location_id = l.location_id
        AND lower(ex.product_id) = lower(l.product_id)
    )
  ORDER BY l.location_id, l.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_unconfigured_oil_on_hand(uuid, text) TO authenticated;
