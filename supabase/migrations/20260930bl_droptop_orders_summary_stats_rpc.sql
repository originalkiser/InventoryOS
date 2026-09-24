-- DroptopOrdersPage.tsx's "High-level stats"/"By Package"/"By Shop" cards
-- were computed entirely client-side from the SAME full raw order+package+
-- product+service+vehicle fetch the page also uses for its paginated
-- orders table and "Build Your Own Report" — meaning a shop just wanting
-- to see the summary numbers for a real 30-day/170k-order range had to
-- wait for every one of those ~170k orders' full child-row detail to be
-- downloaded and processed in the browser first (reported: 4 minutes).
--
-- This RPC computes exactly those 3 sections (totals, by-package, by-shop)
-- directly in SQL, scoped to the same base filters already resolved before
-- any raw fetch (company, date range, location ids from the Shop/Region/
-- Market/AM pickers) — a shop-summary view no longer needs the raw
-- per-order fetch at all.
--
-- First version of this function wrote every child-table lookup as
-- `WHERE x.order_id IN (SELECT id FROM orders_scope)` — confirmed via
-- EXPLAIN ANALYZE against production this was 118s, almost entirely one
-- CTE (quarts_per_order): the planner chose a Hash Semi Join that did a
-- full PARALLEL SEQ SCAN of the entire inventory.droptop_order_services
-- table (confirmed 1.68M+ rows total) and ran jsonb_array_elements on
-- EVERY row (3.3M Function Scan loops) BEFORE filtering down to the
-- ~196,000 orders actually in scope — even though an order_id index
-- (idx_inv_droptop_order_services_order) exists and only ~466k of that
-- table's rows (confirmed via a direct count) actually belong to this
-- company's 30-day window. Every child-table CTE below is now written as
-- an explicit `FROM orders_scope o JOIN child c ON c.order_id = o.id`
-- instead of an IN-subquery.
--
-- That alone did NOT change the plan — Postgres treats a JOIN against a
-- CTE and an IN-subquery as logically equivalent and is free to pick
-- either a Nested Loop (per-order index probe) or a Hash Semi Join (full
-- scan) for either syntax, based on its own cost estimate. A forced
-- correlated-subquery rewrite (wrapping the child lookup as a scalar
-- subquery in the SELECT list, which the planner cannot rewrite into a
-- bulk join) DID force the index-based Nested Loop plan — confirmed via
-- EXPLAIN ANALYZE — but landed at almost the same wall-clock time as the
-- full-scan plan (~30-35s either way for this company's real 30-day/
-- ~196,000-order window, ~466,000 matching droptop_order_services rows).
-- Root cause: this is genuinely disk-I/O-bound at this data volume, not a
-- bad plan choice — 466k of the child table's rows is a large enough
-- fraction that per-order random index lookups (196k separate seeks) cost
-- about the same as one sequential scan of the whole table, i.e. this
-- query sits right at the seq-scan/index-scan crossover point regardless
-- of which side of it either query shape lands on. The JOIN form (not the
-- forced-correlated-subquery form) was kept since it performed the same
-- and is simpler/more standard SQL. work_mem is still raised below as a
-- real, if secondary, contributor — the FIRST version of this query (see
-- git history) spilled a hash aggregate to disk under this database's
-- default 3.5MB work_mem, adding real time on top of the I/O cost.
--
-- Net result: tens of seconds for a full month's ~196,000-order summary,
-- versus the reported ~4 MINUTES for the equivalent client-side
-- computation (which had to download every one of those orders' full
-- package/product/service/vehicle detail to the browser first) — a real,
-- large improvement even though it isn't instant. A materialized/cached
-- rollup would be the next lever if this ever isn't good enough.
--
-- svc_qt below does ONE pass over droptop_order_services × jsonb_array_
-- elements (the expensive part) and feeds BOTH quarts_per_order (order-
-- level total, for totals/by_shop) and the by-package oil-quarts
-- attribution — the original version ran that same unnest twice
-- (once per consumer), doubling its own most expensive cost for no reason.
CREATE OR REPLACE FUNCTION public.get_droptop_orders_summary_stats(
  p_company_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_location_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET statement_timeout = '90s'
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
    -- Package-line-item classification counts per order (not a per-order
    -- flag) — an order with both an oil change and a tire rotation counts
    -- 1 toward oil_change and 1 toward m5, matching this page's own
    -- classificationCountsFor().
    SELECT p.order_id,
      count(*) FILTER (WHERE cls.classification IN ('air_filter', 'cabin_air_filter', 'wiper_blades', 'additives', 'tire_rotation')) AS m5,
      count(*) FILTER (WHERE cls.classification = 'oil_change') AS oil_change
    FROM orders_scope o
    JOIN inventory.droptop_order_packages p ON p.order_id = o.id
    LEFT JOIN inventory.droptop_package_classification cls
      ON cls.company_id = p_company_id AND cls.package_name = p.name
    GROUP BY p.order_id
  ),
  -- package_id -> name, scoped to this same range (Droptop's package_id is
  -- a stable identifier, so this is effectively 1:1 in practice) — needed
  -- to attribute a service's oil-quart consumption (keyed by package_id)
  -- back to the package NAME the By Package table groups on.
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
