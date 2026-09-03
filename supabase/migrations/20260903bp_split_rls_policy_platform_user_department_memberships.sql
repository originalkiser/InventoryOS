-- Phase 3: membership_admin_all (ALL, admin/administrator/developer role
-- AND same company) and membership_self_select (SELECT, own row OR admin
-- role IN admin/developer — note: missing 'administrator' from its own
-- role list, a pre-existing inconsistency flagged in the Phase 1 audit
-- and not otherwise touched here) genuinely overlap on SELECT: self_
-- select's admin-clause is a subset of membership_admin_all's broader
-- role list, but self_select's own-row clause is not covered by admin_all
-- at all. Split membership_admin_all into explicit INSERT/UPDATE/DELETE
-- (unchanged condition), and merged SELECT into one policy: own row OR
-- the original admin condition (which already fully covers self_select's
-- narrower admin-clause).
DROP POLICY IF EXISTS "membership_admin_all" ON platform.user_department_memberships;
DROP POLICY IF EXISTS "membership_self_select" ON platform.user_department_memberships;

CREATE POLICY "membership_admin_insert" ON platform.user_department_memberships
  FOR INSERT WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = user_department_memberships.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
CREATE POLICY "membership_admin_update" ON platform.user_department_memberships
  FOR UPDATE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = user_department_memberships.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  )
  WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = user_department_memberships.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
CREATE POLICY "membership_admin_delete" ON platform.user_department_memberships
  FOR DELETE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = user_department_memberships.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
CREATE POLICY "membership_self_or_admin_select" ON platform.user_department_memberships
  FOR SELECT
  USING (
    (user_id = (select auth.uid()))
    OR (EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = user_department_memberships.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (p.deleted_at IS NULL))))
  );
