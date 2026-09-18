-- Per-quart pricing on franchisee setup links (2026-09-19 follow-up) --
-- originally this feature deliberately never supported per-shop quart-price
-- overrides for franchise boards (see 20260930z's own header comment on
-- get_franchise_menu_share_by_slug) -- now explicitly requested: an admin
-- can flip a setup link's "allow quart pricing" flag (at creation, or later
-- on an already-live link -- it's just a boolean on the link row, not baked
-- into a fixed link shape) to add an editable, SB-Net-price-auto-filled
-- price-per-quart field next to each base package price on that link's
-- setup form. The confirmed values, if any, are stored per-share (not
-- per-link) since each generated board is its own pricing snapshot, same
-- reasoning as the base prices already work this way.
ALTER TABLE marketing.franchise_setup_links
  ADD COLUMN allow_quart_pricing boolean NOT NULL DEFAULT false;

ALTER TABLE marketing.franchise_menu_shares
  ADD COLUMN quart_prices jsonb;

-- get_franchise_setup_context: also return the link's allow_quart_pricing
-- flag so the public setup page knows whether to show the quart fields.
CREATE OR REPLACE FUNCTION public.get_franchise_setup_context(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link marketing.franchise_setup_links%ROWTYPE;
BEGIN
  SELECT * INTO v_link
  FROM marketing.franchise_setup_links
  WHERE token = p_token AND active;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'company_id', v_link.company_id,
    'allow_quart_pricing', v_link.allow_quart_pricing,
    'shops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'shop_city', l.shop_city, 'owner', l.owner, 'active', l.active,
        'address', l.address, 'city', l.city, 'state', l.state, 'zip', l.zip,
        'economy', l.economy, 'premium_hm', l.premium_hm,
        'premium_full_synthetic', l.premium_full_synthetic,
        'premium_full_synthetic_hm', l.premium_full_synthetic_hm, 'rp', l.rp
      ) ORDER BY l.name)
      FROM core.locations l
      WHERE l.company_id = v_link.company_id AND l.active
        AND trim(COALESCE(l.owner, '')) IS DISTINCT FROM 'Corporate'
    ), '[]'::jsonb),
    'packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(mp) - 'company_id' - 'updated_by' - 'created_at' - 'updated_at' ORDER BY mp.sort_order)
      FROM marketing.menu_board_packages mp WHERE mp.company_id = v_link.company_id
    ), '[]'::jsonb),
    'quart_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('package_key', d.package_key, 'price_per_quart', d.price_per_quart, 'included_quarts', d.included_quarts))
      FROM marketing.menu_board_quart_defaults d WHERE d.company_id = v_link.company_id
    ), '[]'::jsonb)
  );
END;
$function$;

-- create_franchise_menu_share_via_setup_link: gains a new p_quart_prices
-- jsonb param (package_key -> price_per_quart, only keys the franchisee
-- actually entered -- optional, never required to generate). Parameter
-- list changed, so CREATE OR REPLACE alone would just add a second
-- overload rather than replacing the old one -- drop the old signature
-- first. Re-checks the link's OWN allow_quart_pricing flag server-side
-- (never trusts the client's-eye view of whether the toggle was on) and
-- discards any submitted quart prices if it's off.
DROP FUNCTION IF EXISTS public.create_franchise_menu_share_via_setup_link(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text
);

CREATE OR REPLACE FUNCTION public.create_franchise_menu_share_via_setup_link(
  p_token uuid,
  p_location_id uuid,
  p_price_economy numeric,
  p_price_premium_hm numeric,
  p_price_premium_full_synthetic numeric,
  p_price_premium_full_synthetic_hm numeric,
  p_price_rp numeric,
  p_shop_supply_fee numeric,
  p_disposal_fee numeric,
  p_oil_inflation_surcharge numeric,
  p_fees_included boolean,
  p_address text,
  p_quart_prices jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link marketing.franchise_setup_links%ROWTYPE;
  v_loc core.locations%ROWTYPE;
  v_base text;
  v_slug text;
  v_quart_prices jsonb;
  i int;
BEGIN
  SELECT * INTO v_link
  FROM marketing.franchise_setup_links
  WHERE token = p_token AND active;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_loc FROM core.locations
  WHERE id = p_location_id AND company_id = v_link.company_id AND active
    AND trim(COALESCE(owner, '')) IS DISTINCT FROM 'Corporate';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_location');
  END IF;

  IF p_price_economy IS NULL OR p_price_premium_hm IS NULL OR p_price_premium_full_synthetic IS NULL
     OR p_price_premium_full_synthetic_hm IS NULL OR p_price_rp IS NULL THEN
    RETURN jsonb_build_object('error', 'missing_price');
  END IF;

  v_quart_prices := CASE WHEN v_link.allow_quart_pricing THEN p_quart_prices ELSE NULL END;

  -- Same <shop number>-<4-char hash> shape as makeLockedShareSlug() (client
  -- side, used by the internal admin flow and Shop Links' bulk-ensure) --
  -- reimplemented here since this path has no client JS to call it from.
  v_base := trim(both '-' from lower(regexp_replace(trim(v_loc.name), '[^a-z0-9]+', '-', 'g')));

  FOR i IN 1..3 LOOP
    v_slug := CASE WHEN v_base = '' THEN NULL ELSE v_base || '-' || substr(md5(random()::text), 1, 4) END;
    IF v_slug IS NULL THEN
      RETURN jsonb_build_object('error', 'invalid_shop_name');
    END IF;

    BEGIN
      INSERT INTO marketing.franchise_menu_shares (
        company_id, location_id, slug,
        price_economy, price_premium_hm, price_premium_full_synthetic, price_premium_full_synthetic_hm, price_rp,
        shop_supply_fee, disposal_fee, oil_inflation_surcharge, fees_included_in_pricing,
        address, quart_prices, created_by
      ) VALUES (
        v_link.company_id, p_location_id, v_slug,
        p_price_economy, p_price_premium_hm, p_price_premium_full_synthetic, p_price_premium_full_synthetic_hm, p_price_rp,
        p_shop_supply_fee, p_disposal_fee, p_oil_inflation_surcharge, COALESCE(p_fees_included, false),
        p_address, v_quart_prices, NULL
      );
      RETURN jsonb_build_object('slug', v_slug);
    EXCEPTION WHEN unique_violation THEN
      -- slug collision (astronomically unlikely) -- retry with a fresh hash
      CONTINUE;
    END;
  END LOOP;

  RETURN jsonb_build_object('error', 'slug_collision');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_franchise_menu_share_via_setup_link(
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, jsonb
) TO anon, authenticated;

-- get_franchise_menu_share_by_slug: expose the confirmed per-quart price
-- overrides (if any) so the public board page can prefer them over the
-- company-wide menu_board_quart_defaults, same override precedence
-- menu_board_quart_overrides already uses for the regular (non-franchise)
-- share system.
CREATE OR REPLACE FUNCTION public.get_franchise_menu_share_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_share marketing.franchise_menu_shares%ROWTYPE;
  v_loc   core.locations%ROWTYPE;
BEGIN
  SELECT * INTO v_share FROM marketing.franchise_menu_shares WHERE slug = p_slug AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_loc FROM core.locations WHERE id = v_share.location_id;

  RETURN jsonb_build_object(
    'location_id', v_share.location_id,
    'name', v_loc.name,
    'shop_city', v_loc.shop_city,
    'address', v_share.address,
    'prices', jsonb_build_object(
      'economy', v_share.price_economy,
      'premium_hm', v_share.price_premium_hm,
      'premium_full_synthetic', v_share.price_premium_full_synthetic,
      'premium_full_synthetic_hm', v_share.price_premium_full_synthetic_hm,
      'rp', v_share.price_rp
    ),
    'shop_supply_fee', v_share.shop_supply_fee,
    'disposal_fee', v_share.disposal_fee,
    'oil_inflation_surcharge', v_share.oil_inflation_surcharge,
    'fees_included_in_pricing', v_share.fees_included_in_pricing,
    'quart_price_overrides', COALESCE(v_share.quart_prices, '{}'::jsonb),
    'packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(mp) - 'company_id' - 'updated_by' - 'created_at' - 'updated_at' ORDER BY mp.sort_order)
      FROM marketing.menu_board_packages mp WHERE mp.company_id = v_share.company_id
    ), '[]'::jsonb),
    'quart_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('package_key', d.package_key, 'price_per_quart', d.price_per_quart, 'included_quarts', d.included_quarts))
      FROM marketing.menu_board_quart_defaults d WHERE d.company_id = v_share.company_id
    ), '[]'::jsonb)
  );
END;
$function$;
