-- Customer Heatmap — read-side RPC for the rollup fast path. Returns
-- already-aggregated per-zip totals for a date range (and optional
-- location scope) in ONE call, instead of the client paging through
-- inventory.heatmap_zip_rollups' raw per-(location,zip,day) rows itself.
--
-- SECURITY INVOKER (not DEFINER) deliberately — the caller's own RLS on
-- inventory.heatmap_zip_rollups still applies (company_id scoping via
-- platform.user_profiles), so this can be granted directly to
-- `authenticated` without needing to pass or trust a company_id argument;
-- a caller can never see another company's rows through this function
-- than they could already see via a plain SELECT.
--
-- location_ids per zip is returned so the client can reproduce "Shared
-- Only" matching (does this zip have an order at every selected shop)
-- against rollup data the same way it already does against raw orders.
CREATE OR REPLACE FUNCTION public.get_heatmap_zip_rollup_clusters(
  p_start date,
  p_end date,
  p_location_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  zip text,
  city text,
  region text,
  lat numeric,
  lng numeric,
  order_count bigint,
  ticket_total numeric,
  location_ids uuid[]
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT
    r.zip,
    (array_agg(r.city ORDER BY r.updated_at DESC))[1] AS city,
    (array_agg(r.region ORDER BY r.updated_at DESC))[1] AS region,
    (array_agg(r.lat ORDER BY r.updated_at DESC))[1] AS lat,
    (array_agg(r.lng ORDER BY r.updated_at DESC))[1] AS lng,
    SUM(r.order_count)::bigint AS order_count,
    SUM(r.ticket_total) AS ticket_total,
    array_agg(DISTINCT r.location_id) AS location_ids
  FROM inventory.heatmap_zip_rollups r
  WHERE r.order_date >= p_start
    AND r.order_date <= p_end
    AND (p_location_ids IS NULL OR r.location_id = ANY(p_location_ids))
  GROUP BY r.zip
$$;

GRANT EXECUTE ON FUNCTION public.get_heatmap_zip_rollup_clusters(date, date, uuid[]) TO authenticated;
