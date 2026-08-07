-- Month End expectations engine — server-side analysis RPC.
-- Flags product rows whose on-hand exceeds the configured category limit.
-- Runs entirely in Postgres over count_products (600k+ rows) and returns ONLY
-- the flagged exceptions. Safe to re-run (CREATE OR REPLACE).
--
-- Rules applied:
--   • Non-oil categories: limit = CPD tier for the shop (<=30 → 0-30 col, >30 → 30+ col).
--   • Engine oil (is_engine_oil): limit by case type from the SKU suffix —
--       trailing digits → bulk; trailing 'D' → drum; 'BB'/'C'/'J' → package.
--   • Bulk oil exception: if bulk on-hand exceeds the bulk limit BUT the tank
--       monitor reading (converted gal→qt ×4) is within p_tank_variance of
--       on-hand, do NOT flag (verified real oil).
--   • Categories with no expectation row use p_unlisted_limit (NULL = unlimited).
--   • On-hand per (location, product) is the LATEST batch row for the month
--       (daily uploads are snapshots — take newest, never SUM).

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
      c.cpd
    FROM latest_oh oh
    LEFT JOIN inventory.category_expectations ce
      ON ce.company_id = p_company_id AND lower(ce.category) = lower(oh.category)
    LEFT JOIN cpd  c ON c.location_id = oh.location_id
    LEFT JOIN tank t ON t.location_id = oh.location_id AND lower(t.product_id) = lower(oh.product_id)
  ),
  limited AS (
    SELECT
      e.*,
      CASE
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
      WHEN l.is_engine_oil AND l.oil_case = 'bulk'
        THEN 'Bulk oil on-hand ' || l.on_hand || ' exceeds limit ' || l.eff_limit || ' and tank monitor does not corroborate'
      ELSE 'On-hand ' || l.on_hand || ' exceeds ' || l.eff_basis || ' limit ' || l.eff_limit
    END AS reason
  FROM limited l
  WHERE l.eff_limit IS NOT NULL
    AND l.on_hand > l.eff_limit
    -- Bulk oil exception: skip when the tank reading is within variance of on-hand.
    AND NOT (
      l.is_engine_oil AND l.oil_case = 'bulk'
      AND l.tank_reading_qts IS NOT NULL
      AND abs(l.tank_reading_qts - l.on_hand) <= p_tank_variance
    )
  ORDER BY l.location_id, l.category, l.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_product_expectation_exceptions(uuid, text, numeric, numeric) TO authenticated;
