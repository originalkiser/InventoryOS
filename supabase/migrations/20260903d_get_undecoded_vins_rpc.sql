-- Backs the vin-decode Edge Function's scheduled/automatic mode — finds
-- VINs already synced (inventory.droptop_order_vehicles) that don't have a
-- row in inventory.vin_decoded yet, so a scheduled run can make steady
-- progress on the backlog without the caller needing to know which VINs
-- exist. SECURITY INVOKER (not DEFINER) matching this app's own RPC
-- convention (get_heatmap_zip_rollup_clusters, get_droptop_order_location_ids_in_range)
-- — no elevated privilege needed; the Edge Function always calls this with
-- its service-role client anyway, which already bypasses RLS.
CREATE OR REPLACE FUNCTION public.get_undecoded_vins(p_limit integer DEFAULT 300)
RETURNS TABLE(vin text)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = ''
AS $$
  SELECT DISTINCT dov.vin
  FROM inventory.droptop_order_vehicles dov
  LEFT JOIN inventory.vin_decoded vd ON vd.vin = dov.vin
  WHERE dov.vin IS NOT NULL
    AND vd.vin IS NULL
  LIMIT p_limit
$$;
