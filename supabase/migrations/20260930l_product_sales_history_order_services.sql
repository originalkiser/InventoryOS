-- CORRECTION to 20260930k: Product Sales History's "order data" path was
-- built against inventory.droptop_order_products, confirmed (correctly)
-- empty — but that's the wrong table. Real per-order product sales live in
-- inventory.droptop_order_services' own nested `products` jsonb array
-- (confirmed 1,678,315 of 1,684,826 service rows have real product data),
-- which Droptop Orders' own "Products" column and product-id filter
-- already read for exactly this reason (see that file's own header
-- comment: "most consumed products (oil, filters, etc.) only ever show up
-- inside services, not the flat top-level array" — droptop_order_products
-- staying empty was already a known, deliberate non-issue there, this page
-- just hadn't caught up to it yet). Confirmed real product_id overlap with
-- the usage ledger too (1,527 of ~1,618-1,730 distinct ids on each side),
-- so both sources genuinely combine into one coherent per-product picture
-- rather than being two disconnected id spaces.
--
-- Aggregated server-side (GROUP BY shop/product/day) rather than returned
-- as raw per-service rows — a single order can carry several service rows
-- referencing the same product (e.g. the same oil used across more than
-- one package on one visit), and the client only needs one number per
-- (shop, product, day) to re-bucket into day/week/month anyway.
CREATE OR REPLACE FUNCTION public.get_droptop_order_product_sales(
  p_start date,
  p_end date,
  p_product_ids text[]
)
RETURNS TABLE (location_id uuid, product_id text, activity_date date, qty numeric)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT o.location_id,
         (p->>'product_id') AS product_id,
         o.order_finalized_at::date AS activity_date,
         sum(coalesce((p->>'quantity_total')::numeric, 0)) AS qty
  FROM inventory.droptop_orders o
  JOIN inventory.droptop_order_services s ON s.order_id = o.id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.products, '[]'::jsonb)) AS p
  WHERE o.location_id IS NOT NULL
    AND o.order_finalized_at >= p_start::timestamptz
    AND o.order_finalized_at < (p_end::date + 1)::timestamptz
    AND (p->>'product_id') = ANY(p_product_ids)
  GROUP BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_order_product_sales(date, date, text[]) TO authenticated;

-- The product picker needs to offer products that only ever show up in
-- ORDER data too, not just the usage ledger — replaces
-- get_droptop_usage_product_counts (20260930k) with a version that unions
-- both real sources. No date bound here (this is a one-time "what products
-- have ever been seen at all" picker load, same precedent as
-- get_droptop_package_name_counts for Package Mapping) — scans the full
-- droptop_order_services table, which is real work (1.68M rows) but a
-- one-off per page load, not per keystroke/filter-change.
DROP FUNCTION IF EXISTS public.get_droptop_usage_product_counts();
CREATE OR REPLACE FUNCTION public.get_product_sales_history_product_counts()
RETURNS TABLE (product_id text, total_sold numeric, row_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT product_id, sum(qty) AS total_sold, count(*) AS row_count
  FROM (
    SELECT a.product_id, a.sold_qty AS qty
    FROM inventory.daily_product_activity a
    WHERE a.product_id IS NOT NULL
    UNION ALL
    SELECT (p->>'product_id') AS product_id, coalesce((p->>'quantity_total')::numeric, 0) AS qty
    FROM inventory.droptop_order_services s
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.products, '[]'::jsonb)) AS p
    WHERE (p->>'product_id') IS NOT NULL
  ) combined
  GROUP BY product_id
$$;
GRANT EXECUTE ON FUNCTION public.get_product_sales_history_product_counts() TO authenticated;
