-- Recurring / scheduled assignment rules and their execution log

CREATE TABLE IF NOT EXISTS forms.assignment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms.forms(id) ON DELETE CASCADE,
  rule_name text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('interval', 'set_dates', 'file_import')),
  -- Interval fields
  interval_unit text CHECK (interval_unit IN ('day', 'week', 'month', 'quarter', 'year')),
  interval_value integer,
  interval_start_date date,
  -- Set-dates fields
  set_dates date[],
  -- Assignee config (shared across rule types)
  assign_to_type text CHECK (assign_to_type IN ('users', 'locations', 'department')),
  assign_to_users uuid[],
  assign_to_locations uuid[],
  assign_to_department text,
  due_offset_days integer DEFAULT 7,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Tracks which fire dates have already been processed to prevent duplicates
CREATE TABLE IF NOT EXISTS forms.assignment_rule_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES forms.assignment_rules(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES forms.assignments(id),
  fired_at timestamptz DEFAULT now(),
  due_date date
);

ALTER TABLE forms.assignment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE forms.assignment_rule_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Manage assignment rules"
  ON forms.assignment_rules
  USING (
    form_id IN (SELECT id FROM forms.forms WHERE created_by = auth.uid())
    OR (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('administrator', 'developer')
  );

CREATE POLICY "Read assignment rules"
  ON forms.assignment_rules FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Read assignment rule log"
  ON forms.assignment_rule_log FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Manage assignment rule log"
  ON forms.assignment_rule_log
  USING (auth.role() = 'authenticated');
