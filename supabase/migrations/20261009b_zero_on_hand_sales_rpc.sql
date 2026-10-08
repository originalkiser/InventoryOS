-- Selling at zero on hand — the join done in the database. The ledger holds ~245k sale/adjustment rows a month; the exceptions job only needs the
-- sales of products whose on hand is zero (or below) right now, for products that have sold in the last few days. Returns a jsonb array:
-- [{location_id, product_id, activity_date, sold_qty, on_hands}], one entry per day of sales in the window.
-- p_categories limits it to the product categories that matter (Engine Oil + Engine Oil Additive by default in the job) — across ALL categories
-- 2.7k shop/products sell at zero on hand in a 3-day window (filters, wipers, stickers...), 767 within oil.
DROP FUNCTION IF EXISTS public.get_zero_on_hand_sales(date, date);
CREATE OR REPLACE FUNCTION public.get_zero_on_hand_sales(p_from date, p_recent_from date, p_categories text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET statement_timeout = '60s'
AS $$
  WITH recent AS (
    SELECT DISTINCT a.location_id, lower(a.product_id) AS pid
    FROM inventory.daily_product_activity a
    WHERE a.activity_date >= p_recent_from AND a.sold_qty > 0 AND (p_categories IS NULL OR a.category = ANY(p_categories))
  ),
  zero AS (
    SELECT r.location_id, r.pid, min(u.on_hands) AS on_hands
    FROM recent r
    JOIN inventory.product_usage u ON u.location_id = r.location_id AND lower(u.product_id) = r.pid
    WHERE u.on_hands IS NOT NULL AND u.on_hands <= 0
    GROUP BY r.location_id, r.pid
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'location_id', a.location_id, 'product_id', a.product_id, 'activity_date', a.activity_date,
    'sold_qty', a.sold_qty, 'on_hands', z.on_hands)), '[]'::jsonb)
  FROM inventory.daily_product_activity a
  JOIN zero z ON z.location_id = a.location_id AND z.pid = lower(a.product_id)
  WHERE a.activity_date >= p_from AND a.sold_qty > 0 AND (p_categories IS NULL OR a.category = ANY(p_categories))
$$;
GRANT EXECUTE ON FUNCTION public.get_zero_on_hand_sales(date, date, text[]) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
