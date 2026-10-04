-- Tank Calculator (Shop Tools): shops save their tanks' dimensions once and then only enter the filled depth each time.
-- Shops reach it through a shareable no-login link (one per shop, like Menu Board shop links); every public read/write goes
-- through the SECURITY DEFINER RPCs below, keyed by the link's slug — the tables themselves are RLS-locked to signed-in
-- users of the company.

CREATE TABLE IF NOT EXISTS inventory.shop_tank_links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  location_id uuid        NOT NULL,
  slug        text        NOT NULL UNIQUE,
  label       text,
  active      boolean     NOT NULL DEFAULT true,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_tank_links_active_shop ON inventory.shop_tank_links (company_id, location_id) WHERE active;

CREATE TABLE IF NOT EXISTS inventory.shop_tanks (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid        NOT NULL,
  location_id                uuid        NOT NULL,
  name                       text        NOT NULL,
  product_label              text,
  area                       text        NOT NULL DEFAULT 'bay' CHECK (area IN ('basement', 'back_room', 'bay')),
  shape                      text        NOT NULL,
  dims                       jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- inches
  capacity_qts               numeric,
  monitor_serial             text,
  sort_order                 integer     NOT NULL DEFAULT 0,
  baseline_variance_qts      numeric,
  baseline_set_at            timestamptz,
  prev_baseline_variance_qts numeric,
  prev_baseline_set_at       timestamptz,
  active                     boolean     NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_tanks_loc ON inventory.shop_tanks (company_id, location_id) WHERE active;

CREATE TABLE IF NOT EXISTS inventory.shop_tank_logs (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        NOT NULL,
  location_id           uuid        NOT NULL,
  tank_id               uuid        NOT NULL REFERENCES inventory.shop_tanks(id) ON DELETE CASCADE,
  logged_at             timestamptz NOT NULL DEFAULT now(),
  depth_in              numeric     NOT NULL,
  volume_qts            numeric     NOT NULL,
  monitor_read_at       timestamptz,
  monitor_qts           numeric,
  monitor_online        boolean,
  sales_adjust_qts      numeric,
  expected_qts          numeric,
  variance_qts          numeric,
  baseline_variance_qts numeric,
  status                text        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'held', 'rejected')),
  hold_reasons          text[]      NOT NULL DEFAULT '{}',
  confirmed_accurate    boolean     NOT NULL DEFAULT false,
  set_baseline          boolean     NOT NULL DEFAULT false,
  reviewed_by           uuid,
  reviewed_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_shop_tank_logs_tank ON inventory.shop_tank_logs (tank_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_tank_logs_status ON inventory.shop_tank_logs (company_id, status) WHERE status = 'held';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_tank_links', 'shop_tanks', 'shop_tank_logs'] LOOP
    EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_rw', t);
    EXECUTE format($p$CREATE POLICY %I ON inventory.%I FOR ALL
      USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = (SELECT auth.uid())))
      WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = (SELECT auth.uid())))$p$, t || '_rw', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.%I TO authenticated', t);
  END LOOP;
END $$;

-- ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory._tank_link(p_slug text) RETURNS inventory.shop_tank_links
LANGUAGE plpgsql SECURITY DEFINER SET search_path = inventory, pg_temp AS $$
DECLARE l inventory.shop_tank_links;
BEGIN
  SELECT * INTO l FROM inventory.shop_tank_links WHERE slug = p_slug AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  RETURN l;
END $$;

-- Compare a measured volume with what the tank monitor says (minus what sold since its last reading) and decide whether
-- the shop must confirm it and whether the log should be held for review. Thresholds: confirm when the variance is new or
-- more than 10 qts off its baseline; hold when it is 0, jumps by more than half the tank, repeats, or the variance moves
-- by more than 50 qts from last time.
CREATE OR REPLACE FUNCTION inventory._tank_eval(p_tank uuid, p_depth numeric, p_volume numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = inventory, pg_temp AS $$
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
    SELECT s.value ->> mon_product INTO mapped FROM platform.app_settings s WHERE s.company_id = t.company_id AND s.key = 'tank_product_map';
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
END $$;

-- ── public RPCs (anon) ───────────────────────────────────────────────────────────────────────────────────────────
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
        'baseline_variance_qts', k.baseline_variance_qts,
        'last_log', (SELECT jsonb_build_object('depth_in', g.depth_in, 'volume_qts', g.volume_qts, 'logged_at', g.logged_at, 'status', g.status)
                     FROM inventory.shop_tank_logs g WHERE g.tank_id = k.id AND g.status <> 'rejected' ORDER BY g.logged_at DESC LIMIT 1))
        ORDER BY k.area, k.sort_order, k.created_at)
      FROM inventory.shop_tanks k WHERE k.location_id = l.location_id AND k.company_id = l.company_id AND k.active), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.tank_share_upsert(p_slug text, p_tank jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; k inventory.shop_tanks; v_id uuid := nullif(p_tank ->> 'id', '')::uuid; changed boolean := false;
BEGIN
  l := inventory._tank_link(p_slug);
  IF p_tank ->> 'area' NOT IN ('basement', 'back_room', 'bay') THEN RAISE EXCEPTION 'bad_area'; END IF;
  IF v_id IS NULL THEN
    INSERT INTO inventory.shop_tanks (company_id, location_id, name, product_label, area, shape, dims, capacity_qts, monitor_serial, sort_order)
    VALUES (l.company_id, l.location_id, coalesce(nullif(btrim(p_tank ->> 'name'), ''), 'Tank'), nullif(btrim(p_tank ->> 'product_label'), ''),
            p_tank ->> 'area', p_tank ->> 'shape', coalesce(p_tank -> 'dims', '{}'::jsonb), nullif(p_tank ->> 'capacity_qts', '')::numeric,
            nullif(btrim(p_tank ->> 'monitor_serial'), ''),
            coalesce((SELECT max(sort_order) + 1 FROM inventory.shop_tanks WHERE location_id = l.location_id AND area = p_tank ->> 'area' AND active), 0))
    RETURNING * INTO k;
  ELSE
    SELECT * INTO k FROM inventory.shop_tanks WHERE id = v_id AND location_id = l.location_id AND company_id = l.company_id AND active;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
    changed := k.shape IS DISTINCT FROM (p_tank ->> 'shape') OR k.dims IS DISTINCT FROM coalesce(p_tank -> 'dims', '{}'::jsonb);
    UPDATE inventory.shop_tanks SET
      name = coalesce(nullif(btrim(p_tank ->> 'name'), ''), name), product_label = nullif(btrim(p_tank ->> 'product_label'), ''),
      area = p_tank ->> 'area', shape = p_tank ->> 'shape', dims = coalesce(p_tank -> 'dims', '{}'::jsonb),
      capacity_qts = nullif(p_tank ->> 'capacity_qts', '')::numeric, monitor_serial = nullif(btrim(p_tank ->> 'monitor_serial'), ''),
      -- new dimensions make the old baseline meaningless (kept for undo)
      prev_baseline_variance_qts = CASE WHEN changed AND baseline_variance_qts IS NOT NULL THEN baseline_variance_qts ELSE prev_baseline_variance_qts END,
      baseline_variance_qts = CASE WHEN changed THEN NULL ELSE baseline_variance_qts END,
      updated_at = now()
    WHERE id = k.id RETURNING * INTO k;
  END IF;
  RETURN to_jsonb(k) - 'company_id';
END $$;

CREATE OR REPLACE FUNCTION public.tank_share_delete(p_slug text, p_tank_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links;
BEGIN
  l := inventory._tank_link(p_slug);
  UPDATE inventory.shop_tanks SET active = false, updated_at = now() WHERE id = p_tank_id AND location_id = l.location_id AND company_id = l.company_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- p_items: [{id, area, sort_order}]
CREATE OR REPLACE FUNCTION public.tank_share_reorder(p_slug text, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; it jsonb;
BEGIN
  l := inventory._tank_link(p_slug);
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE inventory.shop_tanks SET area = it ->> 'area', sort_order = (it ->> 'sort_order')::int, updated_at = now()
     WHERE id = (it ->> 'id')::uuid AND location_id = l.location_id AND company_id = l.company_id AND (it ->> 'area') IN ('basement', 'back_room', 'bay');
  END LOOP;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.tank_share_preview(p_slug text, p_tank_id uuid, p_depth numeric, p_volume_qts numeric) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links;
BEGIN
  l := inventory._tank_link(p_slug);
  PERFORM 1 FROM inventory.shop_tanks WHERE id = p_tank_id AND location_id = l.location_id AND company_id = l.company_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  RETURN inventory._tank_eval(p_tank_id, p_depth, p_volume_qts);
END $$;

CREATE OR REPLACE FUNCTION public.tank_share_log(p_slug text, p_tank_id uuid, p_depth numeric, p_volume_qts numeric, p_confirmed boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l inventory.shop_tank_links; t inventory.shop_tanks; e jsonb; holds text[]; v_status text; v_set boolean := false; v_id uuid; v_online boolean;
  v_var numeric; v_base numeric;
BEGIN
  l := inventory._tank_link(p_slug);
  SELECT * INTO t FROM inventory.shop_tanks WHERE id = p_tank_id AND location_id = l.location_id AND company_id = l.company_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  e := inventory._tank_eval(p_tank_id, p_depth, p_volume_qts);
  IF (e ->> 'needs_confirm')::boolean AND NOT coalesce(p_confirmed, false) THEN
    RETURN e || jsonb_build_object('error', 'confirmation_required');
  END IF;
  SELECT coalesce(array_agg(x), '{}') INTO holds FROM jsonb_array_elements_text(e -> 'hold_reasons') x;
  v_status := CASE WHEN array_length(holds, 1) > 0 THEN 'held' ELSE 'ok' END;
  v_online := (e ->> 'online')::boolean;
  v_var := nullif(e ->> 'variance_qts', '')::numeric;
  v_base := t.baseline_variance_qts;
  -- A confirmed, un-held measurement against an online monitor becomes the tank's new baseline variance.
  IF v_status = 'ok' AND v_online AND v_var IS NOT NULL AND (e ->> 'needs_confirm')::boolean THEN
    v_set := true;
    UPDATE inventory.shop_tanks SET prev_baseline_variance_qts = baseline_variance_qts, prev_baseline_set_at = baseline_set_at,
           baseline_variance_qts = v_var, baseline_set_at = now(), updated_at = now() WHERE id = t.id;
  END IF;
  INSERT INTO inventory.shop_tank_logs (company_id, location_id, tank_id, depth_in, volume_qts, monitor_read_at, monitor_qts, monitor_online,
      sales_adjust_qts, expected_qts, variance_qts, baseline_variance_qts, status, hold_reasons, confirmed_accurate, set_baseline)
  VALUES (l.company_id, l.location_id, t.id, p_depth, p_volume_qts, nullif(e ->> 'monitor_read_at', '')::timestamptz, nullif(e ->> 'monitor_qts', '')::numeric,
      v_online, nullif(e ->> 'sales_adjust_qts', '')::numeric, nullif(e ->> 'expected_qts', '')::numeric, v_var, v_base, v_status, holds,
      coalesce(p_confirmed, false), v_set)
  RETURNING id INTO v_id;
  RETURN e || jsonb_build_object('log_id', v_id, 'status', v_status, 'new_baseline', v_set, 'previous_baseline_qts', v_base);
END $$;

CREATE OR REPLACE FUNCTION public.tank_share_undo_baseline(p_slug text, p_log_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l inventory.shop_tank_links; g inventory.shop_tank_logs;
BEGIN
  l := inventory._tank_link(p_slug);
  SELECT * INTO g FROM inventory.shop_tank_logs WHERE id = p_log_id AND location_id = l.location_id AND company_id = l.company_id;
  IF NOT FOUND OR NOT g.set_baseline THEN RETURN jsonb_build_object('error', 'nothing_to_undo'); END IF;
  UPDATE inventory.shop_tanks SET baseline_variance_qts = prev_baseline_variance_qts, baseline_set_at = prev_baseline_set_at,
         prev_baseline_variance_qts = NULL, prev_baseline_set_at = NULL, updated_at = now() WHERE id = g.tank_id;
  UPDATE inventory.shop_tank_logs SET set_baseline = false WHERE id = g.id;
  RETURN jsonb_build_object('ok', true);
END $$;

GRANT EXECUTE ON FUNCTION public.get_tank_share(text), public.tank_share_upsert(text, jsonb), public.tank_share_delete(text, uuid),
  public.tank_share_reorder(text, jsonb), public.tank_share_preview(text, uuid, numeric, numeric),
  public.tank_share_log(text, uuid, numeric, numeric, boolean), public.tank_share_undo_baseline(text, uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION inventory._tank_link(text), inventory._tank_eval(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
