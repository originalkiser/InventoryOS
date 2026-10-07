-- Tank Calculator: send each tank's live tank-monitor details with the shop's tank list (serial, tank id, current reading,
-- capacity, level, battery, alarm, last report) so a shop can match tanks to monitors when it first sets them up.
-- 'monitor' is the most recent reading for the tank's serial at this shop (null when the tank has no monitor).
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
        'monitor', (SELECT jsonb_build_object(
                      'serial', m.serial_rtu_id, 'system_tank_id', m.system_tank_id, 'product_id', m.product_id,
                      'on_hand_gal', m.on_hand, 'total_capacity_gal', m.total_capacity, 'available_capacity_gal', m.available_capacity,
                      'level_in', m.level_inches, 'height_in', m.height, 'battery_pct', m.battery_pct, 'alarm', m.volume_alarm_status,
                      'note', m.key_note, 'read_at', m.inventory_time, 'keep_fill', m.keep_fill)
                    FROM inventory.tank_monitors m
                    WHERE k.monitor_serial IS NOT NULL AND m.company_id = l.company_id AND m.location_id = l.location_id AND m.serial_rtu_id = k.monitor_serial
                    ORDER BY m.inventory_time DESC NULLS LAST LIMIT 1),
        'last_log', (SELECT jsonb_build_object('depth_in', g.depth_in, 'volume_qts', g.volume_qts, 'logged_at', g.logged_at, 'status', g.status)
                     FROM inventory.shop_tank_logs g WHERE g.tank_id = k.id AND g.status <> 'rejected' ORDER BY g.logged_at DESC LIMIT 1))
        ORDER BY k.area, k.sort_order, k.created_at)
      FROM inventory.shop_tanks k WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.active), '[]'::jsonb));
END $$;
GRANT EXECUTE ON FUNCTION public.get_tank_share(text) TO anon, authenticated;
