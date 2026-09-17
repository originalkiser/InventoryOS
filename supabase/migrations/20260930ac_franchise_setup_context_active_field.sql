-- Fix: the franchisee setup page's shop dropdown showed "No results" even
-- though get_franchise_setup_context (20260930ab) really was returning real
-- shops -- confirmed directly via an anonymous curl call before this ever
-- shipped. Not an RLS problem (this is a SECURITY DEFINER function that
-- already bypasses RLS entirely, which is exactly what that earlier test
-- proved). The RPC's WHERE clause already filters to l.active = true, but
-- the returned shop object never actually included an `active` field at
-- all -- and FranchiseMenuForm's own franchiseShopOptions filter is
-- `l.active && ownerBucket(...)`, so every shop's `l.active` read as
-- `undefined` (falsy) and got dropped, leaving an empty dropdown despite
-- correct underlying data.
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
        'id', l.id, 'name', l.name, 'shop_city', l.shop_city, 'owner', l.owner, 'active', l.active,
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
