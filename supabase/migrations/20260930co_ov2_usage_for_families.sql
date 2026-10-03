-- Orders v2 "Loading order data" hang (direct report 2026-10-03: stuck at 14 of 16).
-- fetchInputs() pulled product_usage for the order-config product families as ~60
-- "product_id ILIKE 'family%'" ORs, paged with ORDER BY id + OFFSET. Planner walks the
-- primary key for that ordering and throws away ~238k non-matching rows on every deep
-- page (7.8s measured at offset 6000, ~28s total across the ~9 pages, far worse when the
-- database is busy) — that was the "hung" last source. One set-based call instead: the
-- trigram index serves the whole thing in ~0.3s. Returns a single jsonb array (no
-- PostgREST 1000-row cap to page around); company scoping comes from RLS.
CREATE OR REPLACE FUNCTION public.get_ov2_usage_for_families(p_families text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET statement_timeout = '60s'
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'location_id', u.location_id, 'product_id', u.product_id, 'on_hands', u.on_hands, 'daily_usage', u.daily_usage)), '[]'::jsonb)
  FROM inventory.product_usage u
  WHERE u.product_id ILIKE ANY (
    ARRAY(SELECT replace(replace(replace(f, '\', '\'), '%', '\%'), '_', '\_') || '%' FROM unnest(p_families) AS f)
  )
$$;
GRANT EXECUTE ON FUNCTION public.get_ov2_usage_for_families(text[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
