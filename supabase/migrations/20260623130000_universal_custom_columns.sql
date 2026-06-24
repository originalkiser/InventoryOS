-- Universal custom columns system — replaces issue-specific issue_tracker_columns
-- and extends to all tables in the app via table_key.

-- Generic column definition table
CREATE TABLE IF NOT EXISTS platform.custom_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  table_key text NOT NULL,        -- e.g. 'inventory.issues', 'core.locations'
  label text NOT NULL,
  column_type text NOT NULL DEFAULT 'text'
    CHECK (column_type IN ('text', 'number', 'date', 'status', 'checkbox', 'select', 'user')),
  options jsonb DEFAULT '[]',     -- for 'status' and 'select' types: [{ label, color }]
  sort_order integer DEFAULT 0,
  width integer DEFAULT 160,
  is_pinned boolean DEFAULT false,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(company_id, table_key, label)
);

CREATE INDEX IF NOT EXISTS idx_custom_columns_company_table ON platform.custom_columns (company_id, table_key, sort_order);

-- Generic custom values store
CREATE TABLE IF NOT EXISTS platform.custom_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  column_id uuid NOT NULL REFERENCES platform.custom_columns(id) ON DELETE CASCADE,
  row_id uuid NOT NULL,           -- ID of the row in the target table
  company_id uuid NOT NULL,
  table_key text NOT NULL,        -- matches custom_columns.table_key — for efficient lookup
  value text,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(column_id, row_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_values_column ON platform.custom_values (column_id, row_id);
CREATE INDEX IF NOT EXISTS idx_custom_values_table ON platform.custom_values (company_id, table_key);

-- RLS
ALTER TABLE platform.custom_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.custom_values ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company members read custom_columns" ON platform.custom_columns;
CREATE POLICY "Company members read custom_columns"
  ON platform.custom_columns FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Admin/dev manage custom_columns" ON platform.custom_columns;
CREATE POLICY "Admin/dev manage custom_columns"
  ON platform.custom_columns FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Company members read custom_values" ON platform.custom_values;
CREATE POLICY "Company members read custom_values"
  ON platform.custom_values FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Company members write custom_values" ON platform.custom_values;
CREATE POLICY "Company members write custom_values"
  ON platform.custom_values FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Migrate existing issue_tracker_columns → platform.custom_columns
INSERT INTO platform.custom_columns (id, company_id, table_key, label, column_type, sort_order, width, is_pinned, created_at)
SELECT id, company_id, 'inventory.issues', label, type, sort_order, width, COALESCE(pinned, false), created_at
FROM inventory.issue_tracker_columns
ON CONFLICT (company_id, table_key, label) DO NOTHING;

-- Migrate existing issue_custom_values → platform.custom_values
INSERT INTO platform.custom_values (column_id, row_id, company_id, table_key, value)
SELECT column_id, issue_id, company_id, 'inventory.issues', value
FROM inventory.issue_custom_values
ON CONFLICT (column_id, row_id) DO NOTHING;

-- Pre-seed classification columns for locations
-- These appear for every company via a separate seed pattern (no company_id) or
-- are inserted per-company on first access. Seed here for existing companies:
INSERT INTO platform.custom_columns (company_id, table_key, label, column_type, sort_order)
SELECT DISTINCT company_id, 'core.locations', 'Area Manager', 'user', 10
FROM platform.user_profiles
ON CONFLICT (company_id, table_key, label) DO NOTHING;

INSERT INTO platform.custom_columns (company_id, table_key, label, column_type, sort_order)
SELECT DISTINCT company_id, 'core.locations', 'Market', 'text', 20
FROM platform.user_profiles
ON CONFLICT (company_id, table_key, label) DO NOTHING;

INSERT INTO platform.custom_columns (company_id, table_key, label, column_type, sort_order)
SELECT DISTINCT company_id, 'core.locations', 'Director', 'user', 30
FROM platform.user_profiles
ON CONFLICT (company_id, table_key, label) DO NOTHING;

INSERT INTO platform.custom_columns (company_id, table_key, label, column_type, sort_order)
SELECT DISTINCT company_id, 'core.locations', 'Region', 'text', 40
FROM platform.user_profiles
ON CONFLICT (company_id, table_key, label) DO NOTHING;

INSERT INTO platform.custom_columns (company_id, table_key, label, column_type, sort_order)
SELECT DISTINCT company_id, 'core.locations', 'District', 'text', 50
FROM platform.user_profiles
ON CONFLICT (company_id, table_key, label) DO NOTHING;

-- Realtime
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE platform.custom_columns;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE platform.custom_values;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
