-- Franchise Menu Board sharing (2026-09-18 request) — a deliberately
-- SEPARATE table from marketing.menu_board_shares, not a variant of it.
-- A regular share always reflects core.locations' LIVE price columns at
-- whatever moment a viewer loads the page; a franchise link is the
-- opposite by design — the franchisee confirms a specific price (base +
-- which fees are folded in) ONCE at generation time, and that confirmed
-- snapshot is what keeps showing regardless of later location-list edits.
-- Storing it as its own table also trivially satisfies "never show these
-- in the regular Shop Links list" — it's simply never queried there.
CREATE TABLE marketing.franchise_menu_shares (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES core.locations(id),
  -- forms.sboc.app-style pretty link: fzmenu.sboc.app/:slug — same
  -- <shop number>-<hash> shape as menu_board_shares' own locked slugs
  -- (makeLockedShareSlug), but GLOBALLY unique (not company-scoped): the
  -- fzmenu.sboc.app/:slug URL space has no company qualifier in it.
  slug text NOT NULL,
  -- Confirmed pricing snapshot for the 5 canonical board packages — column
  -- names deliberately mirror core.locations' own (economy, premium_hm,
  -- premium_full_synthetic, premium_full_synthetic_hm, rp) so the
  -- auto-populate step is a direct copy, not a remapping.
  price_economy numeric NOT NULL,
  price_premium_hm numeric NOT NULL,
  price_premium_full_synthetic numeric NOT NULL,
  price_premium_full_synthetic_hm numeric NOT NULL,
  price_rp numeric NOT NULL,
  shop_supply_fee numeric,
  disposal_fee numeric,
  oil_inflation_surcharge numeric,
  -- Whether the 3 fees above are folded into the displayed package prices
  -- (computed at render time, never stored pre-added) or left off, showing
  -- pure base pricing.
  fees_included_in_pricing boolean NOT NULL DEFAULT false,
  -- Snapshotted alongside pricing rather than re-read live from
  -- core.locations on every board view, for the same "confirmed once"
  -- reasoning as the prices above.
  address text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX franchise_menu_shares_slug_key ON marketing.franchise_menu_shares (slug);
CREATE INDEX franchise_menu_shares_company_idx ON marketing.franchise_menu_shares (company_id);

ALTER TABLE marketing.franchise_menu_shares ENABLE ROW LEVEL SECURITY;

-- Same shape as menu_board_shares' own policies (direct user_profiles
-- subquery, not get_my_company_id() — matching that table's own existing
-- convention rather than introducing a second style within this schema).
CREATE POLICY "franchise_menu_shares_manage" ON marketing.franchise_menu_shares
  FOR ALL USING (company_id = (SELECT user_profiles.company_id FROM platform.user_profiles WHERE user_profiles.id = auth.uid()))
  WITH CHECK (company_id = (SELECT user_profiles.company_id FROM platform.user_profiles WHERE user_profiles.id = auth.uid()));

-- Public, no-auth lookup for the fzmenu.sboc.app subdomain — same
-- SECURITY DEFINER / public-schema-function pattern as
-- get_menu_board_share_by_slug, returning everything the Board component
-- needs in one call. Franchise boards intentionally never use per-shop
-- quart-price overrides (out of scope for this feature, see request) —
-- only the company-wide menu_board_quart_defaults.
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
