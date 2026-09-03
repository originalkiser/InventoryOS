-- Phase 3: same "powerbi_reader overlap" pattern as core.locations
-- (20260903bl) across the Droptop tables that also have a powerbi_reader
-- unconditional-read policy — narrow each company-scoped SELECT policy
-- to `authenticated` so it stops overlapping with the powerbi_reader
-- policy. Zero effect on real app users.
ALTER POLICY "droptop_customers_select" ON inventory.droptop_customers TO authenticated;
ALTER POLICY "droptop_order_packages_select" ON inventory.droptop_order_packages TO authenticated;
ALTER POLICY "droptop_order_products_select" ON inventory.droptop_order_products TO authenticated;
ALTER POLICY "droptop_order_services_select" ON inventory.droptop_order_services TO authenticated;
ALTER POLICY "droptop_orders_select" ON inventory.droptop_orders TO authenticated;
ALTER POLICY "zip_centroids_select" ON inventory.zip_centroids TO authenticated;
