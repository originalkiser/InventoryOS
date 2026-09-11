-- Custom quart pricing stays one row per shop, but now holds a price per
-- PACKAGE again (as a jsonb map, package_key -> price_per_quart) instead of
-- one price applied uniformly to every package. A package_key absent from
-- the map just uses that package's company default — nothing changes for a
-- shop that only ever needs one or two packages customized.
--
-- Backfill: the prior single price_per_quart applied to every package, so
-- expand it into an entry for each package active at the time of this
-- migration — preserves the exact same effective pricing, while now
-- letting each package be adjusted independently going forward.

ALTER TABLE marketing.menu_board_quart_overrides
  ADD COLUMN IF NOT EXISTS prices jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE marketing.menu_board_quart_overrides o
SET prices = COALESCE((
  SELECT jsonb_object_agg(mp.package_key, o.price_per_quart)
  FROM marketing.menu_board_packages mp
  WHERE mp.company_id = o.company_id AND mp.active
), '{}'::jsonb)
WHERE o.price_per_quart IS NOT NULL AND o.prices = '{}'::jsonb;

ALTER TABLE marketing.menu_board_quart_overrides
  DROP COLUMN IF EXISTS price_per_quart;

-- get_menu_board_shop_by_slug delegates to this, so it picks up the
-- per-package shape with no changes of its own.
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
    'custom_prices', COALESCE((
      SELECT o.prices FROM marketing.menu_board_quart_overrides o
      WHERE o.company_id = v_share.company_id AND o.location_id = p_location_id
    ), '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_board_shop(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
