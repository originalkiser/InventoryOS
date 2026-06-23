-- Add visibility to inventory.issues
ALTER TABLE inventory.issues
  ADD COLUMN IF NOT EXISTS visibility text
    NOT NULL DEFAULT 'department'
    CHECK (visibility IN ('private', 'department', 'attendees', 'specific_users'));

-- Junction table for specific_users sharing on issues
CREATE TABLE IF NOT EXISTS inventory.issue_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

-- Participants/attendees on an issue
CREATE TABLE IF NOT EXISTS inventory.issue_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

-- Department exclusions for issues
CREATE TABLE IF NOT EXISTS inventory.issue_department_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES inventory.issues(id) ON DELETE CASCADE,
  user_profile_id uuid NOT NULL REFERENCES platform.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(issue_id, user_profile_id)
);

-- RLS for new tables
ALTER TABLE inventory.issue_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "issue_shares_manage" ON inventory.issue_shares
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));
CREATE POLICY "issue_shares_read" ON inventory.issue_shares FOR SELECT
  USING (user_profile_id = (SELECT id FROM platform.user_profiles WHERE user_id = auth.uid()));

ALTER TABLE inventory.issue_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "issue_participants_read" ON inventory.issue_participants FOR SELECT USING (true);
CREATE POLICY "issue_participants_manage" ON inventory.issue_participants
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));

ALTER TABLE inventory.issue_department_exclusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "issue_dept_excl_manage" ON inventory.issue_department_exclusions
  USING (issue_id IN (SELECT id FROM inventory.issues WHERE created_by = auth.uid()));
CREATE POLICY "issue_dept_excl_read" ON inventory.issue_department_exclusions FOR SELECT USING (true);

-- Update issues SELECT policy to respect visibility
DROP POLICY IF EXISTS "issues_select" ON inventory.issues;

CREATE POLICY "issues_select" ON inventory.issues FOR SELECT
  USING (
    created_by = auth.uid()
    OR (
      visibility = 'department'
      AND (SELECT department FROM platform.user_profiles WHERE user_id = auth.uid())
        = (SELECT department FROM platform.user_profiles WHERE user_id = created_by)
      AND (SELECT id FROM platform.user_profiles WHERE user_id = auth.uid()) NOT IN (
        SELECT user_profile_id FROM inventory.issue_department_exclusions WHERE issue_id = inventory.issues.id
      )
    )
    OR (
      visibility = 'attendees'
      AND (SELECT id FROM platform.user_profiles WHERE user_id = auth.uid()) IN (
        SELECT user_profile_id FROM inventory.issue_participants WHERE issue_id = inventory.issues.id
      )
    )
    OR (
      visibility = 'specific_users'
      AND (SELECT id FROM platform.user_profiles WHERE user_id = auth.uid()) IN (
        SELECT user_profile_id FROM inventory.issue_shares WHERE issue_id = inventory.issues.id
      )
    )
    OR (SELECT role FROM platform.user_profiles WHERE user_id = auth.uid()) IN ('administrator', 'developer')
  );
