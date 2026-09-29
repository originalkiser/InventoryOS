-- Adds simple_category to get_shop_product_detail (2026-09-28 ask — the
-- KPI-card-click-through drill-down on Month End Overview needs to filter a
-- shop's product list down to just the one category the user clicked, and
-- get_shop_product_detail only ever returned the raw product `category`
-- (e.g. "Engine Oil"), not the Oil/Parts/Additives/Other bucket it maps to
-- — the same category_simplification join get_current_balance_by_category
-- already uses to build those buckets. DROP + CREATE (not OR REPLACE)
-- since a RETURNS TABLE column list can't be changed in place.
DROP FUNCTION IF EXISTS public.get_shop_product_detail(uuid, uuid, date);

CREATE FUNCTION public.get_shop_product_detail(
  p_company_id uuid, p_location_id uuid, p_count_month date
)
RETURNS TABLE (product_id text, category text, simple_category text, on_hand numeric, ending_value numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (cp.product_id)
    cp.product_id, cp.category,
    COALESCE(cs.simple_category, 'Other') AS simple_category,
    COALESCE(cp.on_hand, 0) AS on_hand, COALESCE(cp.ending_value, 0) AS ending_value
  FROM inventory.count_products cp
  LEFT JOIN inventory.category_simplification cs
    ON cs.company_id = p_company_id AND cs.category = cp.category
  WHERE cp.company_id = p_company_id AND cp.location_id = p_location_id AND cp.count_month = p_count_month
  ORDER BY cp.product_id, cp.created_at DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_shop_product_detail(uuid, uuid, date) TO authenticated;
