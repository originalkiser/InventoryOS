-- Correction to 20260930aq: real production data showed 3 separate
-- droptop_orders backfill job rows (restarted across today's fixes) —
-- picking only the MOST RECENT by created_at understated real coverage,
-- since a fresh restart begins a new walk from "now" even though an OLDER
-- (now completed/stopped) job had already verified months further back
-- still sitting in the table. Taking MIN(complete_from) across every job
-- row for this connection+company gives credit for every attempt's real,
-- already-verified progress, not just the current one's — still safe
-- (never overstates: each job's own month_pending_ids-gated guarantee is
-- independently correct) and strictly more accurate. status/months_pulled
-- stay scoped to the single most recent job row (informational "what's
-- happening now" context, not part of the safety guarantee).
CREATE OR REPLACE FUNCTION public.get_droptop_backfill_completeness(p_connection_key text)
RETURNS TABLE (complete_from date, status text, months_pulled integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH per_job AS (
    SELECT
      j.created_at,
      j.status,
      j.months_pulled,
      CASE
        WHEN j.cursor_month IS NULL THEN NULL
        WHEN j.month_pending_ids IS NULL THEN j.cursor_month
        ELSE (j.cursor_month + INTERVAL '1 month')::date
      END AS job_complete_from
    FROM inventory.data_connection_backfill_jobs j
    WHERE j.connection_key = p_connection_key
      AND j.company_id = get_my_company_id()
  )
  SELECT
    (SELECT MIN(job_complete_from) FROM per_job) AS complete_from,
    (SELECT status FROM per_job ORDER BY created_at DESC LIMIT 1) AS status,
    (SELECT months_pulled FROM per_job ORDER BY created_at DESC LIMIT 1) AS months_pulled
$$;
