-- Real user report 2026-09-25: Droptop Orders' "By Shop" rollup AND Package
-- Mapping's "Pricing audit - last 7 days" both started timing out. Confirmed
-- live against production this is NOT a regression of the 20260930bl fix —
-- it's the same already-documented disk-I/O-bound crossover point (that
-- migration's own comment already predicted "a materialized/cached rollup
-- would be the next lever if this ever isn't good enough"), now measurably
-- worse because a background historical backfill job
-- (inventory.data_connection_backfill_jobs, connection_key droptop_orders,
-- status 'running' as of this writing, cursor_month 2026-05-01, still
-- walking back toward its 24-month floor) has nearly DOUBLED
-- inventory.droptop_order_services (1.68M -> 3.32M rows) and grown
-- droptop_order_packages similarly in about a day. EXPLAIN ANALYZE against
-- production confirmed the summary RPC's own svc_qt CTE now does a Parallel
-- Seq Scan on droptop_order_services reading ~2.3GB of mostly-cold buffers
-- (92% cache miss) for a plain 30-day/196k-order company-wide window — a
-- real, cold, non-degenerate run of the whole function measured ~76s
-- wall-clock, dangerously close to its existing 90s statement_timeout.
-- Forcing a nested-loop plan (enable_seqscan=off) was re-tested and, same
-- as 20260930bl's own finding, landed in the same ballpark (~17s vs ~21s
-- for just this one CTE) — genuinely I/O-bound at this volume, not a bad
-- plan choice a query rewrite can fix. This will keep improving on its own
-- once the backfill finishes walking back through its remaining ~10 months
-- and day-to-day growth returns to its normal, much smaller pace.
--
-- get_droptop_package_price_audit/_orders never got the same defensive
-- SET statement_timeout every other at-risk RPC in this codebase already
-- has (see the daily-coverage RPCs' own 20260930q fix) — it silently
-- inherited the `authenticated` role's own 30s default. Measured ~8s warm
-- right now, but with droptop_order_packages also growing from the same
-- backfill and no timeout margin of its own, it's the next one to tip over
-- under a cold-cache/concurrent-load page load. Giving both functions real,
-- explicit headroom (not a permanent fix — see the note above) so they
-- survive the backfill instead of getting killed by a stale, now-too-tight
-- budget.
CREATE OR REPLACE FUNCTION public.get_droptop_orders_summary_stats(
  p_company_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_location_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET statement_timeout = '180s'
SET work_mem = '64MB'
AS $$
  WITH orders_scope AS (
    SELECT o.id, o.location_id, o.final_price
    FROM inventory.droptop_orders o
    WHERE o.company_id = p_company_id
      AND o.order_finalized_at >= p_start AND o.order_finalized_at <= p_end
      AND (p_location_ids IS NULL OR o.location_id = ANY(p_location_ids))
  ),
  svc_qt AS (
    SELECT s.order_id, s.package_id, sum((elem->>'quantity_total')::numeric) AS oil_qty
    FROM orders_scope o
    JOIN inventory.droptop_order_services s ON s.order_id = o.id
    CROSS JOIN LATERAL jsonb_array_elements(s.products) elem
    WHERE upper(trim(coalesce(elem->>'uom', ''))) = 'QT'
    GROUP BY s.order_id, s.package_id
  ),
  quarts_per_order AS (
    SELECT order_id, sum(qty) AS quarts
    FROM (
      SELECT pr.order_id, pr.quantity_total AS qty
      FROM orders_scope o
      JOIN inventory.droptop_order_products pr ON pr.order_id = o.id
      WHERE upper(trim(coalesce(pr.uom, ''))) = 'QT'
      UNION ALL
      SELECT order_id, oil_qty AS qty FROM svc_qt
    ) x
    GROUP BY order_id
  ),
  order_class_counts AS (
    SELECT p.order_id,
      count(*) FILTER (WHERE cls.classification IN ('air_filter', 'cabin_air_filter', 'wiper_blades', 'additives', 'tire_rotation')) AS m5,
      count(*) FILTER (WHERE cls.classification = 'oil_change') AS oil_change
    FROM orders_scope o
    JOIN inventory.droptop_order_packages p ON p.order_id = o.id
    LEFT JOIN inventory.droptop_package_classification cls
      ON cls.company_id = p_company_id AND cls.package_name = p.name
    GROUP BY p.order_id
  ),
  pkg_name_by_id AS (
    SELECT DISTINCT ON (p.package_id) p.package_id, p.name
    FROM orders_scope o
    JOIN inventory.droptop_order_packages p ON p.order_id = o.id
    WHERE p.package_id IS NOT NULL AND p.name IS NOT NULL
    ORDER BY p.package_id, p.name
  ),
  svc_oil_by_name AS (
    SELECT pn.name, sum(x.oil_qty) AS oil_qty_total
    FROM svc_qt x
    JOIN pkg_name_by_id pn ON pn.package_id = x.package_id
    WHERE x.package_id IS NOT NULL
    GROUP BY pn.name
  ),
  pkg_counts AS (
    SELECT p.name, count(*) AS cnt
    FROM orders_scope o
    JOIN inventory.droptop_order_packages p ON p.order_id = o.id
    WHERE p.name IS NOT NULL
    GROUP BY p.name
  ),
  by_package AS (
    SELECT jsonb_agg(jsonb_build_object(
      'name', pc.name,
      'count', pc.cnt,
      'avg_oil_quarts', CASE WHEN pc.cnt > 0 THEN coalesce(so.oil_qty_total, 0) / pc.cnt ELSE 0 END
    ) ORDER BY pc.cnt DESC) AS rows
    FROM pkg_counts pc
    LEFT JOIN svc_oil_by_name so ON so.name = pc.name
  ),
  by_shop AS (
    SELECT jsonb_agg(jsonb_build_object(
      'location_id', shop_totals.location_id,
      'count', shop_totals.cnt,
      'avg_quarts', shop_totals.avg_quarts,
      'm5_pct', shop_totals.m5_pct
    )) AS rows
    FROM (
      SELECT
        o.location_id,
        count(*) AS cnt,
        CASE WHEN count(*) FILTER (WHERE coalesce(q.quarts, 0) > 0) > 0
          THEN sum(coalesce(q.quarts, 0)) FILTER (WHERE coalesce(q.quarts, 0) > 0)
               / count(*) FILTER (WHERE coalesce(q.quarts, 0) > 0)
          ELSE 0 END AS avg_quarts,
        CASE WHEN sum(coalesce(cc.oil_change, 0)) > 0
          THEN sum(coalesce(cc.m5, 0))::numeric / sum(coalesce(cc.oil_change, 0)) * 100
          ELSE NULL END AS m5_pct
      FROM orders_scope o
      LEFT JOIN quarts_per_order q ON q.order_id = o.id
      LEFT JOIN order_class_counts cc ON cc.order_id = o.id
      GROUP BY o.location_id
    ) shop_totals
  ),
  totals AS (
    SELECT
      count(*) AS cnt,
      coalesce(sum(o.final_price), 0) AS revenue,
      count(*) FILTER (WHERE coalesce(q.quarts, 0) > 0) AS oil_order_count,
      sum(coalesce(q.quarts, 0)) FILTER (WHERE coalesce(q.quarts, 0) > 0) AS oil_quarts_total,
      sum(coalesce(cc.m5, 0)) AS m5_count,
      sum(coalesce(cc.oil_change, 0)) AS oil_change_count
    FROM orders_scope o
    LEFT JOIN quarts_per_order q ON q.order_id = o.id
    LEFT JOIN order_class_counts cc ON cc.order_id = o.id
  )
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'count', t.cnt,
      'revenue', t.revenue,
      'avg_order_value', CASE WHEN t.cnt > 0 THEN t.revenue / t.cnt ELSE 0 END,
      'avg_quarts_per_oil_order', CASE WHEN t.oil_order_count > 0 THEN t.oil_quarts_total / t.oil_order_count ELSE 0 END,
      'm5_pct', CASE WHEN t.oil_change_count > 0 THEN t.m5_count::numeric / t.oil_change_count * 100 ELSE NULL END,
      'distinct_package_count', (SELECT count(*) FROM pkg_counts)
    ),
    'by_package', coalesce((SELECT rows FROM by_package), '[]'::jsonb),
    'by_shop', coalesce((SELECT rows FROM by_shop), '[]'::jsonb)
  )
  FROM totals t
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_orders_summary_stats TO authenticated;

-- Same defensive timeout every other at-risk RPC in this codebase already
-- has (daily-coverage RPCs, 20260930q) — these two never got it.
CREATE OR REPLACE FUNCTION public.get_droptop_package_price_audit(p_days int DEFAULT 7)
RETURNS TABLE (
  location_id uuid,
  package_name text,
  classification text,
  price_column text,
  mode_price numeric,
  mode_count bigint,
  total_count bigint,
  distinct_price_count int
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
SET statement_timeout = '60s'
AS $function$
  WITH scoped AS (
    SELECT o.location_id, p.name AS package_name, p.base_service_price
    FROM inventory.droptop_order_packages p
    JOIN inventory.droptop_orders o ON o.id = p.order_id
    WHERE p.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
      AND o.order_finalized_at >= now() - (p_days || ' days')::interval
      AND p.base_service_price IS NOT NULL
  ),
  counted AS (
    SELECT location_id, package_name, base_service_price, count(*) AS cnt
    FROM scoped
    GROUP BY location_id, package_name, base_service_price
  ),
  agg AS (
    SELECT
      location_id, package_name,
      sum(cnt) AS total_count,
      count(*)::int AS distinct_price_count,
      (array_agg(base_service_price ORDER BY cnt DESC, base_service_price ASC))[1] AS mode_price,
      (array_agg(cnt ORDER BY cnt DESC, base_service_price ASC))[1] AS mode_count
    FROM counted
    GROUP BY location_id, package_name
  )
  SELECT
    a.location_id, a.package_name,
    COALESCE(c.classification, 'none') AS classification,
    c.price_column,
    a.mode_price, a.mode_count, a.total_count, a.distinct_price_count
  FROM agg a
  LEFT JOIN inventory.droptop_package_classification c
    ON c.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND c.package_name = a.package_name;
$function$;

GRANT EXECUTE ON FUNCTION public.get_droptop_package_price_audit(int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_droptop_package_price_audit_orders(p_location_id uuid, p_package_name text, p_days int DEFAULT 7)
RETURNS TABLE (
  order_id uuid,
  order_finalized_at timestamptz,
  base_service_price numeric,
  vehicle_name text,
  license_plate text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
SET statement_timeout = '60s'
AS $function$
  SELECT o.id, o.order_finalized_at, p.base_service_price, p.vehicle_name, p.license_plate
  FROM inventory.droptop_order_packages p
  JOIN inventory.droptop_orders o ON o.id = p.order_id
  WHERE p.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND o.location_id = p_location_id
    AND p.name = p_package_name
    AND o.order_finalized_at >= now() - (p_days || ' days')::interval
  ORDER BY o.order_finalized_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_droptop_package_price_audit_orders(uuid, text, int) TO authenticated;
