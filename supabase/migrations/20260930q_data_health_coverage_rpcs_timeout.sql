-- Found live 2026-09-15 testing the new backfill dispatcher: a coverage
-- check against the CURRENT month (still actively growing, the busiest and
-- most complete month there is) hit "canceling statement due to statement
-- timeout" calling get_droptop_orders_daily_coverage via PostgREST as
-- service_role — array_agg(DISTINCT location_id) per day, summed across a
-- month's worth of days for a ~200k-orders/month table, is heavier than the
-- Data Health page's own typical call pattern (a call from that page has
-- always been for real, but apparently never for a month this saturated)
-- managed to exceed whatever statement_timeout Supabase has configured for
-- the calling role. Raised via a function-level SET rather than touching
-- any role/project-wide setting — scoped to exactly these 4 functions, no
-- other query anywhere is affected. DROP+CREATE (not just ALTER FUNCTION
-- SET) since re-declaring the SET clause list requires the full signature
-- anyway and this matches how 20260930i already handles these functions.
DROP FUNCTION IF EXISTS public.get_droptop_orders_daily_coverage(date, date);
DROP FUNCTION IF EXISTS public.get_droptop_time_clock_daily_coverage(date, date);
DROP FUNCTION IF EXISTS public.get_droptop_usage_daily_coverage(date, date);
DROP FUNCTION IF EXISTS public.get_droptop_po_daily_coverage(date, date);

CREATE OR REPLACE FUNCTION public.get_droptop_orders_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[], total_rows bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '30s'
STABLE
AS $$
  SELECT o.order_finalized_at::date AS day,
         array_agg(DISTINCT o.location_id) AS location_ids,
         count(*) AS total_rows
  FROM inventory.droptop_orders o
  WHERE o.status = 'Finalized'
    AND o.order_finalized_at >= p_start::timestamptz
    AND o.order_finalized_at < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;

CREATE OR REPLACE FUNCTION public.get_droptop_time_clock_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[], total_rows bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '30s'
STABLE
AS $$
  SELECT t.clock_in::date AS day,
         array_agg(DISTINCT t.location_id) AS location_ids,
         count(*) AS total_rows
  FROM inventory.droptop_time_records t
  WHERE t.clock_in >= p_start::timestamptz
    AND t.clock_in < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;

CREATE OR REPLACE FUNCTION public.get_droptop_usage_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[], total_rows bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '30s'
STABLE
AS $$
  SELECT a.activity_date AS day,
         array_agg(DISTINCT a.location_id) AS location_ids,
         count(*) AS total_rows
  FROM inventory.daily_product_activity a
  WHERE a.activity_date >= p_start AND a.activity_date <= p_end
  GROUP BY 1
$$;

CREATE OR REPLACE FUNCTION public.get_droptop_po_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[], total_rows bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '30s'
STABLE
AS $$
  SELECT p.created_timestamp::date AS day,
         array_agg(DISTINCT p.location_id) AS location_ids,
         count(*) AS total_rows
  FROM inventory.droptop_purchase_orders p
  WHERE p.location_id IS NOT NULL
    AND p.created_timestamp >= p_start::timestamptz
    AND p.created_timestamp < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_orders_daily_coverage(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_droptop_time_clock_daily_coverage(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_droptop_usage_daily_coverage(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_droptop_po_daily_coverage(date, date) TO authenticated, service_role;
