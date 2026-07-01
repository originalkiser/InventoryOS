-- Form Builder Module
-- All tables in the `forms` schema

CREATE SCHEMA IF NOT EXISTS forms;

-- ── Form Definitions ──────────────────────────────────────────────────────────

CREATE TABLE forms.forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid,
  title text NOT NULL,
  description text,
  department text NOT NULL DEFAULT 'All',
  created_by uuid REFERENCES auth.users(id),
  share_token text UNIQUE DEFAULT gen_random_uuid()::text,
  is_published boolean DEFAULT false,
  is_accepting_responses boolean DEFAULT true,
  show_score_to_respondent boolean DEFAULT false,
  allow_multiple_submissions boolean DEFAULT false,
  requires_login boolean DEFAULT false,
  theme jsonb DEFAULT '{
    "preset": "sb_dark",
    "header_logo_key": null,
    "colors": {
      "background":   "#002745",
      "surface":      "#0D3555",
      "primary":      "#4F7489",
      "accent":       "#B7E0DE",
      "text":         "#F2F1E6",
      "label":        "#B7E0DE",
      "input_bg":     "#0D3555",
      "input_border": "#4F7489",
      "button_bg":    "#4F7489",
      "button_text":  "#FFFFFF"
    }
  }',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- ── Form Fields ───────────────────────────────────────────────────────────────

CREATE TABLE forms.fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  field_type text NOT NULL CHECK (field_type IN (
    'text_block', 'short_answer', 'long_answer', 'multiple_choice',
    'multi_select', 'dropdown', 'file_upload', 'date', 'number', 'calculation'
  )),
  label text NOT NULL,
  placeholder text,
  helper_text text,
  is_required boolean DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  options jsonb DEFAULT '[]',
  calculation_config jsonb DEFAULT '{}',
  file_types_allowed text[],
  max_file_size_mb integer DEFAULT 25,
  content text,
  created_at timestamptz DEFAULT now()
);

-- ── Conditional Logic ─────────────────────────────────────────────────────────

CREATE TABLE forms.field_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  target_field_id uuid NOT NULL REFERENCES forms.fields(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('show', 'hide')),
  logic_operator text NOT NULL DEFAULT 'and' CHECK (logic_operator IN ('and', 'or')),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE forms.condition_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_id uuid NOT NULL REFERENCES forms.field_conditions(id) ON DELETE CASCADE,
  source_field_id uuid NOT NULL REFERENCES forms.fields(id) ON DELETE CASCADE,
  operator text NOT NULL CHECK (operator IN (
    'equals', 'not_equals', 'contains', 'not_contains',
    'greater_than', 'less_than', 'is_answered', 'is_empty'
  )),
  value text,
  created_at timestamptz DEFAULT now()
);

-- ── Form Assignments ──────────────────────────────────────────────────────────

CREATE TABLE forms.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES auth.users(id),
  assigned_to_location uuid REFERENCES core.locations(id),
  due_date date,
  assigned_by uuid REFERENCES auth.users(id),
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ── Submissions ───────────────────────────────────────────────────────────────

CREATE TABLE forms.submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id),
  submitted_by uuid REFERENCES auth.users(id),
  respondent_email text,
  respondent_name text,
  location_id uuid REFERENCES core.locations(id),
  assignment_id uuid REFERENCES forms.assignments(id),
  total_score numeric,
  max_possible_score numeric,
  submitted_at timestamptz DEFAULT now(),
  ip_address text
);

-- ── Submission Responses ──────────────────────────────────────────────────────

CREATE TABLE forms.responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES forms.submissions(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES forms.fields(id),
  value_text text,
  value_array text[],
  value_option_id text,
  value_score numeric,
  file_paths text[],
  created_at timestamptz DEFAULT now(),
  UNIQUE(submission_id, field_id)
);

-- ── Score Streak Tracking ─────────────────────────────────────────────────────

CREATE TABLE forms.score_streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id),
  field_id uuid NOT NULL REFERENCES forms.fields(id),
  location_id uuid REFERENCES core.locations(id),
  streak_score numeric,
  streak_count integer DEFAULT 1,
  last_submission_id uuid REFERENCES forms.submissions(id),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(form_id, field_id, location_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE forms.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.field_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.condition_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.score_streaks ENABLE ROW LEVEL SECURITY;

-- Forms: published forms readable by anyone; all forms readable by authenticated users
CREATE POLICY "forms_read"
  ON forms.forms FOR SELECT
  USING (auth.role() = 'authenticated' OR is_published = true);

CREATE POLICY "forms_write"
  ON forms.forms
  USING (
    created_by = auth.uid()
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid())
       IN ('administrator', 'developer')
  );

-- Fields/conditions: follow parent form
CREATE POLICY "fields_read"
  ON forms.fields FOR SELECT
  USING (form_id IN (SELECT id FROM forms.forms));

CREATE POLICY "fields_write"
  ON forms.fields
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid())
       IN ('administrator', 'developer')
  );

CREATE POLICY "field_conditions_read"
  ON forms.field_conditions FOR SELECT
  USING (form_id IN (SELECT id FROM forms.forms));

CREATE POLICY "field_conditions_write"
  ON forms.field_conditions
  USING (form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer'));

CREATE POLICY "condition_rules_read"
  ON forms.condition_rules FOR SELECT
  USING (condition_id IN (SELECT id FROM forms.field_conditions));

CREATE POLICY "condition_rules_write"
  ON forms.condition_rules
  USING (condition_id IN (SELECT id FROM forms.field_conditions));

-- Assignments
CREATE POLICY "assignments_read"
  ON forms.assignments FOR SELECT
  USING (
    assigned_to = auth.uid()
    OR form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

CREATE POLICY "assignments_write"
  ON forms.assignments
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

-- Submissions: readable by form owner, admin, and submitter
CREATE POLICY "submissions_read"
  ON forms.submissions FOR SELECT
  USING (
    submitted_by = auth.uid()
    OR form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

CREATE POLICY "submissions_insert"
  ON forms.submissions FOR INSERT WITH CHECK (true);

-- Responses follow submission access
CREATE POLICY "responses_read"
  ON forms.responses FOR SELECT
  USING (submission_id IN (SELECT id FROM forms.submissions));

CREATE POLICY "responses_insert"
  ON forms.responses FOR INSERT WITH CHECK (true);

-- Score streaks: readable by form owner and admin
CREATE POLICY "score_streaks_read"
  ON forms.score_streaks FOR SELECT
  USING (form_id IN (SELECT id FROM forms.forms));

CREATE POLICY "score_streaks_write"
  ON forms.score_streaks
  USING (form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer'));

CREATE POLICY "score_streaks_upsert"
  ON forms.score_streaks FOR INSERT WITH CHECK (true);
