-- Re-apply of Uploaded/20260624000002_submission_custom_columns.sql --
-- discovered live 2026-09-18 while building submission_shares
-- (20260930ag) that forms.submission_columns / submission_column_values /
-- response_overrides genuinely do not exist in production at all, despite
-- living under migrations/Uploaded/ (this repo's own "applied" convention)
-- and despite FormResultsPage.tsx actively reading/writing all three today
-- -- confirmed via information_schema.tables showing only
-- assignments/condition_rules/field_conditions/fields/
-- form_department_shares/forms/responses/score_streaks/submissions in the
-- forms schema. This is the exact same class of bug CLAUDE.md's own
-- Migration status section warns about (an "Uploaded" migration that was
-- written but never actually ran) -- same precedent as
-- 20260817_forms_visibility_reapply.sql.
--
-- Real production impact: every submission_columns/submission_column_values
-- select in FormResultsPage.tsx has been erroring with "relation does not
-- exist" and silently degrading to an empty array (Supabase JS's
-- `data ?? []` swallows the error rather than throwing), so the "Add
-- Column" tracking-column feature and the response-override ("Overrides"
-- stat, click-to-edit cells) feature have shown as simply always-empty on
-- every form's Results page this whole time, with no visible error --
-- never actually broken UI, just a feature nobody could tell was dead.
-- CREATE TABLE IF NOT EXISTS / plain CREATE POLICY (no IF NOT EXISTS
-- available for policies, but these have never existed either) below is
-- an exact copy of the original file's body.
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
  original_value_text text,
  original_value_array text[],
  original_value_option_id text,
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

DROP POLICY IF EXISTS "Manage submission columns" ON forms.submission_columns;
CREATE POLICY "Manage submission columns"
  ON forms.submission_columns
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

DROP POLICY IF EXISTS "Read submission columns" ON forms.submission_columns;
CREATE POLICY "Read submission columns"
  ON forms.submission_columns FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manage column values" ON forms.submission_column_values;
CREATE POLICY "Manage column values"
  ON forms.submission_column_values
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manage response overrides" ON forms.response_overrides;
CREATE POLICY "Manage response overrides"
  ON forms.response_overrides
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Read response overrides" ON forms.response_overrides;
CREATE POLICY "Read response overrides"
  ON forms.response_overrides FOR SELECT
  USING (auth.role() = 'authenticated');

-- Learned live the same day on forms.forms (20260930af) and again on
-- submission_shares (20260930ag) -- a table GRANT is checked before RLS
-- ever runs, and separately, these 3 tables need anon SELECT/INSERT/UPDATE
-- too so the new submission_shares public RPCs (SECURITY DEFINER, but
-- still worth granting directly since these tables are legitimately
-- forms-schema data other future anon-facing RPCs may touch) aren't
-- silently limited by a missing grant later.
GRANT SELECT, INSERT, UPDATE, DELETE ON forms.submission_columns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON forms.submission_column_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON forms.response_overrides TO authenticated;
