-- Per-product expected-on-hand overrides — take precedence over the category-level
-- limits in inventory.category_expectations. Needed for products whose on-hand unit
-- doesn't match their category's convention (e.g. HM0806 is counted in ounces but
-- lives in the "Additives" category, which is calibrated for other units), so a flat
-- per-product ceiling is used instead of the category's CPD/case-type limit.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS inventory.product_expectations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  product_id         text        NOT NULL,
  expected_limit     numeric,
  note               text,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_product_expect_company
  ON inventory.product_expectations (company_id);

ALTER TABLE inventory.product_expectations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_expect_select" ON inventory.product_expectations;
CREATE POLICY "product_expect_select" ON inventory.product_expectations FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_expect_insert" ON inventory.product_expectations;
CREATE POLICY "product_expect_insert" ON inventory.product_expectations FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_expect_update" ON inventory.product_expectations;
CREATE POLICY "product_expect_update" ON inventory.product_expectations FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "product_expect_delete" ON inventory.product_expectations;
CREATE POLICY "product_expect_delete" ON inventory.product_expectations FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── Re-point the analysis RPC to prefer a product-level override, when one
--    exists, over the category-derived limit. Everything else about the
--    function (CPD tiers, oil case types, tank-monitor bulk-oil corroboration,
--    unlisted-category default) is unchanged.
CREATE OR REPLACE FUNCTION public.get_product_expectation_exceptions(
  p_company_id     uuid,
  p_count_month    text,
  p_tank_variance  numeric DEFAULT 100,
  p_unlisted_limit numeric DEFAULT NULL
)
RETURNS TABLE (
  location_id       uuid,
  product_id        text,
  category          text,
  on_hand           numeric,
  expected_limit    numeric,
  tank_reading_qts  numeric,
  basis             text,
  reason            text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH latest_oh AS (
    -- Newest row per (location, product) for the period — snapshot, not sum.
    SELECT DISTINCT ON (cp.location_id, cp.product_id)
      cp.location_id, cp.product_id::text AS product_id,
      cp.category, COALESCE(cp.on_hand, 0)::numeric AS on_hand
    FROM inventory.count_products cp
    WHERE cp.company_id  = p_company_id
      AND cp.count_month = p_count_month::date
    ORDER BY cp.location_id, cp.product_id, cp.created_at DESC
  ),
  cpd AS (
    -- One CPD per location: prefer the exact month, else the null-month default.
    SELECT DISTINCT ON (lc.location_id) lc.location_id, lc.cpd
    FROM inventory.location_cpd lc
    WHERE lc.company_id = p_company_id
      AND (lc.effective_month = p_count_month::date OR lc.effective_month IS NULL)
    ORDER BY lc.location_id, (lc.effective_month IS NOT NULL) DESC, lc.effective_month DESC
  ),
  tank AS (
    -- Newest tank reading per (location, product), converted to quarts.
    SELECT DISTINCT ON (tm.location_id, tm.product_id)
      tm.location_id, tm.product_id::text AS product_id,
      CASE WHEN lower(COALESCE(tm.unit, 'gal')) LIKE 'gal%'
           THEN tm.value * 4 ELSE tm.value END::numeric AS reading_qts
    FROM inventory.tank_monitors tm
    WHERE tm.company_id = p_company_id
      AND tm.product_id IS NOT NULL
    ORDER BY tm.location_id, tm.product_id,
             COALESCE(tm.inventory_time, tm.reading_date::timestamptz) DESC
  ),
  evaluated AS (
    SELECT
      oh.location_id,
      oh.product_id,
      oh.category,
      oh.on_hand,
      t.reading_qts AS tank_reading_qts,
      -- Engine-oil case type from the trailing alpha suffix (NULL suffix = bulk).
      CASE
        WHEN ce.is_engine_oil THEN (
          CASE
            WHEN substring(upper(oh.product_id) FROM '[A-Z]+$') IS NULL THEN 'bulk'
            WHEN substring(upper(oh.product_id) FROM '[A-Z]+$') = 'D'   THEN 'drum'
            WHEN substring(upper(oh.product_id) FROM '[A-Z]+$') IN ('BB','C','J') THEN 'package'
            ELSE 'package'  -- unknown letter suffix defaults to package
          END)
        ELSE NULL
      END AS oil_case,
      ce.category IS NOT NULL AS has_expectation,
      ce.is_engine_oil,
      ce.oil_bulk_limit, ce.oil_package_limit, ce.oil_drum_limit,
      ce.cpd_0_30_limit, ce.cpd_30plus_limit,
      c.cpd,
      pe.expected_limit AS product_limit
    FROM latest_oh oh
    LEFT JOIN inventory.category_expectations ce
      ON ce.company_id = p_company_id AND lower(ce.category) = lower(oh.category)
    LEFT JOIN inventory.product_expectations pe
      ON pe.company_id = p_company_id AND lower(pe.product_id) = lower(oh.product_id)
    LEFT JOIN cpd  c ON c.location_id = oh.location_id
    LEFT JOIN tank t ON t.location_id = oh.location_id AND lower(t.product_id) = lower(oh.product_id)
  ),
  limited AS (
    SELECT
      e.*,
      CASE
        WHEN e.product_limit IS NOT NULL THEN e.product_limit
        WHEN NOT e.has_expectation THEN p_unlisted_limit
        WHEN e.is_engine_oil THEN
          CASE e.oil_case
            WHEN 'bulk'    THEN e.oil_bulk_limit
            WHEN 'drum'    THEN e.oil_drum_limit
            ELSE e.oil_package_limit
          END
        ELSE
          CASE WHEN COALESCE(e.cpd, 0) > 30 THEN e.cpd_30plus_limit ELSE e.cpd_0_30_limit END
      END AS eff_limit,
      CASE
        WHEN e.product_limit IS NOT NULL THEN 'product_override'
        WHEN NOT e.has_expectation THEN 'unlisted'
        WHEN e.is_engine_oil THEN e.oil_case
        WHEN COALESCE(e.cpd, 0) > 30 THEN '30+ CPD'
        ELSE '0-30 CPD'
      END AS eff_basis
    FROM evaluated e
  )
  SELECT
    l.location_id,
    l.product_id,
    l.category,
    l.on_hand,
    l.eff_limit AS expected_limit,
    l.tank_reading_qts,
    l.eff_basis AS basis,
    CASE
      WHEN l.eff_basis = 'product_override'
        THEN 'On-hand ' || l.on_hand || ' exceeds product-specific limit ' || l.eff_limit
      WHEN l.is_engine_oil AND l.oil_case = 'bulk'
        THEN 'Bulk oil on-hand ' || l.on_hand || ' exceeds limit ' || l.eff_limit || ' and tank monitor does not corroborate'
      ELSE 'On-hand ' || l.on_hand || ' exceeds ' || l.eff_basis || ' limit ' || l.eff_limit
    END AS reason
  FROM limited l
  WHERE l.eff_limit IS NOT NULL
    AND l.on_hand > l.eff_limit
    -- Bulk oil exception: skip when the tank reading is within variance of on-hand.
    -- Does not apply to an explicit product override — that's a deliberate
    -- per-product ceiling, not a case-type inference the tank can corroborate.
    AND NOT (
      l.eff_basis <> 'product_override'
      AND l.is_engine_oil AND l.oil_case = 'bulk'
      AND l.tank_reading_qts IS NOT NULL
      AND abs(l.tank_reading_qts - l.on_hand) <= p_tank_variance
    )
  ORDER BY l.location_id, l.category, l.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_product_expectation_exceptions(uuid, text, numeric, numeric) TO authenticated;
