-- Droptop Orders page (DroptopOrdersPage.tsx) fetches one page of orders
-- with 4 child tables embedded (packages/products/services/vehicles) via
-- PostgREST's own resource-embedding syntax
-- (select=...,droptop_order_packages(...),droptop_order_products(...),...).
-- PostgREST resolves a one-to-many embed as a correlated subquery PER
-- OUTER ROW — confirmed live via EXPLAIN ANALYZE against production: one
-- 2000-row page took 4.6s, almost all of it 4 separate per-row Index Scans
-- (2000 executions each) against the 4 child tables, most of them hitting
-- disk rather than cache. Under the 6-way concurrent date-slice fetch this
-- page already uses (fetchDateRangeConcurrent), that's easily enough to
-- exceed the `authenticated` role's own 30s statement_timeout on a large
-- custom range (found live 2026-09-24: "canceling statement due to
-- statement timeout — loaded 122,777 order(s)" on a ~230k-order pull).
--
-- This RPC does the exact same query in a fundamentally faster shape: pick
-- the page of order ids first (cheap, index-only), then aggregate each
-- child table with ONE grouped query scoped to just those ids (a bulk
-- `WHERE order_id IN (...)`) instead of 2000 separate per-row lookups.
-- Confirmed via EXPLAIN ANALYZE on the identical page/date-range: 105ms,
-- a ~44x improvement — same result shape (json array per order, empty/
-- absent children read as null, exactly like PostgREST's own embed), so
-- the client's own row-processing code (the `droptop_order_packages ?? []`
-- destructuring loop) needed no changes beyond swapping which call it
-- makes. SET statement_timeout is still raised here as a safety net for a
-- genuinely pathological day, not because it's expected to be needed —
-- same "SET statement_timeout on this one function, not the role" pattern
-- already used for the 4 daily-coverage RPCs (20260930q).
--
-- Lives in public (not inventory) — matching every other report-style RPC
-- this module already calls (get_droptop_package_name_counts,
-- get_droptop_order_product_sales, get_heatmap_zip_rollup_clusters, ...),
-- all called as a bare `sb.rpc(...)` with no `.schema('inventory')`, since
-- PostgREST's RPC endpoint defaults to the public schema.
CREATE OR REPLACE FUNCTION public.get_droptop_orders_embedded(
  p_company_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_location_ids uuid[] DEFAULT NULL,
  p_cursor_date timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_limit int DEFAULT 2000
)
RETURNS TABLE (
  id uuid, location_id uuid, order_id text, first_name text, last_name text, city text, region text,
  status text, subtotal numeric, final_price numeric, order_finalized_at timestamptz, fleet_company_name text,
  droptop_order_packages json, droptop_order_products json, droptop_order_services json, droptop_order_vehicles json
)
LANGUAGE sql STABLE SECURITY INVOKER
SET statement_timeout = '60s'
AS $$
  WITH page AS (
    SELECT o.id, o.location_id, o.order_id, o.first_name, o.last_name, o.city, o.region, o.status,
      o.subtotal, o.final_price, o.order_finalized_at, o.fleet_company_name
    FROM inventory.droptop_orders o
    WHERE o.company_id = p_company_id
      AND o.order_finalized_at >= p_start AND o.order_finalized_at <= p_end
      AND (p_location_ids IS NULL OR o.location_id = ANY(p_location_ids))
      AND (
        p_cursor_date IS NULL
        OR o.order_finalized_at > p_cursor_date
        OR (o.order_finalized_at = p_cursor_date AND o.id > p_cursor_id)
      )
    ORDER BY o.order_finalized_at ASC, o.id ASC
    LIMIT p_limit
  ),
  pkg AS (
    SELECT p.order_id, json_agg(json_build_object(
      'package_id', p.package_id, 'name', p.name, 'base_service_price', p.base_service_price,
      'price_total', p.price_total, 'price_total_after_discount', p.price_total_after_discount
    )) AS packages
    FROM inventory.droptop_order_packages p WHERE p.order_id IN (SELECT page.id FROM page) GROUP BY p.order_id
  ),
  prod AS (
    SELECT pr.order_id, json_agg(json_build_object(
      'product_id', pr.product_id, 'product_type', pr.product_type, 'uom', pr.uom, 'quantity_total', pr.quantity_total
    )) AS products
    FROM inventory.droptop_order_products pr WHERE pr.order_id IN (SELECT page.id FROM page) GROUP BY pr.order_id
  ),
  svc AS (
    SELECT s.order_id, json_agg(json_build_object('package_id', s.package_id, 'products', s.products)) AS services
    FROM inventory.droptop_order_services s WHERE s.order_id IN (SELECT page.id FROM page) GROUP BY s.order_id
  ),
  veh AS (
    SELECT v.order_id, json_agg(json_build_object(
      'vin', v.vin, 'license_plate', v.license_plate, 'vehicle_name', v.vehicle_name,
      'vin_vehicle_make', v.vin_vehicle_make, 'vin_vehicle_model', v.vin_vehicle_model,
      'vin_vehicle_year', v.vin_vehicle_year, 'mileage', v.mileage
    )) AS vehicles
    FROM inventory.droptop_order_vehicles v WHERE v.order_id IN (SELECT page.id FROM page) GROUP BY v.order_id
  )
  SELECT page.id, page.location_id, page.order_id, page.first_name, page.last_name, page.city, page.region,
    page.status, page.subtotal, page.final_price, page.order_finalized_at, page.fleet_company_name,
    pkg.packages, prod.products, svc.services, veh.vehicles
  FROM page
  LEFT JOIN pkg ON pkg.order_id = page.id
  LEFT JOIN prod ON prod.order_id = page.id
  LEFT JOIN svc ON svc.order_id = page.id
  LEFT JOIN veh ON veh.order_id = page.id
  ORDER BY page.order_finalized_at ASC, page.id ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_orders_embedded TO authenticated;
