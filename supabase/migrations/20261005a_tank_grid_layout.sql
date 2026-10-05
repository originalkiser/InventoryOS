-- Tank Calculator: shops lay their tanks out on a free-form grid (any widths/rows) instead of a fixed 4-wide list.
-- shop_tanks.grid = {x, y, w, h} in grid units within the tank's area section; NULL = not placed yet (page picks a default spot).
ALTER TABLE inventory.shop_tanks ADD COLUMN IF NOT EXISTS grid jsonb;

CREATE OR REPLACE FUNCTION public.get_tank_share(p_slug text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; loc core.locations;
BEGIN
  BEGIN l := inventory._tank_link(p_slug); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error', 'not_found'); END;
  SELECT * INTO loc FROM core.locations WHERE id = l.location_id;
  RETURN jsonb_build_object(
    'shop', jsonb_build_object('name', loc.name, 'shop_city', loc.shop_city, 'address', loc.address, 'city', loc.city, 'state', loc.state, 'zip', loc.zip),
    'tanks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', k.id, 'name', k.name, 'product_label', k.product_label, 'area', k.area, 'shape', k.shape, 'dims', k.dims,
        'capacity_qts', k.capacity_qts, 'monitor_serial', k.monitor_serial, 'sort_order', k.sort_order, 'grid', k.grid,
        'baseline_variance_qts', k.baseline_variance_qts, 'monitor_capacity_qts', k.monitor_capacity_qts,
        'monitor_height_in', k.monitor_height_in, 'monitor_product', k.monitor_product, 'source', k.source,
        'last_log', (SELECT jsonb_build_object('depth_in', g.depth_in, 'volume_qts', g.volume_qts, 'logged_at', g.logged_at, 'status', g.status)
                     FROM inventory.shop_tank_logs g WHERE g.tank_id = k.id AND g.status <> 'rejected' ORDER BY g.logged_at DESC LIMIT 1))
        ORDER BY k.area, k.sort_order, k.created_at)
      FROM inventory.shop_tanks k WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.active), '[]'::jsonb));
END $$;

-- p_items: [{id, x, y, w, h}] — an item without x clears that tank's saved spot (used by "Reset layout").
CREATE OR REPLACE FUNCTION public.tank_share_save_layout(p_slug text, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; it jsonb;
BEGIN
  l := inventory._tank_link(p_slug);
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE inventory.shop_tanks SET
      grid = CASE WHEN it ? 'x' THEN jsonb_build_object(
        'x', greatest(0, least(11, (it ->> 'x')::int)), 'y', greatest(0, (it ->> 'y')::int),
        'w', greatest(1, least(12, (it ->> 'w')::int)), 'h', greatest(1, least(60, (it ->> 'h')::int))) ELSE NULL END
     WHERE id = (it ->> 'id')::uuid AND location_id = l.location_id AND company_id = l.company_id;
  END LOOP;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION public.tank_share_save_layout(text, jsonb) TO anon, authenticated;
