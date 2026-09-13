-- Data Health's daily-detail table needs a real "Total Records" column
-- alongside the shop-id array (matching the shops-with-orders artifact this
-- feature was modeled on) — cheap to add, same GROUP BY, just also
-- count(*). Postgres won't let CREATE OR REPLACE change a function's return
-- row shape (new output column), so each one has to be dropped first — a
-- DROP+CREATE is a new object (new OID), so the 20260930h GRANTs do NOT
-- carry over; re-granted explicitly at the bottom of this file.
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

GRANT EXECUTE ON FUNCTION public.get_droptop_orders_daily_coverage(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_droptop_time_clock_daily_coverage(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_droptop_usage_daily_coverage(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_droptop_po_daily_coverage(date, date) TO authenticated;
