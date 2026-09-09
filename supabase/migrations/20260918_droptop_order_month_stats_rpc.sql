-- Historical Backfill Plan (Config -> Data Connections) tracked progress as
-- a manually-typed "orders synced" number with no way to check it against
-- reality. This computes the REAL per-month order count and distinct-shop
-- count directly from inventory.droptop_orders in ONE grouped query, rather
-- than one request per tracked month (15 months today, one more added every
-- month going forward) — confirmed via EXPLAIN ANALYZE at ~4s for the full
-- 15-month range, comfortably inside the 'authenticated' role's 30s
-- statement_timeout (20260909_bump_authenticated_statement_timeout.sql).
-- SECURITY INVOKER, same reasoning as get_droptop_order_location_ids_in_range:
-- the caller's own RLS on droptop_orders applies, no company_id argument
-- needed or trusted.
CREATE OR REPLACE FUNCTION public.get_droptop_order_month_stats(
  p_start date,
  p_end date
)
RETURNS TABLE (year_month text, orders bigint, shops bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT to_char(date_trunc('month', o.order_finalized_at), 'YYYY-MM') AS year_month,
         count(*) AS orders,
         count(DISTINCT o.location_id) AS shops
  FROM inventory.droptop_orders o
  WHERE o.order_finalized_at >= p_start::timestamptz
    AND o.order_finalized_at < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_order_month_stats(date, date) TO authenticated;
