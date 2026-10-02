-- Upcoming-shops share (follow-up, 2026-10-02): only list an upcoming shop once it has
-- at least one package price filled in on core.locations (economy, premium HM,
-- full synthetic, full synthetic HM, R&P, diesel syn blend, diesel full syn,
-- european). Fees alone don't count. Shops with no pricing yet are hidden — and
-- no board link is minted for them until pricing is entered.

CREATE OR REPLACE FUNCTION public.get_menu_board_directory(p_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v          marketing.menu_board_directory_shares%ROWTYPE;
  r          record;
  v_base     text;
  v_try      int;
  v_upcoming boolean;
BEGIN
  SELECT * INTO v FROM marketing.menu_board_directory_shares WHERE token = p_token AND active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  v_upcoming := (v.scope = 'upcoming');

  -- Shops in scope with no active locked share yet: mint one (slug =
  -- <shop number>-<4 hex>, retried on the rare company-unique collision).
  FOR r IN
    SELECT l.id, l.name, l.shop_city
    FROM core.locations l
    WHERE l.company_id = v.company_id
      AND CASE WHEN v_upcoming
               THEN (NOT l.active AND l.date_opened IS NULL
                     AND (l.economy IS NOT NULL OR l.premium_hm IS NOT NULL OR l.premium_full_synthetic IS NOT NULL OR l.premium_full_synthetic_hm IS NOT NULL
                          OR l.rp IS NOT NULL OR l.diesel_syn_blend IS NOT NULL OR l.diesel_full_syn IS NOT NULL OR l.european IS NOT NULL)
                     AND (v.group_filter IS NULL OR l.monday_group IS NULL OR l.monday_group ILIKE '%' || v.group_filter || '%'))
               ELSE l.active END
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
    WHERE s.company_id = v.company_id AND s.active AND s.slug IS NULL
      AND (l.active OR l.date_opened IS NULL)
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
    'scope', v.scope,
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
        'monday_group', l.monday_group,
        'prices', CASE WHEN v_upcoming THEN jsonb_build_object(
            'economy', l.economy, 'premium_hm', l.premium_hm,
            'premium_full_synthetic', l.premium_full_synthetic,
            'premium_full_synthetic_hm', l.premium_full_synthetic_hm,
            'rp', l.rp, 'diesel_syn_blend', l.diesel_syn_blend,
            'diesel_full_syn', l.diesel_full_syn, 'european', l.european,
            'supply_fee', l.supply_fee, 'disposal_fee', l.disposal_fee,
            'oil_inflation_surcharge', l.oil_inflation_surcharge) END,
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
      WHERE l.company_id = v.company_id
        AND CASE WHEN v_upcoming
                 THEN (NOT l.active AND l.date_opened IS NULL
                     AND (l.economy IS NOT NULL OR l.premium_hm IS NOT NULL OR l.premium_full_synthetic IS NOT NULL OR l.premium_full_synthetic_hm IS NOT NULL
                          OR l.rp IS NOT NULL OR l.diesel_syn_blend IS NOT NULL OR l.diesel_full_syn IS NOT NULL OR l.european IS NOT NULL)
                       AND (v.group_filter IS NULL OR l.monday_group IS NULL OR l.monday_group ILIKE '%' || v.group_filter || '%'))
                 ELSE l.active END
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_menu_board_directory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_menu_board_directory(uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
