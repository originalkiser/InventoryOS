-- Tank Calculator: pre-load each shop's VMI tanks from its tank monitors. A preloaded tank knows its monitor serial, product
-- and the monitor's capacity/height, but not its shape or dimensions — those stay blank (highlighted orange in the app) until
-- the shop fills them in.
ALTER TABLE inventory.shop_tanks ALTER COLUMN shape DROP NOT NULL;
ALTER TABLE inventory.shop_tanks
  ADD COLUMN IF NOT EXISTS monitor_capacity_qts numeric,
  ADD COLUMN IF NOT EXISTS monitor_height_in    numeric,
  ADD COLUMN IF NOT EXISTS monitor_product      text,
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'manual';

-- Adds a tank for every monitor assigned to this shop that isn't already on its list (active or removed — a tank the shop
-- deleted is not brought back). Safe to call on every page load.
CREATE OR REPLACE FUNCTION public.tank_share_sync_monitors(p_slug text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; n integer := 0; base_sort integer;
BEGIN
  l := inventory._tank_link(p_slug);
  SELECT coalesce(max(sort_order) + 1, 0) INTO base_sort FROM inventory.shop_tanks WHERE location_id = l.location_id AND area = 'bay';
  WITH latest AS (
    SELECT DISTINCT ON (m.serial_rtu_id) m.serial_rtu_id, m.product_id, m.total_capacity, m.height, m.system_tank_id
    FROM inventory.tank_monitors m
    WHERE m.company_id = l.company_id AND m.location_id = l.location_id AND coalesce(btrim(m.serial_rtu_id), '') <> ''
    ORDER BY m.serial_rtu_id, m.inventory_time DESC NULLS LAST
  ), fresh AS (
    SELECT lt.*, row_number() OVER (ORDER BY lt.product_id, lt.serial_rtu_id) AS rn, count(*) OVER (PARTITION BY lt.product_id) AS same_product
    FROM latest lt
    WHERE NOT EXISTS (SELECT 1 FROM inventory.shop_tanks k WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.monitor_serial = lt.serial_rtu_id)
  ), ins AS (
    INSERT INTO inventory.shop_tanks (company_id, location_id, name, product_label, area, shape, dims, capacity_qts, monitor_serial,
                                      monitor_capacity_qts, monitor_height_in, monitor_product, source, sort_order)
    SELECT l.company_id, l.location_id,
           CASE WHEN f.same_product > 1 THEN coalesce(f.product_id, 'Tank') || ' #' || right(f.serial_rtu_id, 4) ELSE coalesce(f.product_id, 'Tank') END,
           f.product_id, 'bay', NULL, '{}'::jsonb, NULL, f.serial_rtu_id,
           f.total_capacity * 4, nullif(f.height, 0), f.product_id, 'monitor', base_sort + (f.rn - 1)::int
    FROM fresh f
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  RETURN jsonb_build_object('added', n);
END $$;

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
        'capacity_qts', k.capacity_qts, 'monitor_serial', k.monitor_serial, 'sort_order', k.sort_order,
        'baseline_variance_qts', k.baseline_variance_qts, 'monitor_capacity_qts', k.monitor_capacity_qts,
        'monitor_height_in', k.monitor_height_in, 'monitor_product', k.monitor_product, 'source', k.source,
        'last_log', (SELECT jsonb_build_object('depth_in', g.depth_in, 'volume_qts', g.volume_qts, 'logged_at', g.logged_at, 'status', g.status)
                     FROM inventory.shop_tank_logs g WHERE g.tank_id = k.id AND g.status <> 'rejected' ORDER BY g.logged_at DESC LIMIT 1))
        ORDER BY k.area, k.sort_order, k.created_at)
      FROM inventory.shop_tanks k WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.active), '[]'::jsonb));
END $$;

GRANT EXECUTE ON FUNCTION public.tank_share_sync_monitors(text) TO anon, authenticated;
