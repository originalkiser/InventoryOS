-- Fixes a real "canceling statement due to statement timeout" in the
-- Droptop Usage sync's existing-row load (droptop-sync-usage/index.ts).
-- EXPLAIN ANALYZE showed the planner picking product_usage_pkey (on id
-- alone) to satisfy `ORDER BY id LIMIT 5000` instead of the existing
-- idx_product_usage_company (company_id, location_id) index that actually
-- matches the WHERE clause -- it scanned 70k+ rows to find 5000 matches
-- for just 20 locations, taking 7.6s for one page alone. A composite index
-- with id appended lets the planner satisfy the filter AND the ORDER BY
-- from the same index, without the "scan in id order hoping to get lucky"
-- pathology -- confirmed via EXPLAIN ANALYZE (7.6s -> ~30ms, zero rows
-- filtered) once the code's own ORDER BY was also changed to
-- (location_id, id) to match this index's column order (see the
-- companion code change in droptop-sync-usage/index.ts).
--
-- Applied live via Supabase MCP on 2026-09-08.
create index if not exists idx_product_usage_company_location_id
  on inventory.product_usage (company_id, location_id, id);
