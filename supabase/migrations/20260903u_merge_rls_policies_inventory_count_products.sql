-- Phase 3: count_products_insert/select duplicate "Company members can
-- insert/read monthly_count_products" respectively (same condition, old
-- vs new naming style).
DROP POLICY IF EXISTS "count_products_insert" ON inventory.count_products;
DROP POLICY IF EXISTS "count_products_select" ON inventory.count_products;
