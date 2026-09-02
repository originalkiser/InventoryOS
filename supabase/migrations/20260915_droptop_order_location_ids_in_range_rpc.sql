-- "Select Gap Shops" (Data Connections -> Historical Orders Backfill) only
-- ever checked "has this location EVER had any order land" (via
-- inventory.droptop_orders_synced_locations) — that misses a real, found-
-- in-production case: a shop with just a few days of orders from the daily
-- incremental sync (e.g. 2 orders, both from the last day of the month)
-- reads as "already synced" even though its actual historical backfill for
-- the requested range never ran or never finished. Confirmed live
-- (2026-09-02): shops 212 and 114 both show this pattern — 2 and 33
-- orders respectively, both windows only a few days wide at the very end
-- of the month.
--
-- This RPC answers the question that actually matters for the backfill
-- button: "which eligible shops have zero orders WITHIN THE RANGE I'm
-- about to backfill" — not "ever, at any date." SECURITY INVOKER (not
-- DEFINER) for the same reason as get_heatmap_zip_rollup_clusters: the
-- caller's own RLS on droptop_orders applies, no company_id argument
-- needed or trusted.
CREATE OR REPLACE FUNCTION public.get_droptop_order_location_ids_in_range(
  p_start date,
  p_end date
)
RETURNS TABLE (location_id uuid)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT DISTINCT o.location_id
  FROM inventory.droptop_orders o
  WHERE o.location_id IS NOT NULL
    AND o.order_finalized_at >= p_start::timestamptz
    AND o.order_finalized_at < (p_end::date + 1)::timestamptz
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_order_location_ids_in_range(date, date) TO authenticated;
