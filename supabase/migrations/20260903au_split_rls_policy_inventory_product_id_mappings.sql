-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage product_id_mappings" ON inventory.product_id_mappings;
CREATE POLICY "Admins can insert product_id_mappings" ON inventory.product_id_mappings
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update product_id_mappings" ON inventory.product_id_mappings
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete product_id_mappings" ON inventory.product_id_mappings
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
