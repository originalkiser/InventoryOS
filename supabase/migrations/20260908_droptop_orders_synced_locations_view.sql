-- "Select Gap Shops" (Data Connections -> Historical Orders Backfill)
-- previously checked inventory.droptop_order_sync_state for which locations
-- have never synced — but that table is only ever written by
-- mode:'incremental', never mode:'sync' (what the Historical Backfill
-- button itself uses). A shop successfully backfilled via that button would
-- still show up as a "gap" forever, since its sync never touched
-- sync_state at all. Confirmed live 2026-09-01: shops 145-175 got real
-- orders from a backfill run but have zero droptop_order_sync_state rows.
--
-- This view is the actual source of truth for "has this location ever had
-- an order land, via ANY sync mode" — a plain SELECT DISTINCT location_id
-- from droptop_orders would risk PostgREST's 1000-row default cap (one row
-- per order, tens of thousands of rows) if queried directly from the app;
-- this view pre-aggregates down to one row per location (a couple hundred
-- rows at most), which is safe to fetch unpaginated.
--
-- security_invoker = true (Postgres 15+) so the view respects the querying
-- user's own RLS on the underlying table (company-scoped), rather than
-- running with the view owner's privileges and leaking cross-company rows.
CREATE OR REPLACE VIEW inventory.droptop_orders_synced_locations
WITH (security_invoker = true) AS
SELECT DISTINCT company_id, location_id
FROM inventory.droptop_orders
WHERE location_id IS NOT NULL;

GRANT SELECT ON inventory.droptop_orders_synced_locations TO authenticated;
