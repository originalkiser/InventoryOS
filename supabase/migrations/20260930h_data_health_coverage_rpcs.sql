-- Data Connections -> Data Health tab: day-by-day "which shops actually
-- have data" coverage, for the Droptop connections that are genuinely daily
-- per-location feeds (Orders, Staff Time Clock, Usage, Purchase Orders).
-- On Hand is deliberately NOT here — it's a monthly snapshot
-- (inventory.count_products, delete-then-insert per location per
-- count_month, see droptop-sync-usage's mode:'inventory' path), so a
-- day-by-day chart doesn't apply the same way; get_droptop_on_hand_month_coverage
-- below covers it with a month-completeness shape instead.
--
-- Each function returns one row per calendar day with the distinct set of
-- location_ids that had at least one real row that day — small and cheap to
-- transfer (a client asking for, say, 60 days gets 60 rows, not 60 ×
-- location-count) — the client already has the full location list loaded
-- (useLocations) to diff against and to resolve id -> shop label, and to
-- compute "this shop usually has data on this weekday but is missing today"
-- gap detection itself.
--
-- SECURITY INVOKER, same reasoning as get_droptop_order_month_stats: the
-- caller's own RLS on each table applies, no company_id argument needed or
-- trusted.

CREATE OR REPLACE FUNCTION public.get_droptop_orders_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[])
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  -- Finalized only, matching how "effective car" is counted everywhere else
  -- (LHCE, Customer Heatmap, Staffing Report) — a shop with only Void/
  -- Uncollectible orders that day reads the same as no data, which is the
  -- right call for a coverage check (nothing effectively sold).
  SELECT o.order_finalized_at::date AS day,
         array_agg(DISTINCT o.location_id) AS location_ids
  FROM inventory.droptop_orders o
  WHERE o.status = 'Finalized'
    AND o.order_finalized_at >= p_start::timestamptz
    AND o.order_finalized_at < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_orders_daily_coverage(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_droptop_time_clock_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[])
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT t.clock_in::date AS day,
         array_agg(DISTINCT t.location_id) AS location_ids
  FROM inventory.droptop_time_records t
  WHERE t.clock_in >= p_start::timestamptz
    AND t.clock_in < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_time_clock_daily_coverage(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_droptop_usage_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[])
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT a.activity_date AS day,
         array_agg(DISTINCT a.location_id) AS location_ids
  FROM inventory.daily_product_activity a
  WHERE a.activity_date >= p_start AND a.activity_date <= p_end
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_usage_daily_coverage(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_droptop_po_daily_coverage(
  p_start date,
  p_end date
)
RETURNS TABLE (day date, location_ids uuid[])
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT p.created_timestamp::date AS day,
         array_agg(DISTINCT p.location_id) AS location_ids
  FROM inventory.droptop_purchase_orders p
  WHERE p.location_id IS NOT NULL
    AND p.created_timestamp >= p_start::timestamptz
    AND p.created_timestamp < (p_end::date + 1)::timestamptz
  GROUP BY 1
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_po_daily_coverage(date, date) TO authenticated;

-- On Hand: a single snapshot per location per count_month (not a daily
-- feed) — "coverage" here means "does this location have a row for the
-- currently-tracked month at all", so the shape is a plain distinct-location
-- list for one month, not a per-day series.
CREATE OR REPLACE FUNCTION public.get_droptop_on_hand_month_coverage(
  p_month text
)
RETURNS uuid[]
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  -- count_month is a `date` column (always the 1st of the month) — cast the
  -- text arg the same way the existing get_aggregated_monthly_products RPC
  -- does, rather than assuming a text column.
  SELECT coalesce(array_agg(DISTINCT cp.location_id), '{}')
  FROM inventory.count_products cp
  WHERE cp.count_month = p_month::date
$$;
GRANT EXECUTE ON FUNCTION public.get_droptop_on_hand_month_coverage(text) TO authenticated;
