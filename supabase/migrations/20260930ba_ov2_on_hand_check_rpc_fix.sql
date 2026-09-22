-- Corrects get_ov2_on_hand_check_data (20260930az, same day): its
-- on_hand_at_delivery lookup relied on inventory.daily_product_activity.
-- ending_on_hand, which turns out to be dead data in production — 0 of
-- 444,181 rows have it set, because the only code path that ever stamps
-- it (droptop-sync-usage's `if (logDailyActivity && mode === 'both')`)
-- never actually runs: the real scheduled connections always call this
-- function with mode 'inventory' or 'usage', never 'both'. Confirmed via a
-- direct count before trusting the column further.
--
-- Fixed design: instead of a historical on-hand SNAPSHOT (which doesn't
-- exist), use the on-hand value already recorded on the order line ITSELF
-- at the moment that order was generated — inventory.ov2_order_history_
-- lines.on_hand, a real number that's been captured for every order all
-- along, no new column needed. The plausibility check (in onHandCheck.ts)
-- tracks forward from THAT real baseline through today using real
-- sold_qty history (which IS populated correctly), rather than a second
-- estimate layered on top of a delivery-date snapshot:
--   expected_today = on_hand_when_ordered - sold_since_order_date + delivered_qty
-- This RPC now only supplies the one number that still has to come from
-- the daily ledger: total real sold_qty from just after the order date
-- through whatever's currently in the table (effectively "through today").
DROP FUNCTION IF EXISTS public.get_ov2_on_hand_check_data(jsonb);

CREATE FUNCTION public.get_ov2_sold_since(p_pairs jsonb)
RETURNS TABLE (location_id uuid, product_id text, since_date date, sold_since numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH pairs AS (
    SELECT
      (p->>'location_id')::uuid AS location_id,
      (p->>'product_id')::text AS product_id,
      (p->>'since_date')::date AS since_date
    FROM jsonb_array_elements(p_pairs) AS p
  )
  SELECT
    pr.location_id, pr.product_id, pr.since_date,
    (SELECT sum(a.sold_qty) FROM inventory.daily_product_activity a
       WHERE a.company_id = get_my_company_id() AND a.location_id = pr.location_id AND a.product_id = pr.product_id
         AND a.activity_date > pr.since_date) AS sold_since
  FROM pairs pr
$$;
