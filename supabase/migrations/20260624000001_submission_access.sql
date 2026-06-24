-- Submission-level read/write access control rules
CREATE TABLE IF NOT EXISTS forms.submission_access_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'department', 'role', 'org')),
  principal_value text,
  -- user: uuid as text | department: dept name | role: role string | org: null
  can_read boolean DEFAULT true,
  can_write boolean DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- Unique: (form_id, principal_type, principal_value) — use two partial indexes to handle nulls
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_rule_nonnull
  ON forms.submission_access_rules(form_id, principal_type, principal_value)
  WHERE principal_value IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_access_rule_null
  ON forms.submission_access_rules(form_id, principal_type)
  WHERE principal_value IS NULL;

ALTER TABLE forms.submission_access_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Manage submission access rules"
  ON forms.submission_access_rules
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

CREATE POLICY "Read submission access rules"
  ON forms.submission_access_rules FOR SELECT
  USING (auth.role() = 'authenticated');
