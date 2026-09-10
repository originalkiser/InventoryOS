-- Sidebar-section access is driven by platform.departments (slug == the
-- sidebar section key that useDeptAccess() checks). Seed the two sections
-- that never had a department row — Droptop and Data Connections — so
-- admins can grant them from the Manage User modal. Every other grantable
-- section already has its row; new sections get theirs created client-side
-- on the first grant (see UsersPage's ManageUserModal.save).
--
-- Also widen the admin write policies on platform.departments to include
-- the 'administrator' role — it can already manage memberships; departments
-- was missed, which blocked that client-side auto-create for admins.

INSERT INTO platform.departments (company_id, name, slug, sort_order)
SELECT DISTINCT d.company_id, v.name, v.slug, v.sort_order
FROM platform.departments d
CROSS JOIN (VALUES
  ('Droptop', 'droptop', 10),
  ('Data Connections', 'data-connections', 11)
) AS v(name, slug, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM platform.departments d2
  WHERE d2.company_id = d.company_id AND d2.slug = v.slug
);

DROP POLICY IF EXISTS dept_admin_insert ON platform.departments;
CREATE POLICY dept_admin_insert ON platform.departments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM platform.user_profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.company_id = departments.company_id
      AND p.role = ANY (ARRAY['admin','administrator','developer']) AND p.deleted_at IS NULL));

DROP POLICY IF EXISTS dept_admin_update ON platform.departments;
CREATE POLICY dept_admin_update ON platform.departments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM platform.user_profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.company_id = departments.company_id
      AND p.role = ANY (ARRAY['admin','administrator','developer']) AND p.deleted_at IS NULL))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.user_profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.company_id = departments.company_id
      AND p.role = ANY (ARRAY['admin','administrator','developer']) AND p.deleted_at IS NULL));

DROP POLICY IF EXISTS dept_admin_delete ON platform.departments;
CREATE POLICY dept_admin_delete ON platform.departments FOR DELETE
  USING (EXISTS (SELECT 1 FROM platform.user_profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.company_id = departments.company_id
      AND p.role = ANY (ARRAY['admin','administrator','developer']) AND p.deleted_at IS NULL));
