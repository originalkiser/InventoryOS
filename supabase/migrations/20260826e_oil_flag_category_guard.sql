-- Two changes in one file:
--
-- 1. Defensive fix: get_unconfigured_oil_on_hand joined on
--    lower(ce.category) = lower(l.category), which — if any
--    category_expectations row has a blank category incorrectly marked
--    is_engine_oil = true — matches every count_products row with a blank
--    category too, regardless of what the product actually is (this is how
--    clearly-non-oil products like A3590/M159/M4612 were showing up under
--    "Oil on hand, not configured to order" for shop 12). A blank category
--    should never be treated as engine oil, so require a real, non-blank
--    category on both sides before that join can match at all.
--
-- 2. Generalizes inventory.oil_on_hand_exceptions into
--    product_on_hand_exceptions: any product (not just oil), and
--    location_id is now nullable — a null location_id means the exception
--    applies to every shop. Unscoped from any count_month already (kept
--    that way), so an exception here already applies to future periods
--    automatically, no separate "remember" step needed.

ALTER TABLE inventory.oil_on_hand_exceptions RENAME TO product_on_hand_exceptions;
ALTER TABLE inventory.product_on_hand_exceptions ALTER COLUMN location_id DROP NOT NULL;

DROP POLICY IF EXISTS "oil_oh_exc_select" ON inventory.product_on_hand_exceptions;
DROP POLICY IF EXISTS "oil_oh_exc_insert" ON inventory.product_on_hand_exceptions;
DROP POLICY IF EXISTS "oil_oh_exc_update" ON inventory.product_on_hand_exceptions;
DROP POLICY IF EXISTS "oil_oh_exc_delete" ON inventory.product_on_hand_exceptions;
DROP POLICY IF EXISTS "product_oh_exc_select" ON inventory.product_on_hand_exceptions;
CREATE POLICY "product_oh_exc_select" ON inventory.product_on_hand_exceptions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_oh_exc_insert" ON inventory.product_on_hand_exceptions;
CREATE POLICY "product_oh_exc_insert" ON inventory.product_on_hand_exceptions FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_oh_exc_update" ON inventory.product_on_hand_exceptions;
CREATE POLICY "product_oh_exc_update" ON inventory.product_on_hand_exceptions FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_oh_exc_delete" ON inventory.product_on_hand_exceptions;
CREATE POLICY "product_oh_exc_delete" ON inventory.product_on_hand_exceptions FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

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
    SELECT
      l.location_id,
      l.product_id AS raw_product_id,
      COALESCE(pim.new_product_id, l.product_id) AS configured_product_id,
      l.category, l.on_hand
    FROM latest_oh l
    LEFT JOIN inventory.product_id_mappings pim
      ON pim.company_id = p_company_id
      AND lower(trim(pim.old_product_id)) = lower(trim(l.product_id))
    WHERE l.category IS NOT NULL AND trim(l.category) <> ''
  )
  SELECT r.location_id, r.raw_product_id AS product_id, r.category, r.on_hand
  FROM resolved r
  JOIN inventory.category_expectations ce
    ON ce.company_id = p_company_id
    AND ce.category IS NOT NULL AND trim(ce.category) <> ''
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
      SELECT 1 FROM inventory.product_on_hand_exceptions ex
      WHERE ex.company_id = p_company_id
        AND (ex.location_id IS NULL OR ex.location_id = r.location_id)
        AND lower(trim(ex.product_id)) = lower(trim(r.raw_product_id))
    )
  ORDER BY r.location_id, r.raw_product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_unconfigured_oil_on_hand(uuid, text) TO authenticated;
