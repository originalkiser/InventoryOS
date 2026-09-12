-- Backs menu.sboc.app's bare-root landing page (NearestMenuBoardPage.tsx):
-- lets a visitor's browser geolocation resolve straight to the nearest
-- shop's board instead of needing a specific share link. Returns every
-- active shop's locked-share slug + coordinates (nothing more sensitive
-- than the existing "open" mode share already exposes for its shop
-- picker) — the client computes nearest via a plain Haversine calculation,
-- and falls back to letting the visitor pick from this same list manually
-- if geolocation is denied/unavailable, so no separate RPC is needed for
-- that fallback.

CREATE OR REPLACE FUNCTION public.get_menu_board_shop_list()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    -- DISTINCT ON (l.id): a shop with more than one active share (rare —
    -- e.g. a second one made by hand) resolves to its most recent, same
    -- as ShopLinksTab's own dedup logic.
    SELECT DISTINCT ON (l.id)
      s.slug,
      l.name, l.shop_city, l.address, l.city, l.state, l.zip,
      l.latitude, l.longitude
    FROM core.locations l
    JOIN marketing.menu_board_shares s ON s.location_id = l.id
    WHERE l.active AND s.active AND s.slug IS NOT NULL
    ORDER BY l.id, s.created_at DESC
  ) t
$$;

GRANT EXECUTE ON FUNCTION public.get_menu_board_shop_list() TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
