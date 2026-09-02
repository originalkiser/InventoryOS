-- Customer Heatmap — pre-aggregated zip rollups, so a period-preset load
-- (Last Month, This Month, etc.) doesn't have to scan the full
-- inventory.droptop_orders table just to get zip-level counts/avg-ticket.
-- Decision: nightly incremental refresh (Option 2 of 3 proposed — see
-- project_droptop_orders.md), fully decoupled from droptop-sync-orders so
-- the already-stabilized sync pipeline is never touched by this. Tradeoff
-- accepted: up to ~24h staleness, papered over client-side by falling back
-- to the existing raw-order query for any range that includes "today."
--
-- Grain matches what the heatmap's clustering already computes per zip:
-- one row per (company_id, location_id, zip, order_date). Aggregating
-- across location_id gives the "Total by Zip" view; the location_id column
-- itself already gives the "By Shop" view — no separate table needed for
-- either. lat/lng are carried on the row (same resolved-at-sync-time
-- values droptop_orders itself stores) so the client never needs a second
-- join to inventory.zip_centroids just to plot a rollup row.
--
-- Deliberately NOT storing a package-count breakdown here — that's only
-- ever used by Visits-by-Zip's export and the order modal, both of which
-- already do their own on-demand fetch straight from droptop_order_packages
-- (see CustomerHeatmapPage.tsx's fetchPackageNamesByOrderIds) and will
-- keep doing so regardless of what powers the map/table views.
CREATE TABLE IF NOT EXISTS inventory.heatmap_zip_rollups (
  company_id    uuid        NOT NULL,
  location_id   uuid        NOT NULL,
  zip           text        NOT NULL,
  order_date    date        NOT NULL,
  city          text,
  region        text,
  lat           numeric,
  lng           numeric,
  order_count   integer     NOT NULL DEFAULT 0,
  ticket_total  numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, location_id, zip, order_date)
);
CREATE INDEX IF NOT EXISTS idx_heatmap_zip_rollups_company_date
  ON inventory.heatmap_zip_rollups (company_id, order_date);

ALTER TABLE inventory.heatmap_zip_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "heatmap_zip_rollups_select" ON inventory.heatmap_zip_rollups;
CREATE POLICY "heatmap_zip_rollups_select" ON inventory.heatmap_zip_rollups FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function (and its RPC) only.

-- Same reporting access as inventory.droptop_orders itself (20260904/
-- 20260905) — this is the table a dashboard would actually want to query,
-- being the pre-aggregated version of the same data.
GRANT SELECT ON inventory.heatmap_zip_rollups TO powerbi_reader;

-- Global watermark for the nightly refresh job — a single row, not
-- per-company, since this deployment is single-tenant (every location
-- shares one company_id, same assumption skybitz-tank-sync already makes).
-- If a second company is ever onboarded, this needs to become per-company
-- before that matters.
CREATE TABLE IF NOT EXISTS inventory.heatmap_rollup_state (
  id                text        PRIMARY KEY DEFAULT 'singleton',
  last_watermark    timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  last_run_at       timestamptz,
  last_run_summary  jsonb
);
INSERT INTO inventory.heatmap_rollup_state (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
ALTER TABLE inventory.heatmap_rollup_state ENABLE ROW LEVEL SECURITY;
-- No SELECT policy — internal job-state row, not company-scoped data;
-- authenticated/anon get nothing, the service-role client (which bypasses
-- RLS entirely) is the only real reader/writer.

-- Recomputes rollups for every (company_id, location_id, order_date) combo
-- touched (inserted OR re-synced) since p_since, by droptop_orders.updated_at.
-- Delete-then-reinsert per touched combo rather than an upsert, so a
-- re-synced order that moved zips (a data correction) doesn't leave a
-- stale row behind under its old zip.
--
-- Bounds the "since" window with clock_timestamp() captured at entry so a
-- row updated mid-run (a sync landing at the same moment this job runs)
-- isn't missed: it'll just have updated_at past the returned watermark and
-- get picked up on the NEXT run instead, rather than possibly falling
-- between "already scanned" and "will scan" within this same call.
CREATE OR REPLACE FUNCTION public.refresh_heatmap_zip_rollups(p_since timestamptz)
RETURNS TABLE(dates_recomputed integer, rows_upserted integer, new_watermark timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run_started      timestamptz := clock_timestamp();
  v_dates_recomputed integer := 0;
  v_rows_upserted    integer := 0;
BEGIN
  CREATE TEMP TABLE touched_dates ON COMMIT DROP AS
  SELECT DISTINCT o.company_id, o.location_id,
         (o.order_finalized_at AT TIME ZONE 'UTC')::date AS order_date
  FROM inventory.droptop_orders o
  WHERE o.updated_at > p_since
    AND o.updated_at <= v_run_started
    AND o.order_finalized_at IS NOT NULL;

  SELECT count(*) INTO v_dates_recomputed FROM touched_dates;

  IF v_dates_recomputed = 0 THEN
    RETURN QUERY SELECT 0, 0, v_run_started;
    RETURN;
  END IF;

  DELETE FROM inventory.heatmap_zip_rollups r
  USING touched_dates t
  WHERE r.company_id = t.company_id
    AND r.location_id = t.location_id
    AND r.order_date = t.order_date;

  INSERT INTO inventory.heatmap_zip_rollups
    (company_id, location_id, zip, order_date, city, region, lat, lng, order_count, ticket_total, updated_at)
  SELECT
    o.company_id, o.location_id, o.zip,
    (o.order_finalized_at AT TIME ZONE 'UTC')::date,
    MAX(o.city), MAX(o.region), MAX(o.lat), MAX(o.lng),
    COUNT(*), SUM(COALESCE(o.final_price, 0)), now()
  FROM inventory.droptop_orders o
  JOIN touched_dates t
    ON t.company_id = o.company_id
   AND t.location_id = o.location_id
   AND t.order_date = (o.order_finalized_at AT TIME ZONE 'UTC')::date
  WHERE o.zip IS NOT NULL AND o.zip <> ''
  GROUP BY o.company_id, o.location_id, o.zip, (o.order_finalized_at AT TIME ZONE 'UTC')::date;

  GET DIAGNOSTICS v_rows_upserted = ROW_COUNT;

  RETURN QUERY SELECT v_dates_recomputed, v_rows_upserted, v_run_started;
END;
$$;

-- Callable only by the service-role Edge Function — never exposed to
-- authenticated users (unlike the read-only RPCs elsewhere in this repo).
REVOKE ALL ON FUNCTION public.refresh_heatmap_zip_rollups(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_heatmap_zip_rollups(timestamptz) TO service_role;

-- Runs on the existing Data Connections dispatcher cadence rather than a
-- new pg_cron entry of its own — same convention as every other schedule
-- row here (droptop_orders' own seed a few migrations back). Off by
-- default like the others; an admin turns it on from Config -> Data
-- Connections once ready. 1440 = once/day, matching the "nightly" design.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT company_id, 'heatmap_rollup_refresh', 'interval', 1440
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
