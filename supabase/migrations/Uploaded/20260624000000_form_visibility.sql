-- Form visibility options and department shares
ALTER TABLE forms.forms
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'org', 'departments', 'public')),
  ADD COLUMN IF NOT EXISTS category text;

CREATE TABLE IF NOT EXISTS forms.form_department_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  department text NOT NULL,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(form_id, department)
);

ALTER TABLE forms.form_department_shares ENABLE ROW LEVEL SECURITY;

-- Creators and admins can manage shares
CREATE POLICY "Manage department shares"
  ON forms.form_department_shares
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

-- All authenticated users can read shares (app layer applies department filter)
CREATE POLICY "Read department shares"
  ON forms.form_department_shares FOR SELECT
  USING (auth.role() = 'authenticated');
