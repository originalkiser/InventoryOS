-- Same bug class as 20260930s, found by searching for other places doing
-- the "page through inventory.product_usage's full ~300k rows just to
-- dedupe one column for a picker" thing: ProductOnHandExceptionsPanel.tsx's
-- product-id picker paginated the WHOLE table (300 sequential range()
-- requests) to collect distinct product_id values, when there are only
-- 2,474 distinct ids in the whole table. Same precedent as
-- get_droptop_package_name_counts / get_product_usage_category_counts —
-- SECURITY INVOKER, the caller's own RLS scopes this to their own company.
CREATE OR REPLACE FUNCTION public.get_product_usage_product_id_counts()
RETURNS TABLE (product_id text, row_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT u.product_id, count(*) AS row_count
  FROM inventory.product_usage u
  WHERE u.product_id IS NOT NULL AND u.product_id <> ''
  GROUP BY u.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_product_usage_product_id_counts() TO authenticated;
