-- Fix "permission denied for table franchise_menu_shares" — the original
-- migration (20260930z) enabled RLS and added a policy but never GRANTed
-- table privileges to the authenticated role. Postgres checks table-level
-- GRANTs before RLS policies even run, so every query failed outright
-- regardless of the policy being correct — same GRANT shape as
-- marketing.menu_board_shares (20260921_menu_board_shares.sql).
GRANT SELECT, INSERT, UPDATE, DELETE ON marketing.franchise_menu_shares TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_franchise_menu_share_by_slug(text) TO anon, authenticated;
