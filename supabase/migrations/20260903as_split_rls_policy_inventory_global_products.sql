-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage global_products" ON inventory.global_products;
CREATE POLICY "Admins can insert global_products" ON inventory.global_products
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update global_products" ON inventory.global_products
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete global_products" ON inventory.global_products
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
