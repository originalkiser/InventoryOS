-- Per-link toggle to omit the page-2 staff reference sheet from a menu
-- board share (public web view, the PDF download, and the printed board
-- itself all read this the same way — false/NULL preserves today's
-- behavior of always showing page 2).

ALTER TABLE marketing.menu_board_shares
  ADD COLUMN IF NOT EXISTS hide_page2 boolean NOT NULL DEFAULT false;

-- get_menu_board_share_by_slug delegates to this, so it picks up the new
-- field with no changes of its own.
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
    'hide_page2', v_share.hide_page2,
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

GRANT EXECUTE ON FUNCTION public.get_menu_board_share(uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
