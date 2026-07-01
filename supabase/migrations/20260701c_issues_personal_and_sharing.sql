-- Allow personal issues (department_id = null) and interdepartmental sharing

-- 1. Make department_id nullable so personal issues don't require a department
ALTER TABLE platform.issues ALTER COLUMN department_id DROP NOT NULL;

-- 2. Add shared_department_ids for interdepartmental visibility
ALTER TABLE platform.issues ADD COLUMN IF NOT EXISTS
  shared_department_ids uuid[] NOT NULL DEFAULT '{}';

-- 3. Rebuild issues_select to cover shared departments and nullable dept
DROP POLICY IF EXISTS "issues_select" ON platform.issues;
CREATE POLICY "issues_select" ON platform.issues
  FOR SELECT USING (
    deleted_at IS NULL
    AND (
      -- admin/developer sees all in company
      EXISTS (
        SELECT 1 FROM platform.user_profiles p
        WHERE p.id = auth.uid()
          AND p.company_id = platform.issues.company_id
          AND p.role IN ('admin', 'developer')
          AND p.deleted_at IS NULL
      )
      -- author always sees own (personal or otherwise)
      OR created_by = auth.uid()
      -- member of the owner department
      OR (
        department_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM platform.user_department_memberships m
          WHERE m.user_id = auth.uid()
            AND m.department_id = platform.issues.department_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM platform.issue_department_exclusions e
          WHERE e.issue_id = platform.issues.id AND e.user_id = auth.uid()
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
      -- specific users list
      OR (
        visibility = 'specific_users'
        AND EXISTS (
          SELECT 1 FROM platform.issue_shares s
          WHERE s.issue_id = platform.issues.id AND s.user_id = auth.uid()
        )
      )
      -- attendees
      OR (
        visibility = 'attendees'
        AND EXISTS (
          SELECT 1 FROM platform.issue_participants ip
          WHERE ip.issue_id = platform.issues.id AND ip.user_id = auth.uid()
        )
      )
    )
  );

-- 4. Rebuild issues_insert to allow personal (null dept) and shared
DROP POLICY IF EXISTS "issues_insert" ON platform.issues;
CREATE POLICY "issues_insert" ON platform.issues
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM platform.user_profiles
      WHERE id = auth.uid() AND deleted_at IS NULL
    )
    AND (
      -- personal issue — anyone can create their own
      department_id IS NULL
      -- department member
      OR EXISTS (
        SELECT 1 FROM platform.user_department_memberships m
        WHERE m.user_id = auth.uid()
          AND m.department_id = platform.issues.department_id
      )
      -- admin/developer
      OR EXISTS (
        SELECT 1 FROM platform.user_profiles p
        WHERE p.id = auth.uid()
          AND p.company_id = platform.issues.company_id
          AND p.role IN ('admin', 'developer')
          AND p.deleted_at IS NULL
      )
    )
  );
