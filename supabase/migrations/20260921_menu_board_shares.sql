-- Shareable public menu-board links. A token either locks the viewer to
-- one shop (just the board, no picker) or lets them pick from the
-- company's shops. Public access is only ever through the two SECURITY
-- DEFINER RPCs below, keyed by token — the table itself and the
-- underlying marketing/core tables stay RLS-locked to authenticated.

CREATE TABLE IF NOT EXISTS marketing.menu_board_shares (
  token        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  -- NULL = viewer picks a shop; set = locked to that shop, no picker.
  location_id  uuid,
  label        text,
  active       boolean     NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing.menu_board_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "menu_board_shares_select" ON marketing.menu_board_shares;
CREATE POLICY "menu_board_shares_select" ON marketing.menu_board_shares FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "menu_board_shares_manage" ON marketing.menu_board_shares;
CREATE POLICY "menu_board_shares_manage" ON marketing.menu_board_shares FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing.menu_board_shares TO authenticated;

-- ── Public read: the board config + shop list for a token ────────────────
CREATE OR REPLACE FUNCTION public.get_menu_board_share(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_share   marketing.menu_board_shares%ROWTYPE;
  v_result  jsonb;
BEGIN
  SELECT * INTO v_share FROM marketing.menu_board_shares WHERE token = p_token AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT jsonb_build_object(
    'mode', CASE WHEN v_share.location_id IS NULL THEN 'open' ELSE 'locked' END,
    'locked_location_id', v_share.location_id,
    'packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(mp) - 'company_id' - 'updated_by' - 'created_at' - 'updated_at' ORDER BY mp.sort_order)
      FROM marketing.menu_board_packages mp WHERE mp.company_id = v_share.company_id
    ), '[]'::jsonb),
    'quart_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('package_key', d.package_key, 'price_per_quart', d.price_per_quart, 'included_quarts', d.included_quarts))
      FROM marketing.menu_board_quart_defaults d WHERE d.company_id = v_share.company_id
    ), '[]'::jsonb),
    'shops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id,
               'name', l.name,
               'shop_city', l.shop_city,
               'address', l.address, 'city', l.city, 'state', l.state, 'zip', l.zip
             ) ORDER BY l.name)
      FROM core.locations l
      WHERE l.company_id = v_share.company_id
        AND l.active
        AND (v_share.location_id IS NULL OR l.id = v_share.location_id)
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ── Public read: one shop's prices + quart overrides for a token ─────────
CREATE OR REPLACE FUNCTION public.get_menu_board_shop(p_token uuid, p_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_share  marketing.menu_board_shares%ROWTYPE;
  v_loc    core.locations%ROWTYPE;
BEGIN
  SELECT * INTO v_share FROM marketing.menu_board_shares WHERE token = p_token AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  -- A locked token can only ever read its own shop.
  IF v_share.location_id IS NOT NULL AND v_share.location_id <> p_location_id THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_loc FROM core.locations
  WHERE id = p_location_id AND company_id = v_share.company_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  RETURN jsonb_build_object(
    'id', v_loc.id,
    'address', v_loc.address, 'city', v_loc.city, 'state', v_loc.state, 'zip', v_loc.zip,
    'prices', jsonb_build_object(
      'economy', v_loc.economy, 'premium_hm', v_loc.premium_hm,
      'premium_full_synthetic', v_loc.premium_full_synthetic,
      'premium_full_synthetic_hm', v_loc.premium_full_synthetic_hm,
      'rp', v_loc.rp, 'diesel_syn_blend', v_loc.diesel_syn_blend,
      'diesel_full_syn', v_loc.diesel_full_syn, 'european', v_loc.european,
      'supply_fee', v_loc.supply_fee, 'disposal_fee', v_loc.disposal_fee,
      'oil_inflation_surcharge', v_loc.oil_inflation_surcharge
    ),
    'quart_overrides', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('package_key', o.package_key, 'price_per_quart', o.price_per_quart, 'included_quarts', o.included_quarts))
      FROM marketing.menu_board_quart_overrides o
      WHERE o.company_id = v_share.company_id AND o.location_id = p_location_id
    ), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_board_share(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_menu_board_shop(uuid, uuid) TO anon, authenticated;
