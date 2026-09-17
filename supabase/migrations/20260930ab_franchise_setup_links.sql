-- Franchisee self-service setup links (2026-09-18 follow-up request) — an
-- admin mints a reusable link and hands it directly to a franchisee, who
-- opens it (no SB Net login) and builds their OWN shop's menu board through
-- the exact same form/preview/confirm flow the admin already uses
-- internally. Deliberately OPEN (not locked to one shop): the franchisee
-- picks their own shop from a dropdown of the company's open, non-corporate
-- shops, same eligibility rule FranchiseMenuForm already applies
-- client-side (ownerBucket(owner) !== 'Corporate' AND active) -- explicit
-- product decision to accept that anyone holding the link can see the full
-- list of open shop names, in exchange for needing only ONE link total
-- rather than minting + distributing one per shop.
--
-- Reusable, not one-time-use: a franchisee revisiting the same link (e.g. a
-- yearly price update) generates a brand NEW franchise_menu_shares snapshot
-- row each time they confirm -- this table only gates whether the SETUP
-- flow itself is reachable, it has no relationship to any one resulting
-- board link. Revoked the same way every other link in this module is
-- (active = false), never hard-deleted.
CREATE TABLE marketing.franchise_setup_links (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX franchise_setup_links_company_idx ON marketing.franchise_setup_links (company_id);

ALTER TABLE marketing.franchise_setup_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "franchise_setup_links_manage" ON marketing.franchise_setup_links
  FOR ALL USING (company_id = (SELECT user_profiles.company_id FROM platform.user_profiles WHERE user_profiles.id = auth.uid()))
  WITH CHECK (company_id = (SELECT user_profiles.company_id FROM platform.user_profiles WHERE user_profiles.id = auth.uid()));

-- Learned the hard way on franchise_menu_shares (20260930z/aa): RLS alone
-- does nothing without a base table GRANT -- Postgres checks the GRANT
-- before a policy ever runs, so a missing one fails as a flat "permission
-- denied for table" regardless of how correct the policy is.
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing.franchise_setup_links TO authenticated;

-- Public, no-auth read: everything the setup form needs to render for a
-- given link's company in one call -- the eligible (open, non-corporate,
-- active) shop list with their current base pricing (for auto-fill), plus
-- the company's package/quart-default registry (same shape
-- get_franchise_menu_share_by_slug already returns those two in). Returns
-- only the columns the form actually uses -- this is a public endpoint, no
-- raw_monday_data/metadata/etc. ever goes out here.
CREATE OR REPLACE FUNCTION public.get_franchise_setup_context(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id
  FROM marketing.franchise_setup_links
  WHERE token = p_token AND active;

  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  RETURN jsonb_build_object(
    'company_id', v_company_id,
    'shops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'shop_city', l.shop_city, 'owner', l.owner,
        'address', l.address, 'city', l.city, 'state', l.state, 'zip', l.zip,
        'economy', l.economy, 'premium_hm', l.premium_hm,
        'premium_full_synthetic', l.premium_full_synthetic,
        'premium_full_synthetic_hm', l.premium_full_synthetic_hm, 'rp', l.rp
      ) ORDER BY l.name)
      FROM core.locations l
      WHERE l.company_id = v_company_id AND l.active
        AND trim(COALESCE(l.owner, '')) IS DISTINCT FROM 'Corporate'
    ), '[]'::jsonb),
    'packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(mp) - 'company_id' - 'updated_by' - 'created_at' - 'updated_at' ORDER BY mp.sort_order)
      FROM marketing.menu_board_packages mp WHERE mp.company_id = v_company_id
    ), '[]'::jsonb),
    'quart_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('package_key', d.package_key, 'price_per_quart', d.price_per_quart, 'included_quarts', d.included_quarts))
      FROM marketing.menu_board_quart_defaults d WHERE d.company_id = v_company_id
    ), '[]'::jsonb)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_franchise_setup_context(uuid) TO anon, authenticated;

-- Public, no-auth write: the franchisee's own "Confirm & Generate" click.
-- Mirrors FranchiseConfirmModal's existing internal insert (same columns,
-- same slug shape/collision-retry) but has to happen server-side here --
-- an anonymous visitor has no session and no company_id to satisfy
-- franchise_menu_shares' own RLS policy, so this is a SECURITY DEFINER
-- function that resolves the company from the token and validates the
-- chosen shop belongs to it (and is still open/non-corporate/active) before
-- writing anything, rather than trusting whatever location_id the client
-- happens to send.
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
  p_address text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_company_id uuid;
  v_loc core.locations%ROWTYPE;
  v_base text;
  v_slug text;
  i int;
BEGIN
  SELECT company_id INTO v_company_id
  FROM marketing.franchise_setup_links
  WHERE token = p_token AND active;

  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT * INTO v_loc FROM core.locations
  WHERE id = p_location_id AND company_id = v_company_id AND active
    AND trim(COALESCE(owner, '')) IS DISTINCT FROM 'Corporate';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_location');
  END IF;

  IF p_price_economy IS NULL OR p_price_premium_hm IS NULL OR p_price_premium_full_synthetic IS NULL
     OR p_price_premium_full_synthetic_hm IS NULL OR p_price_rp IS NULL THEN
    RETURN jsonb_build_object('error', 'missing_price');
  END IF;

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
        address, created_by
      ) VALUES (
        v_company_id, p_location_id, v_slug,
        p_price_economy, p_price_premium_hm, p_price_premium_full_synthetic, p_price_premium_full_synthetic_hm, p_price_rp,
        p_shop_supply_fee, p_disposal_fee, p_oil_inflation_surcharge, COALESCE(p_fees_included, false),
        p_address, NULL
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
  uuid, uuid, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, boolean, text
) TO anon, authenticated;
