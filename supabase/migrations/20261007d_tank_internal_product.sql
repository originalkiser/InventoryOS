-- Tank Calculator: match each tank monitor's product text to OUR internal product id (the Tank Monitors "Product Mapping" first, then
-- Vendor Parts description / part number — the same resolution Recount and Orders v2 use), so cards can lead with the internal id
-- instead of repeating the monitor's own product text. Also: the mapping is keyed by the LOWER-CASED monitor product, which the sales
-- adjustment in _tank_eval looked up case-sensitively (so a mapped product could silently get no sales adjustment).

CREATE OR REPLACE FUNCTION inventory._tank_eval(p_tank uuid, p_depth numeric, p_volume numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'inventory', 'pg_temp'
AS $function$
DECLARE
  t inventory.shop_tanks;
  mon_on_hand numeric; mon_time timestamptz; mon_product text; prev_depth numeric; prev_vol numeric; prev_at timestamptz; prev_var numeric;
  online boolean := false; monitor_qts numeric; sales numeric; expected numeric; variance numeric;
  mapped text; usage_rate numeric; factor numeric := 1; days numeric;
  confirm_tol constant numeric := 10; shift_hold constant numeric := 50;
  holds text[] := '{}'; needs_confirm boolean := false; recent int;
BEGIN
  SELECT * INTO t FROM inventory.shop_tanks WHERE id = p_tank AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;

  IF coalesce(btrim(t.monitor_serial), '') <> '' THEN
    SELECT on_hand, inventory_time, product_id INTO mon_on_hand, mon_time, mon_product FROM inventory.tank_monitors
      WHERE company_id = t.company_id AND serial_rtu_id = btrim(t.monitor_serial)
      ORDER BY inventory_time DESC NULLS LAST LIMIT 1;
    IF mon_time IS NOT NULL THEN
      online := mon_time > now() - interval '48 hours';
      monitor_qts := mon_on_hand * 4;  -- the monitors report gallons
    END IF;
  END IF;

  IF online THEN
    -- Sales since the monitor's reading: the shop's daily usage of the mapped product, over the elapsed time.
    SELECT coalesce(s.value ->> lower(btrim(mon_product)), s.value ->> mon_product) INTO mapped FROM platform.app_settings s WHERE s.company_id = t.company_id AND s.key = 'tank_product_map';
    IF mapped IS NOT NULL THEN
      SELECT daily_usage INTO usage_rate FROM inventory.product_usage WHERE company_id = t.company_id AND location_id = t.location_id AND product_id = mapped LIMIT 1;
      SELECT CASE WHEN lower(unit_of_measure) LIKE 'gal%' THEN 4 WHEN lower(unit_of_measure) LIKE 'quart%' THEN 1
                  WHEN lower(unit_of_measure) LIKE 'ounce%' THEN 1.0/32 WHEN lower(unit_of_measure) LIKE 'lit%' THEN 1.0567 ELSE 1 END
        INTO factor FROM inventory.global_products WHERE company_id = t.company_id AND lower(product_id) = lower(mapped) LIMIT 1;
      days := greatest(0, extract(epoch FROM (now() - mon_time)) / 86400.0);
      IF usage_rate IS NOT NULL THEN sales := usage_rate * coalesce(factor, 1) * days; END IF;
    END IF;
    expected := monitor_qts - coalesce(sales, 0);
    variance := p_volume - expected;
  END IF;

  SELECT depth_in, volume_qts, logged_at INTO prev_depth, prev_vol, prev_at FROM inventory.shop_tank_logs
    WHERE tank_id = p_tank AND status <> 'rejected' ORDER BY logged_at DESC LIMIT 1;
  SELECT variance_qts INTO prev_var FROM inventory.shop_tank_logs
    WHERE tank_id = p_tank AND status = 'ok' AND variance_qts IS NOT NULL ORDER BY logged_at DESC LIMIT 1;
  prev_var := coalesce(prev_var, t.baseline_variance_qts);

  IF p_depth <= 0 OR p_volume <= 0 THEN holds := holds || 'zero'; END IF;
  IF prev_at IS NOT NULL AND prev_at > now() - interval '72 hours' AND t.capacity_qts IS NOT NULL
     AND abs(p_volume - prev_vol) > 0.5 * t.capacity_qts THEN holds := holds || 'sudden_change'; END IF;
  SELECT count(*) INTO recent FROM inventory.shop_tank_logs WHERE tank_id = p_tank AND logged_at > now() - interval '24 hours';
  IF (prev_at IS NOT NULL AND prev_depth = p_depth AND prev_at > now() - interval '1 hour') OR recent >= 3 THEN
    holds := holds || 'repeat';
  END IF;
  IF variance IS NOT NULL AND prev_var IS NOT NULL AND abs(variance - prev_var) > shift_hold THEN holds := holds || 'variance_shift'; END IF;
  IF variance IS NOT NULL AND (t.baseline_variance_qts IS NULL OR abs(variance - t.baseline_variance_qts) > confirm_tol) THEN needs_confirm := true; END IF;

  RETURN jsonb_build_object(
    'monitor_found', mon_time IS NOT NULL, 'online', online, 'monitor_qts', monitor_qts, 'monitor_read_at', mon_time,
    'sales_adjust_qts', sales, 'expected_qts', expected, 'variance_qts', variance,
    'baseline_variance_qts', t.baseline_variance_qts, 'needs_confirm', needs_confirm, 'hold_reasons', to_jsonb(holds));
END $function$;

CREATE OR REPLACE FUNCTION public.get_tank_share(p_slug text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; loc core.locations; tmap jsonb;
BEGIN
  BEGIN l := inventory._tank_link(p_slug); EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('error', 'not_found'); END;
  SELECT * INTO loc FROM core.locations WHERE id = l.location_id;
  SELECT s.value INTO tmap FROM platform.app_settings s WHERE s.company_id = l.company_id AND s.key = 'tank_product_map';
  RETURN jsonb_build_object(
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
