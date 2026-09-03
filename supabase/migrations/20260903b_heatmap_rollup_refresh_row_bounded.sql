-- refresh_heatmap_zip_rollups() rewritten to bound its own cost per call —
-- needed even with the indexes added in 20260903_droptop_orders_heatmap_
-- rollup_indexes.sql, because calls through PostgREST (including this
-- function's own caller, heatmap-rollup-refresh's service-role client)
-- ride on a connection opened as `authenticator`, which sets
-- statement_timeout=8s for the session (SET ROLE service_role afterward
-- doesn't reset it). A single call covering a large backlog — this
-- session's historical order backfill stamped `updated_at` on ~200k rows
-- spanning 15 months of order_finalized_at dates within a comparatively
-- narrow real-time window — did real work well past that 8s budget.
--
-- Took three iterations to actually fix (kept live here as the honest end
-- state, not the two that didn't work):
--   1. Bounding by a wall-clock p_until window: didn't help — cost is
--      driven by how many DISTINCT (company, location, order_date) groups
--      get touched, not how much real time a window spans, and this
--      session's backfill clustered a huge number of distinct dates into
--      a narrow update-time window.
--   2. Bounding by p_max_groups alone: still didn't help — the GROUP BY
--      that discovers which groups changed still had to scan/aggregate
--      every row since the watermark before it could sort and cut the
--      result down, so the discovery step's own cost stayed unbounded.
--   3. This version: bounds discovery ITSELF first via p_max_rows (a
--      genuine index-range-scan early-stop, ordered by updated_at, so
--      Postgres can stop after reading just that many rows), then derives
--      touched groups from just that row slice and caps those to
--      p_max_groups before the actual expensive day-total
--      re-aggregation (which still joins the full table for correctness).
--      Confirmed under a simulated 8s statement_timeout before this was
--      wired into heatmap-rollup-refresh's batching loop.
--
-- The returned watermark backs off by 1 second from the last included
-- group's timestamp as a safety margin against exact-timestamp ties at
-- the batch boundary — re-aggregating a date twice near that boundary is
-- harmless (this table is fully rebuilt per date, not incremented);
-- skipping one is not.
CREATE OR REPLACE FUNCTION public.refresh_heatmap_zip_rollups(
  p_since timestamp with time zone,
  p_max_groups integer DEFAULT NULL,
  p_max_rows integer DEFAULT 20000
)
 RETURNS TABLE(dates_recomputed integer, rows_upserted integer, new_watermark timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_dates_recomputed integer := 0;
  v_rows_upserted    integer := 0;
  v_new_watermark    timestamptz;
  v_max_touched      timestamptz;
BEGIN
  CREATE TEMP TABLE candidate_rows ON COMMIT DROP AS
  SELECT o.company_id, o.location_id,
         (o.order_finalized_at AT TIME ZONE 'UTC')::date AS order_date,
         o.updated_at
  FROM inventory.droptop_orders o
  WHERE o.updated_at > p_since
    AND o.order_finalized_at IS NOT NULL
  ORDER BY o.updated_at ASC
  LIMIT p_max_rows;

  CREATE TEMP TABLE touched_dates ON COMMIT DROP AS
  SELECT g.company_id, g.location_id, g.order_date
  FROM (
    SELECT company_id, location_id, order_date, MAX(updated_at) AS group_watermark
    FROM candidate_rows
    GROUP BY 1, 2, 3
    ORDER BY group_watermark ASC, company_id, location_id, order_date
    LIMIT COALESCE(p_max_groups, 2147483647)
  ) g;

  SELECT count(*) INTO v_dates_recomputed FROM touched_dates;

  IF v_dates_recomputed = 0 THEN
    RETURN QUERY SELECT 0, 0, p_since;
    RETURN;
  END IF;

  SELECT MAX(c.updated_at) INTO v_max_touched
  FROM candidate_rows c
  JOIN touched_dates t
    ON t.company_id = c.company_id AND t.location_id = c.location_id AND t.order_date = c.order_date;

  v_new_watermark := GREATEST(p_since, v_max_touched - interval '1 second');

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

  RETURN QUERY SELECT v_dates_recomputed, v_rows_upserted, v_new_watermark;
END;
$function$;
