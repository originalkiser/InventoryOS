-- Orders v2 usage input: product_usage.daily_usage is a rolling rate that only refreshes when a product gets a fresh
-- Droptop touch, so a product with real sales in the last 30 days can still read null/0 there (502 shop/product pairs at
-- the time of writing). Fall back to the day-by-day ledger (daily_product_activity.sold_qty, trailing 30 days / 30 — the
-- same rate droptop-sync-usage itself computes) whenever the stored rate is null or 0, so even small recent usage reaches
-- the order (and the case-type combine) instead of reading as zero. A real positive stored rate always wins.
CREATE OR REPLACE FUNCTION public.get_ov2_usage_for_families(p_families text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET statement_timeout = '60s'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'location_id', u.location_id, 'product_id', u.product_id, 'on_hands', u.on_hands,
    'daily_usage', CASE WHEN COALESCE(u.daily_usage, 0) > 0 THEN u.daily_usage ELSE COALESCE(NULLIF(l.sold, 0) / 30.0, u.daily_usage) END)), '[]'::jsonb)
  FROM inventory.product_usage u
  LEFT JOIN LATERAL (
    SELECT sum(a.sold_qty) AS sold
    FROM inventory.daily_product_activity a
    WHERE COALESCE(u.daily_usage, 0) = 0
      AND a.company_id = u.company_id AND a.location_id = u.location_id AND a.product_id = u.product_id
      AND a.activity_date >= current_date - 29
  ) l ON true
  WHERE u.product_id ILIKE ANY (
    ARRAY(SELECT replace(replace(replace(f, '\', '\'), '%', '\%'), '_', '\_') || '%' FROM unnest(p_families) AS f)
  )
$$;
GRANT EXECUTE ON FUNCTION public.get_ov2_usage_for_families(text[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
