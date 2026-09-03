-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage location_order_configs" ON inventory.location_order_config;
CREATE POLICY "Admins can insert location_order_configs" ON inventory.location_order_config
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update location_order_configs" ON inventory.location_order_config
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete location_order_configs" ON inventory.location_order_config
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
