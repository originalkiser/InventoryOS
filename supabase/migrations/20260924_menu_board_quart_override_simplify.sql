-- Simplify Menu Board's per-shop custom quart pricing: one override row per
-- shop instead of one per (shop, package), price-per-quart only. Included
-- quarts stays a company-wide constant per package
-- (marketing.menu_board_quart_defaults) — it was never actually meant to
-- vary per shop, and dropping it here keeps the override table to exactly
-- what a shop needs to adjust: its own price per extra quart.

-- Collapse any existing per-package rows down to one per shop before
-- dropping the columns that made per-package rows meaningful — keeps the
-- most-recently-updated row per (company_id, location_id) so the new
-- unique constraint below never has a duplicate to reject.
DELETE FROM marketing.menu_board_quart_overrides o
WHERE o.id NOT IN (
  SELECT DISTINCT ON (company_id, location_id) id
  FROM marketing.menu_board_quart_overrides
  ORDER BY company_id, location_id, updated_at DESC, id
);

-- CASCADE takes the old (company_id, location_id, package_key) unique
-- constraint with it, whatever Postgres happened to name it.
ALTER TABLE marketing.menu_board_quart_overrides
  DROP COLUMN IF EXISTS package_key CASCADE,
  DROP COLUMN IF EXISTS included_quarts;

ALTER TABLE marketing.menu_board_quart_overrides
  ADD CONSTRAINT menu_board_quart_overrides_company_location_uk UNIQUE (company_id, location_id);

-- get_menu_board_shop_by_slug delegates to this, so it picks up the
-- simplified shape with no changes of its own.
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
    'custom_price_per_quart', (
      SELECT o.price_per_quart FROM marketing.menu_board_quart_overrides o
      WHERE o.company_id = v_share.company_id AND o.location_id = p_location_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_board_shop(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
