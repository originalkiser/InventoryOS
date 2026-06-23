-- Aggregate count_products by (location_id, product_id) for a given company + period.
-- Called via supabase.rpc('get_aggregated_monthly_products', {...}).
CREATE OR REPLACE FUNCTION public.get_aggregated_monthly_products(
  p_company_id uuid,
  p_count_month text
)
RETURNS TABLE (
  location_id uuid,
  product_id text,
  category text,
  on_hand numeric,
  sold numeric,
  adjusted numeric,
  ending_value numeric,
  batch_count bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    cp.location_id,
    cp.product_id::text,
    MAX(cp.category)::text AS category,
    SUM(COALESCE(cp.on_hand, 0))::numeric AS on_hand,
    SUM(COALESCE(cp.sold, 0))::numeric AS sold,
    SUM(COALESCE(cp.adjusted, 0))::numeric AS adjusted,
    SUM(COALESCE(cp.ending_value, 0))::numeric AS ending_value,
    COUNT(DISTINCT cp.upload_batch_id)::bigint AS batch_count
  FROM inventory.count_products cp
  WHERE cp.company_id = p_company_id
    AND cp.count_month = p_count_month
  GROUP BY cp.location_id, cp.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_aggregated_monthly_products(uuid, text) TO authenticated;
