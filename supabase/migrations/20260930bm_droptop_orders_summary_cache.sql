-- Direct feedback 2026-09-24 on the summary stats RPC (20260930bl):
-- "the pre-filled periods should boast quicker loading times, can we cache
-- that data daily so if we are pulling week to date or last week or last 7
-- days or whatever of the prefilled periods, it can just drop the cached
-- totals right in?"
--
-- inventory.droptop_orders_summary_cache holds one row per (company,
-- named period, calendar day) — the FULL jsonb payload
-- get_droptop_orders_summary_stats(..., p_location_ids => NULL) returns
-- for that period, company-wide (no shop/region/market/AM restriction).
-- Scoped to company-wide only, deliberately: caching per exact shop-scope
-- combination is unbounded (any Region/Market/AM/Shop(s) selection), while
-- an already-narrowed pull is a much smaller/faster query anyway (see
-- 20260930bl's own real-data timing: ~14s for a 7-day/40k-order range vs.
-- the ~30s-1:30 company-wide 30-day range this is actually solving for).
-- `custom` ranges are never cached — a custom start/end pair isn't one of
-- the "prefilled periods" this was asked for, and two different custom
-- calls are rarely the exact same range anyway.
--
-- get_droptop_orders_summary_stats_cached() wraps the existing function:
-- a cache hit for TODAY returns instantly; a miss computes live (paying
-- the real 20260930bl cost once) and stores the result for every other
-- request of that same period for the rest of today. This is a genuinely
-- "once per day" cache, not a live/streaming one — a period that includes
-- TODAY (Week to Date, Month to Date, Last 3 Months) will show the count
-- as of whenever it was FIRST computed today, not update again until
-- tomorrow, even as more orders come in during the day. Accepted as the
-- literal ask ("cache daily") rather than a shorter TTL — flagged here in
-- case same-day freshness for those specific periods turns out to matter
-- more than the load-time win.
CREATE TABLE IF NOT EXISTS inventory.droptop_orders_summary_cache (
  company_id uuid NOT NULL,
  period_key text NOT NULL,
  computed_date date NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period_key, computed_date)
);

CREATE OR REPLACE FUNCTION public.get_droptop_orders_summary_stats_cached(
  p_company_id uuid,
  p_period_key text,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_cached jsonb;
  v_result jsonb;
BEGIN
  IF p_period_key <> 'custom' THEN
    SELECT payload INTO v_cached
    FROM inventory.droptop_orders_summary_cache
    WHERE company_id = p_company_id AND period_key = p_period_key AND computed_date = current_date;
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  v_result := public.get_droptop_orders_summary_stats(p_company_id, p_start, p_end, NULL);

  IF p_period_key <> 'custom' THEN
    INSERT INTO inventory.droptop_orders_summary_cache (company_id, period_key, computed_date, payload)
    VALUES (p_company_id, p_period_key, current_date, v_result)
    ON CONFLICT (company_id, period_key, computed_date)
    DO UPDATE SET payload = excluded.payload, computed_at = now();
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_orders_summary_stats_cached TO authenticated;
GRANT SELECT, INSERT, UPDATE ON inventory.droptop_orders_summary_cache TO authenticated;
