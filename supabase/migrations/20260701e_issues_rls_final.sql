-- Final issues RLS: fix soft-delete violation + expand to department members.
--
-- Root cause of "new row violates row-level security policy":
--   PostgreSQL 15 applies the SELECT policy USING clause as an additional
--   WITH CHECK on every UPDATE's new row. After setting deleted_at the new
--   row failed "deleted_at IS NULL" in issues_select → error.
--
-- Fix: remove "deleted_at IS NULL" from issues_select USING entirely.
--   Access is still fully scoped to company + department membership.
--   Client queries always add .is('deleted_at', null) for live views.
--
-- Also expands UPDATE and DELETE to any department member (not just creator).

-- ── SELECT ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "issues_select" ON platform.issues;
CREATE POLICY "issues_select" ON platform.issues
  FOR SELECT USING (
    -- admin / developer sees all issues in their company
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.issues.company_id
        AND p.role IN ('admin', 'developer')
        AND p.deleted_at IS NULL
    )
    -- creator always sees their own (personal or departmental)
    OR created_by = auth.uid()
    -- any member of the issue's owning department
    OR (
      department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = platform.issues.department_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM platform.issue_department_exclusions e
        WHERE e.issue_id = platform.issues.id
          AND e.user_id = auth.uid()
      )
    )
    -- member of a shared department
    OR (
      cardinality(shared_department_ids) > 0
      AND EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = ANY(platform.issues.shared_department_ids)
      )
    )
    -- explicit per-user share
    OR (
      visibility = 'specific_users'
      AND EXISTS (
        SELECT 1 FROM platform.issue_shares s
        WHERE s.issue_id = platform.issues.id
          AND s.user_id = auth.uid()
      )
    )
    -- attendee/participant share
    OR (
      visibility = 'attendees'
      AND EXISTS (
        SELECT 1 FROM platform.issue_participants ip
        WHERE ip.issue_id = platform.issues.id
          AND ip.user_id = auth.uid()
      )
    )
  );

-- ── UPDATE ───────────────────────────────────────────────────────────────────
-- USING: which rows the user may update (checked against the old row).
-- WITH CHECK: what values the new row may have. Intentionally omits
--   deleted_at IS NULL so soft-delete (setting deleted_at) is allowed.
DROP POLICY IF EXISTS "issues_update" ON platform.issues;
CREATE POLICY "issues_update" ON platform.issues
  FOR UPDATE
  USING (
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
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM platform.user_profiles
      WHERE id = auth.uid() AND deleted_at IS NULL
    )
  );

-- ── DELETE ───────────────────────────────────────────────────────────────────
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
