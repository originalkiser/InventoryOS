-- Pretty share URLs for menu-board links: /menu-board/<shop>-<hash>
-- instead of /m/<uuid>. `slug` is optional and company-unique; the token
-- URL keeps working for links already handed out. The two slug RPCs just
-- resolve the slug to its token and delegate to the existing token RPCs.

ALTER TABLE marketing.menu_board_shares ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS menu_board_shares_company_slug_uk
  ON marketing.menu_board_shares (company_id, slug) WHERE slug IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_menu_board_share_by_slug(p_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token uuid;
BEGIN
  SELECT token INTO v_token
  FROM marketing.menu_board_shares
  WHERE slug = p_slug AND active
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN public.get_menu_board_share(v_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_menu_board_shop_by_slug(p_slug text, p_location_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token uuid;
BEGIN
  SELECT token INTO v_token
  FROM marketing.menu_board_shares
  WHERE slug = p_slug AND active
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  RETURN public.get_menu_board_shop(v_token, p_location_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_board_share_by_slug(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_menu_board_shop_by_slug(text, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
