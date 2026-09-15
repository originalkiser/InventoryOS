-- Product Usage (Global Config) loads inventory.product_usage's ENTIRE
-- company-wide table (~300k rows today) one keyset page at a time on every
-- visit — found live 2026-09-15 from a user-supplied .har: 69 sequential
-- GET+OPTIONS round trips, ~350ms each, over 20+ real seconds (and the user
-- reports over a minute end to end). Sequential keyset (WHERE id > cursor)
-- pagination is the correct fix for a much older bug (OFFSET pagination
-- timing out around offset 59000 on this same table, see ProductUsageTab.tsx's
-- own loadRpc() comment) and stays — the actual fix here is to stop pulling
-- every category by default at all: confirmed against production that
-- Engine Oil + Engine Oil Additive together are only 12,000 of the table's
-- 299,550 rows (96% is other categories this tab doesn't default to).
--
-- This RPC backs the category picker so a company can still add other
-- categories to what loads — it needs the FULL distinct list regardless of
-- whatever's currently in scope, which a plain client-side `Array.from(new
-- Set(loadedRows.map(...)))` can't provide once the default load itself is
-- scoped. Same one-time full-table-scan-for-a-picker-list precedent as
-- get_droptop_package_name_counts/get_product_sales_history_product_counts —
-- SECURITY INVOKER, so the caller's own RLS on product_usage scopes this to
-- their own company with no company_id argument needed or trusted.
CREATE OR REPLACE FUNCTION public.get_product_usage_category_counts()
RETURNS TABLE (category text, row_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT u.category, count(*) AS row_count
  FROM inventory.product_usage u
  WHERE u.category IS NOT NULL AND u.category <> ''
  GROUP BY u.category
  ORDER BY row_count DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_product_usage_category_counts() TO authenticated;
