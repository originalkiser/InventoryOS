-- One-time data seed: droptop_order_sync_state only ever gets written by
-- mode:'incremental' runs, but the historical company-wide backfill used
-- mode:'sync' — so every location currently has zero tracked sync state.
-- Without this, the very first real incremental run (scheduled or manual
-- "Run Now") would fall back to a full 30-day catch-up for all 85 shops,
-- silently repeating the exact load that caused the 2026-09-01 app-slowdown
-- incident, just through a different code path.
--
-- Seeds last_synced_date to the day BEFORE each location's latest known
-- order date, not the latest date itself — the historical backfill's
-- snapshot moment may have only captured part of that final day (e.g. a
-- location processed at 1pm only has orders up to 1pm for "today"), so
-- starting incremental sync one day earlier guarantees that day gets
-- re-fetched in full rather than risking a few hours' gap. Re-fetching one
-- extra day is idempotent (upserted by order_id) and cheap.
--
-- ON CONFLICT + LEAST is a non-destructive merge: if a location already has
-- real tracked state (e.g. from a manual incremental run since this went
-- live), this only pulls it earlier/more-conservative, never forward past
-- confirmed progress.
INSERT INTO inventory.droptop_order_sync_state (company_id, location_id, last_synced_date, updated_at)
SELECT
  o.company_id,
  o.location_id,
  (MAX(o.order_finalized_at)::date - INTERVAL '1 day')::date AS last_synced_date,
  now()
FROM inventory.droptop_orders o
WHERE o.location_id IS NOT NULL AND o.order_finalized_at IS NOT NULL
GROUP BY o.company_id, o.location_id
ON CONFLICT (company_id, location_id) DO UPDATE
SET last_synced_date = LEAST(inventory.droptop_order_sync_state.last_synced_date, EXCLUDED.last_synced_date),
    updated_at = now();
