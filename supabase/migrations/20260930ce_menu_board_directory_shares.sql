-- Shareable, no-login "Shop Links" directory (direct ask 2026-10-02): the
-- Menu Board > Shop Links table — every active shop's board link, PDF link
-- and contact/market info — as a public page at
-- menu.sboc.app/directory/<token>, so the project management team can
-- distribute links as new shops come online.
--
-- Public access is ONLY through get_menu_board_directory(p_token), a
-- SECURITY DEFINER RPC with an explicit column whitelist (same convention as
-- every other public RPC in this module). The table itself stays RLS-locked.
-- Shop/AM emails are opt-in per link (include_emails, default false).
--
-- "Live": the RPC also mints a locked share (slug included) for any active
-- shop that doesn't have one yet — and backfills a missing slug — so a shop
-- that came online since the last time anyone opened the admin Shop Links
-- tab still shows up with working links, with no admin step in between.

CREATE TABLE IF NOT EXISTS marketing.menu_board_directory_shares (
  token          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  label          text,
  include_emails boolean     NOT NULL DEFAULT false,
  active         boolean     NOT NULL DEFAULT true,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing.menu_board_directory_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "menu_board_directory_shares_select" ON marketing.menu_board_directory_shares;
CREATE POLICY "menu_board_directory_shares_select" ON marketing.menu_board_directory_shares FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "menu_board_directory_shares_manage" ON marketing.menu_board_directory_shares;
CREATE POLICY "menu_board_directory_shares_manage" ON marketing.menu_board_directory_shares FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing.menu_board_directory_shares TO authenticated;

CREATE OR REPLACE FUNCTION public.get_menu_board_directory(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v        marketing.menu_board_directory_shares%ROWTYPE;
  r        record;
  v_base   text;
  v_try    int;
BEGIN
  SELECT * INTO v FROM marketing.menu_board_directory_shares WHERE token = p_token AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Shops with no active locked share yet: mint one (slug = <shop number>-<4 hex>,
  -- retried on the rare company-unique slug collision).
  FOR r IN
    SELECT l.id, l.name, l.shop_city
    FROM core.locations l
    WHERE l.company_id = v.company_id AND l.active
      AND NOT EXISTS (SELECT 1 FROM marketing.menu_board_shares s WHERE s.location_id = l.id AND s.active)
  LOOP
    v_base := trim(both '-' from regexp_replace(lower(coalesce(r.name, '')), '[^a-z0-9]+', '-', 'g'));
    FOR v_try IN 1..5 LOOP
      BEGIN
        INSERT INTO marketing.menu_board_shares (company_id, location_id, label, slug)
        VALUES (v.company_id, r.id, coalesce(r.shop_city, r.name),
                CASE WHEN v_base = '' THEN NULL ELSE v_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4) END);
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END LOOP;
  END LOOP;

  -- Older locked shares that predate slug support: back-fill one (the PDF
  -- route only understands slugs).
  FOR r IN
    SELECT s.token, l.name
    FROM marketing.menu_board_shares s
    JOIN core.locations l ON l.id = s.location_id
    WHERE s.company_id = v.company_id AND s.active AND s.slug IS NULL AND l.active
  LOOP
    v_base := trim(both '-' from regexp_replace(lower(coalesce(r.name, '')), '[^a-z0-9]+', '-', 'g'));
    CONTINUE WHEN v_base = '';
    FOR v_try IN 1..5 LOOP
      BEGIN
        UPDATE marketing.menu_board_shares
           SET slug = v_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4)
         WHERE token = r.token;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'label', v.label,
    'include_emails', v.include_emails,
    'shops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', l.name,
        'shop_city', l.shop_city,
        'city', l.city,
        'state', l.state,
        'market', l.market,
        'owner', CASE WHEN trim(coalesce(l.owner, '')) = '' THEN '' WHEN trim(l.owner) = 'Corporate' THEN 'Corporate' ELSE 'Franchise' END,
        'regional_director', l.director,
        'area_manager', l.area_manager,
        'store_email', CASE WHEN v.include_emails THEN l.store_email END,
        'am_email', CASE WHEN v.include_emails THEN l.am_email END,
        'slug', t.slug,
        'hide_page2', t.hide_page2
      ) ORDER BY l.name)
      FROM core.locations l
      JOIN LATERAL (
        SELECT s.slug, s.hide_page2
        FROM marketing.menu_board_shares s
        WHERE s.location_id = l.id AND s.active
        ORDER BY s.created_at DESC
        LIMIT 1
      ) t ON true
      WHERE l.company_id = v.company_id AND l.active
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_menu_board_directory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_menu_board_directory(uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
