-- Phase 3: "Admins can manage weekly_counts" (ALL, company AND is_admin)
-- is redundant for both SELECT (covered by "Company members can read
-- weekly_counts") and INSERT (covered by "Company members can insert
-- weekly_counts") — admin already gets in via those broader policies.
-- It's the sole grant for UPDATE/DELETE though, so split to just those
-- two rather than dropping entirely.
DROP POLICY IF EXISTS "Admins can manage weekly_counts" ON inventory.weekly_counts;
CREATE POLICY "Admins can update weekly_counts" ON inventory.weekly_counts
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete weekly_counts" ON inventory.weekly_counts
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
