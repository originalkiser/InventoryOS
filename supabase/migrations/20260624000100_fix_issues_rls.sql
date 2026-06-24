-- Remediation: ensure issues visibility tables exist and RLS SELECT policy is correct.
-- Safe to re-run (all statements use IF NOT EXISTS / DROP IF EXISTS).

-- Ensure the visibility column exists
ALTER TABLE inventory.issues
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'department'
    CHECK (visibility IN ('private', 'department', 'attendees', 'specific_users'));

-- Ensure the deleted_at column exists (added in soft-delete migration)
ALTER TABLE inventory.issues
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Ensure support tables exist
CREATE TABLE IF NOT EXISTS inventory.issue_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

CREATE TABLE IF NOT EXISTS inventory.issue_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

CREATE TABLE IF NOT EXISTS inventory.issue_department_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

-- Enable RLS on support tables (idempotent)
ALTER TABLE inventory.issue_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.issue_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.issue_department_exclusions ENABLE ROW LEVEL SECURITY;

-- Recreate support table policies (drop first to make idempotent)
DROP POLICY IF EXISTS "issue_shares_manage" ON inventory.issue_shares;
DROP POLICY IF EXISTS "issue_shares_read" ON inventory.issue_shares;
CREATE POLICY "issue_shares_manage" ON inventory.issue_shares
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));
CREATE POLICY "issue_shares_read" ON inventory.issue_shares FOR SELECT
  USING (user_profile_id = auth.uid());

DROP POLICY IF EXISTS "issue_participants_read" ON inventory.issue_participants;
DROP POLICY IF EXISTS "issue_participants_manage" ON inventory.issue_participants;
CREATE POLICY "issue_participants_read" ON inventory.issue_participants FOR SELECT USING (true);
CREATE POLICY "issue_participants_manage" ON inventory.issue_participants
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));

DROP POLICY IF EXISTS "issue_dept_excl_manage" ON inventory.issue_department_exclusions;
DROP POLICY IF EXISTS "issue_dept_excl_read" ON inventory.issue_department_exclusions;
CREATE POLICY "issue_dept_excl_manage" ON inventory.issue_department_exclusions
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));
CREATE POLICY "issue_dept_excl_read" ON inventory.issue_department_exclusions FOR SELECT USING (true);

-- Drop and recreate the issues SELECT policy cleanly
DROP POLICY IF EXISTS "issues_select" ON inventory.issues;
DROP POLICY IF EXISTS "Issues are visible to company members" ON inventory.issues;

CREATE POLICY "issues_select" ON inventory.issues FOR SELECT
  USING (
    -- Author always sees their own
    created_by = auth.uid()

    -- Department-scoped: same company, not excluded
    OR (
      visibility = 'department'
      AND company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
      AND auth.uid() NOT IN (
        SELECT user_profile_id FROM inventory.issue_department_exclusions
        WHERE issue_id = inventory.issues.id
      )
    )

    -- Attendees only
    OR (
      visibility = 'attendees'
      AND auth.uid() IN (
        SELECT user_profile_id FROM inventory.issue_participants
        WHERE issue_id = inventory.issues.id
      )
    )

    -- Explicitly shared users
    OR (
      visibility = 'specific_users'
      AND auth.uid() IN (
        SELECT user_profile_id FROM inventory.issue_shares
        WHERE issue_id = inventory.issues.id
      )
    )

    -- Admins and developers (all role values)
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid())
      IN ('administrator', 'developer', 'admin')
  );
