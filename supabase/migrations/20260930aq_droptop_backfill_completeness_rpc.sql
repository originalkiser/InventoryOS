-- "Data back to [date]" completeness indicator (2026-09-20 request) — lets
-- report-facing pages tell a user how far back they can confidently run
-- Droptop-derived reporting without hitting partial-shop-coverage months.
--
-- Reads inventory.data_connection_backfill_jobs, whose month-walk backfill
-- (data-connection-backfill-dispatcher's tickMonthWalkJob) already
-- guarantees a month is never marked resolved until EVERY target shop has
-- data for it (month_pending_ids only goes back to null once fully
-- covered/pulled) — see that function's own header comment. That guarantee
-- is what makes this trustworthy: complete_from is never a month with
-- partial shop coverage.
--
-- month_pending_ids IS NULL is the real signal here, not the status column
-- — a job can reach status='completed' either by naturally finishing (only
-- ever set once the final month's pending list is also empty) or by a user
-- clicking Stop mid-month (BackgroundBackfillPanel's stop() just sets
-- status='completed' unconditionally, whether or not the current
-- cursor_month actually finished) per project memory. Checking
-- month_pending_ids directly instead of trusting the status string handles
-- both cases correctly: if the current cursor_month is still mid-pull when
-- stopped, this reports one month later as the safe boundary rather than
-- wrongly vouching for a month that's actually partial.
--
-- Everything more recent than the reported boundary, up to today, is
-- assumed covered by the existing routine incremental daily sync (a
-- separate, already-proven system) — this function only answers "how far
-- back does the historical backfill's own guarantee reach."
CREATE OR REPLACE FUNCTION public.get_droptop_backfill_completeness(p_connection_key text)
RETURNS TABLE (complete_from date, status text, months_pulled integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    CASE
      WHEN j.cursor_month IS NULL THEN NULL
      WHEN j.month_pending_ids IS NULL THEN j.cursor_month
      ELSE (j.cursor_month + INTERVAL '1 month')::date
    END AS complete_from,
    j.status,
    j.months_pulled
  FROM inventory.data_connection_backfill_jobs j
  WHERE j.connection_key = p_connection_key
    AND j.company_id = get_my_company_id()
  ORDER BY j.created_at DESC
  LIMIT 1
$$;
