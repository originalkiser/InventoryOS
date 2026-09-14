-- Product Sales History page — every distinct product_id ever logged in
-- inventory.daily_product_activity (the real day-by-day sales/usage
-- ledger — NOT product_usage, which only stores a rolling rate with no
-- per-day history, see that table's own migration comment), with total
-- units sold, backing the page's multi-select product picker so an admin
-- can judge a cryptic SKU's real volume before picking it (same precedent
-- as get_droptop_package_name_counts for Package Mapping).
--
-- Order-level product line items (inventory.droptop_order_products) are
-- deliberately NOT unioned in here — confirmed empty (0 rows) in
-- production despite the table/columns existing; Droptop never actually
-- populates per-order product detail for this account, only packages
-- (inventory.droptop_order_packages, a different thing — named service
-- packages like "Tire Rotation", already covered by M5%/Package Mapping,
-- not retail/inventory products). The Product Sales History page's own
-- data-loading code still checks droptop_order_products defensively (per
-- the original ask: "using order data, if we have it") so this
-- automatically starts contributing real numbers if Droptop ever begins
-- populating that table, with no code change needed here.
CREATE OR REPLACE FUNCTION public.get_droptop_usage_product_counts()
RETURNS TABLE (product_id text, total_sold numeric, row_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT a.product_id, sum(a.sold_qty) AS total_sold, count(*) AS row_count
  FROM inventory.daily_product_activity a
  WHERE a.product_id IS NOT NULL
  GROUP BY a.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_usage_product_counts() TO authenticated;
