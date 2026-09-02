-- Adds a stable ORDER BY to public.get_heatmap_zip_rollup_clusters, needed
-- for the client to paginate it correctly (see the 2026-09-14 fix in
-- CustomerHeatmapPage.tsx: RPC calls over PostgREST are subject to the
-- SAME project "Max Rows" cap as plain .from() queries, which silently
-- truncated a real company-wide month's rollup preview at exactly 1,000
-- zip rows — the identical bug already found and fixed once this session
-- for the raw orders fetch, just resurfacing in a new call site that
-- wasn't paginated in the first place). GROUP BY alone doesn't guarantee a
-- stable row order across pages, so .range()-based pagination needs this
-- explicit ORDER BY to be correct (no dropped or duplicated zips at a page
-- boundary).
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
  ORDER BY r.zip
$$;

GRANT EXECUTE ON FUNCTION public.get_heatmap_zip_rollup_clusters(date, date, uuid[]) TO authenticated;
