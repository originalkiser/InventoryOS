-- Expand issues UPDATE/DELETE to department members, and fix the soft-delete
-- RLS error by separating USING (old row check) from WITH CHECK (new row check).
--
-- Root causes fixed:
--   1. UPDATE/DELETE only allowed creator or admin — blocks dept members
--   2. No explicit WITH CHECK on UPDATE caused Postgres to reuse USING; after
--      setting deleted_at the new row failed the SELECT policy's deleted_at IS NULL
--      guard, raising "new row violates row-level security policy"

DROP POLICY IF EXISTS "issues_update" ON platform.issues;
CREATE POLICY "issues_update" ON platform.issues
  FOR UPDATE
  USING (
    -- admin/developer sees and can update anything in their company
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.issues.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
    -- issue creator can always update their own
    OR created_by = auth.uid()
    -- any member of the issue's owning department
    OR (
      department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = platform.issues.department_id
      )
    )
  )
  WITH CHECK (
    -- New row must still belong to the user's company.
    -- Intentionally omits deleted_at IS NULL so soft-delete
    -- (setting deleted_at to a timestamp) is not blocked.
    company_id IN (
      SELECT company_id FROM platform.user_profiles
      WHERE id = auth.uid() AND deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS "issues_delete" ON platform.issues;
CREATE POLICY "issues_delete" ON platform.issues
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.issues.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
    OR created_by = auth.uid()
    OR (
      department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = platform.issues.department_id
      )
    )
  );
