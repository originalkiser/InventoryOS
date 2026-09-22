-- Live per-shop ending balance by category (Oil/Parts/Additives/Other),
-- for the CURRENT (still-open) count_month — previously only possible for
-- an already-closed month via Finance's manual monthly_ending_balances
-- entry. Now that droptop-sync-usage captures Droptop's own per-product
-- unit_cost and computes count_products.ending_value from it (migration
-- 20260930bd), this can be computed live for the running month too.
-- 'Other' is a deliberate catch-all: any raw category with no
-- category_simplification row at all, OR one explicitly marked null
-- ("excluded from rollups") — nothing with a real ending_value silently
-- disappears from the total.
CREATE OR REPLACE FUNCTION public.get_current_balance_by_category(p_company_id uuid, p_count_month date)
RETURNS TABLE (location_id uuid, oil numeric, parts numeric, additives numeric, other numeric, total numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT
    cp.location_id,
    sum(cp.ending_value) FILTER (WHERE cs.simple_category = 'Oil') AS oil,
    sum(cp.ending_value) FILTER (WHERE cs.simple_category = 'Parts') AS parts,
    sum(cp.ending_value) FILTER (WHERE cs.simple_category = 'Additives') AS additives,
    sum(cp.ending_value) FILTER (
      WHERE cs.simple_category IS NULL OR cs.simple_category NOT IN ('Oil', 'Parts', 'Additives')
    ) AS other,
    sum(cp.ending_value) AS total
  FROM inventory.count_products cp
  LEFT JOIN inventory.category_simplification cs
    ON cs.company_id = cp.company_id AND cs.category = cp.category
  WHERE cp.company_id = p_company_id AND cp.count_month = p_count_month
    AND cp.location_id IS NOT NULL AND cp.ending_value IS NOT NULL
  GROUP BY cp.location_id
$$;
