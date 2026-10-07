-- Tank Calculator: the variance allowance (quarts a shop's measurement may differ from the tank monitor before the card flags it red and shades the
-- gap on the drawing) is a company setting — platform.app_settings key 'tank_calc_variance_allowance_qts', edited by admins/developers on the
-- Tank Calculator Links page — and rides along with the shop's tank list (the public page can't read app_settings itself). Default 100.

CREATE OR REPLACE FUNCTION public.get_tank_share(p_slug text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; loc core.locations; tmap jsonb; allowance numeric;
BEGIN
  BEGIN l := inventory._tank_link(p_slug); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error', 'not_found'); END;
  SELECT * INTO loc FROM core.locations WHERE id = l.location_id;
  SELECT s.value INTO tmap FROM platform.app_settings s WHERE s.company_id = l.company_id AND s.key = 'tank_product_map';
  SELECT CASE WHEN jsonb_typeof(s.value) = 'number' THEN (s.value #>> '{}')::numeric END INTO allowance
    FROM platform.app_settings s WHERE s.company_id = l.company_id AND s.key = 'tank_calc_variance_allowance_qts';
  RETURN jsonb_build_object(
    'settings', jsonb_build_object('variance_allowance_qts', coalesce(allowance, 100)),
    'shop', jsonb_build_object('name', loc.name, 'shop_city', loc.shop_city, 'address', loc.address, 'city', loc.city, 'state', loc.state, 'zip', loc.zip),
    'tanks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', k.id, 'name', k.name, 'product_label', k.product_label, 'area', k.area, 'shape', k.shape, 'dims', k.dims,
        'capacity_qts', k.capacity_qts, 'monitor_serial', k.monitor_serial, 'sort_order', k.sort_order, 'grid', k.grid,
        'baseline_variance_qts', k.baseline_variance_qts, 'monitor_capacity_qts', k.monitor_capacity_qts,
        'monitor_height_in', k.monitor_height_in, 'monitor_product', k.monitor_product, 'source', k.source,
        'internal_product', (SELECT coalesce(
            tmap ->> lower(btrim(mp.t)),
            (SELECT vp.our_part_number FROM inventory.vendor_parts vp
              WHERE vp.company_id = l.company_id AND vp.our_part_number IS NOT NULL
                AND (lower(btrim(vp.description)) = lower(btrim(mp.t)) OR lower(btrim(vp.part_number)) = lower(btrim(mp.t))) LIMIT 1))
          FROM (SELECT coalesce(nullif(btrim(m.product_id), ''), nullif(btrim(k.monitor_product), '')) AS t) mp WHERE mp.t IS NOT NULL),
        'monitor', CASE WHEN m.serial_rtu_id IS NULL THEN NULL ELSE jsonb_build_object(
                      'serial', m.serial_rtu_id, 'system_tank_id', m.system_tank_id, 'product_id', m.product_id,
                      'on_hand_gal', m.on_hand, 'total_capacity_gal', m.total_capacity, 'available_capacity_gal', m.available_capacity,
                      'level_in', m.level_inches, 'height_in', m.height, 'battery_pct', m.battery_pct, 'alarm', m.volume_alarm_status,
                      'note', m.key_note, 'read_at', m.inventory_time, 'keep_fill', m.keep_fill) END,
        'last_log', (SELECT jsonb_build_object('depth_in', g.depth_in, 'volume_qts', g.volume_qts, 'logged_at', g.logged_at, 'status', g.status)
                     FROM inventory.shop_tank_logs g WHERE g.tank_id = k.id AND g.status <> 'rejected' ORDER BY g.logged_at DESC LIMIT 1))
        ORDER BY k.area, k.sort_order, k.created_at)
      FROM inventory.shop_tanks k
      LEFT JOIN LATERAL (
        SELECT mm.* FROM inventory.tank_monitors mm
        WHERE k.monitor_serial IS NOT NULL AND mm.company_id = l.company_id AND mm.location_id = l.location_id AND mm.serial_rtu_id = k.monitor_serial
        ORDER BY mm.inventory_time DESC NULLS LAST LIMIT 1) m ON true
      WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.active), '[]'::jsonb));
END $$;
GRANT EXECUTE ON FUNCTION public.get_tank_share(text) TO anon, authenticated;
