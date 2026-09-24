-- Third function found reading inventory.count_products with the same
-- missing-dedup vulnerability as 20260930bj (get_current_oil_on_hand_value /
-- get_current_balance_by_category) — get_aggregated_monthly_products backs
-- Month End's own CountsTab.tsx product-level table (the "Product Load" that
-- feeds Counts tab rows), so the same 2026-09-24 duplicate-row incident
-- (droptop-sync-usage's unchecked delete, see 20260930bj's own header
-- comment) was ALSO inflating on_hand/ending_value here — confirmed live:
-- shop 159-Sylva's SYN-0W20 read on_hand=3654.00 (batch_count=1, i.e. still
-- one batch — the duplication is rows within that one batch) before this
-- fix, vs. its real latest-day value.
--
-- Unlike the other two functions, this one is NOT a pure "current snapshot"
-- read — sold/adjusted are true FLOW quantities that can legitimately come
-- from more than one genuinely distinct source within a month (e.g. a
-- manual Product Detail re-upload layered on top of the Droptop daily feed,
-- confirmed via ProductDetailUpload.tsx: each manual upload gets its own
-- fresh upload_batch_id, unlike the daily feed's one reused batch) — that's
-- exactly what batch_count is for, and summing sold/adjusted across batches
-- stays correct. on_hand/ending_value are the same snapshot-not-flow value
-- as the other two functions though (droptop-sync-usage's own on_hand
-- write is a point-in-time snapshot, never a delta) — those two columns
-- alone are now taken from the newest row per (location, product) instead
-- of summed, exactly like 20260930bj. For today's specific incident this
-- changes nothing about sold/adjusted (the duplicated Droptop-feed rows
-- never set either column, both are 0 on every affected row), so this
-- split doesn't need to be revisited for the current cleanup — only
-- flagged here as a real design distinction from the other two fixes.
CREATE OR REPLACE FUNCTION public.get_aggregated_monthly_products(p_company_id uuid, p_count_month text)
 RETURNS TABLE(location_id uuid, product_id text, category text, on_hand numeric, sold numeric, adjusted numeric, ending_value numeric, batch_count bigint)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (cp.location_id, cp.product_id)
      cp.location_id, cp.product_id, cp.category, cp.on_hand, cp.ending_value
    FROM inventory.count_products cp
    WHERE cp.company_id  = p_company_id
      AND cp.count_month = p_count_month::date
    ORDER BY cp.location_id, cp.product_id, cp.created_at DESC
  ),
  flows AS (
    SELECT
      cp.location_id,
      cp.product_id,
      SUM(COALESCE(cp.sold, 0))::numeric      AS sold,
      SUM(COALESCE(cp.adjusted, 0))::numeric  AS adjusted,
      COUNT(DISTINCT cp.upload_batch_id)::bigint AS batch_count
    FROM inventory.count_products cp
    WHERE cp.company_id  = p_company_id
      AND cp.count_month = p_count_month::date
    GROUP BY cp.location_id, cp.product_id
  )
  SELECT
    l.location_id,
    l.product_id::text,
    l.category::text,
    COALESCE(l.on_hand, 0)::numeric       AS on_hand,
    COALESCE(f.sold, 0)                   AS sold,
    COALESCE(f.adjusted, 0)               AS adjusted,
    COALESCE(l.ending_value, 0)::numeric  AS ending_value,
    COALESCE(f.batch_count, 1)            AS batch_count
  FROM latest l
  LEFT JOIN flows f ON f.location_id = l.location_id AND f.product_id = l.product_id
$function$;
