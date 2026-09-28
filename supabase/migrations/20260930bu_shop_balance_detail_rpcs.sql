-- Backs Month End Overview's new per-shop balance detail modal (2026-09-28
-- ask): a "Shop Balances" table (one row per shop, current-period Total/
-- Oil/Parts/Additives/Other) whose row click opens a modal lazy-loading (a)
-- 12 months of history for that one shop and (b) that shop's individual
-- on-hand products for the period. Both new functions mirror
-- get_current_balance_by_category's own dedup-then-aggregate shape
-- (20260930bj_count_products_latest_dedup.sql) — inventory.count_products
-- is NOT deduplicated at the row level (a delete-then-insert sync whose
-- delete silently failed once left duplicate rows for the same
-- (location_id, product_id), inflating sums — see that migration's own
-- header comment for the full incident), so any new read of this table
-- must dedupe to the latest row per (location_id, product_id) — and here,
-- per (count_month, location_id, product_id), since history spans several
-- months at once — BEFORE aggregating, not just company-wide-per-month.

-- One row per month in [p_start_month, p_end_month] for a single shop —
-- same category buckets as get_current_balance_by_category, just scoped to
-- one location_id and grouped by count_month instead of location_id.
CREATE OR REPLACE FUNCTION public.get_shop_category_balance_history(
  p_company_id uuid, p_location_id uuid, p_start_month date, p_end_month date
)
RETURNS TABLE (count_month date, oil numeric, parts numeric, additives numeric, other numeric, total numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (cp.count_month, cp.product_id)
      cp.count_month, cp.product_id, cp.category, cp.ending_value
    FROM inventory.count_products cp
    WHERE cp.company_id = p_company_id AND cp.location_id = p_location_id
      AND cp.count_month BETWEEN p_start_month AND p_end_month
      AND cp.ending_value IS NOT NULL
    ORDER BY cp.count_month, cp.product_id, cp.created_at DESC
  )
  SELECT
    l.count_month,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Oil') AS oil,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Parts') AS parts,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Additives') AS additives,
    sum(l.ending_value) FILTER (
      WHERE cs.simple_category IS NULL OR cs.simple_category NOT IN ('Oil', 'Parts', 'Additives')
    ) AS other,
    sum(l.ending_value) AS total
  FROM latest l
  LEFT JOIN inventory.category_simplification cs
    ON cs.company_id = p_company_id AND cs.category = l.category
  GROUP BY l.count_month
  ORDER BY l.count_month
$$;

GRANT EXECUTE ON FUNCTION public.get_shop_category_balance_history(uuid, uuid, date, date) TO authenticated;

-- One row per product for a single shop/month — the "what's actually
-- contributing to this total" drill-down. Deliberately a fresh, narrowly-
-- scoped function rather than reusing get_aggregated_monthly_products
-- (which already has this same dedup applied, but is company-wide per
-- month — confirmed live this account's current month alone has ~305k raw
-- count_products rows, far too many to fetch and filter client-side just
-- to look at one shop).
CREATE OR REPLACE FUNCTION public.get_shop_product_detail(
  p_company_id uuid, p_location_id uuid, p_count_month date
)
RETURNS TABLE (product_id text, category text, on_hand numeric, ending_value numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (cp.product_id)
    cp.product_id, cp.category, COALESCE(cp.on_hand, 0) AS on_hand, COALESCE(cp.ending_value, 0) AS ending_value
  FROM inventory.count_products cp
  WHERE cp.company_id = p_company_id AND cp.location_id = p_location_id AND cp.count_month = p_count_month
  ORDER BY cp.product_id, cp.created_at DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_shop_product_detail(uuid, uuid, date) TO authenticated;
