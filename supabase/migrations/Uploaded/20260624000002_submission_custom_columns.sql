-- Custom columns on submission results table, column values, and response overrides

CREATE TABLE IF NOT EXISTS forms.submission_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  label text NOT NULL,
  column_type text NOT NULL CHECK (column_type IN ('text', 'number', 'date', 'status', 'checkbox', 'select', 'user')),
  options jsonb DEFAULT '[]',
  sort_order integer DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(form_id, label)
);

CREATE TABLE IF NOT EXISTS forms.submission_column_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES forms.submissions(id) ON DELETE CASCADE,
  column_id uuid NOT NULL REFERENCES forms.submission_columns(id) ON DELETE CASCADE,
  value text,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(submission_id, column_id)
);

-- Preserves the original submitted value when a reviewer overrides a response cell.
-- The responses table is immutable; this table is the display source of truth.
CREATE TABLE IF NOT EXISTS forms.response_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id uuid NOT NULL REFERENCES forms.responses(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES forms.submissions(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES forms.fields(id) ON DELETE CASCADE,
  -- Snapshot of original value at time of first override — never updated again
  original_value_text text,
  original_value_array text[],
  original_value_option_id text,
  -- Current displayed override value (updated in place on re-edit)
  override_value_text text,
  override_value_array text[],
  override_value_option_id text,
  overridden_by uuid REFERENCES auth.users(id),
  overridden_at timestamptz DEFAULT now(),
  override_note text,
  UNIQUE(response_id)
);

ALTER TABLE forms.submission_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.submission_column_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.response_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Manage submission columns"
  ON forms.submission_columns
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

CREATE POLICY "Read submission columns"
  ON forms.submission_columns FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Manage column values"
  ON forms.submission_column_values
  USING (auth.role() = 'authenticated');

CREATE POLICY "Manage response overrides"
  ON forms.response_overrides
  USING (auth.role() = 'authenticated');

CREATE POLICY "Read response overrides"
  ON forms.response_overrides FOR SELECT
  USING (auth.role() = 'authenticated');
