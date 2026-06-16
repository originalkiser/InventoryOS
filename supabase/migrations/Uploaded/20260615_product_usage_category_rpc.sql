-- 1. Category on product usage rows
ALTER TABLE product_usage
  ADD COLUMN IF NOT EXISTS category text;

-- 2. Single-call full-table fetch to replace 256 sequential 1000-row pages.
--    Returns every row for the company ordered by product then location.
CREATE OR REPLACE FUNCTION get_product_usage(p_company_id uuid)
RETURNS TABLE(
  id                  uuid,
  location_id         uuid,
  product_id          text,
  category            text,
  daily_usage         numeric,
  on_hands            numeric,
  days_of_supply      numeric,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz,
  updated_at          timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    id, location_id, product_id,
    NULLIF(TRIM(COALESCE(category, '')), '') AS category,
    daily_usage, on_hands, days_of_supply,
    updated_by, last_change_source, created_at, updated_at
  FROM product_usage
  WHERE company_id = p_company_id
  ORDER BY product_id, location_id NULLS LAST;
$$;
