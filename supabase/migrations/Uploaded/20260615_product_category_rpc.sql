-- 1. Category on product detail rows
ALTER TABLE monthly_count_products
  ADD COLUMN IF NOT EXISTS category text;

-- 2. Server-side aggregation to replace client-side GROUP BY.
--    256k raw rows -> a few thousand aggregated rows sent over the wire.
CREATE OR REPLACE FUNCTION get_aggregated_monthly_products(
  p_company_id  uuid,
  p_count_month text
)
RETURNS TABLE(
  location_id   uuid,
  product_id    text,
  category      text,
  on_hand       numeric,
  sold          numeric,
  adjusted      numeric,
  ending_value  numeric,
  batch_count   bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    location_id,
    product_id,
    NULLIF(TRIM(COALESCE(category, '')), '')  AS category,
    SUM(COALESCE(on_hand,       0))::numeric  AS on_hand,
    SUM(COALESCE(sold,          0))::numeric  AS sold,
    SUM(COALESCE(adjusted,      0))::numeric  AS adjusted,
    SUM(COALESCE(ending_value,  0))::numeric  AS ending_value,
    COUNT(*)::bigint                          AS batch_count
  FROM monthly_count_products
  WHERE company_id  = p_company_id
    AND count_month = p_count_month
  GROUP BY location_id, product_id, NULLIF(TRIM(COALESCE(category, '')), '')
  ORDER BY product_id, location_id NULLS LAST;
$$;
