-- Ensure outlier schema tables exist with correct structure and constraints.
-- All statements use IF NOT EXISTS so running twice is safe.

CREATE SCHEMA IF NOT EXISTS outlier;

CREATE TABLE IF NOT EXISTS outlier.departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  sort_order  int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outlier.reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id         uuid REFERENCES outlier.departments(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  slug                  text NOT NULL UNIQUE,
  description           text,
  columns               jsonb NOT NULL DEFAULT '[]',
  is_employee_report    boolean NOT NULL DEFAULT false,
  has_shop_column       boolean NOT NULL DEFAULT true,
  has_employee_column   boolean NOT NULL DEFAULT false,
  shop_column_label     text NOT NULL DEFAULT 'Location',
  employee_column_label text NOT NULL DEFAULT 'Employee',
  sort_order            int  NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlier.weeks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start  date NOT NULL UNIQUE,
  week_end    date NOT NULL,
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlier.report_entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id               uuid REFERENCES outlier.reports(id) ON DELETE CASCADE,
  week_id                 uuid REFERENCES outlier.weeks(id)   ON DELETE CASCADE,
  row_key                 text NOT NULL,
  row_label               text NOT NULL,
  row_type                text NOT NULL DEFAULT 'data',
  data                    jsonb NOT NULL DEFAULT '{}',
  am_comment              text,
  am_comment_updated_at   timestamptz,
  am_comment_updated_by   uuid,
  due_date                date,
  is_complete             boolean NOT NULL DEFAULT false,
  submitted_by            uuid,
  location_id             uuid,
  area_manager_name       text,
  rdo_name                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- The upsert uses onConflict:'report_id,week_id,row_key' — this constraint is required.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outlier.report_entries'::regclass
      AND contype   = 'u'
      AND conname   = 'report_entries_report_id_week_id_row_key_key'
  ) THEN
    ALTER TABLE outlier.report_entries
      ADD CONSTRAINT report_entries_report_id_week_id_row_key_key
      UNIQUE (report_id, week_id, row_key);
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS outlier.paste_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id            uuid REFERENCES outlier.reports(id) ON DELETE CASCADE,
  week_id              uuid REFERENCES outlier.weeks(id)   ON DELETE CASCADE,
  raw_text             text,
  parsed_row_count     int NOT NULL DEFAULT 0,
  submitted_by         uuid,
  submitted_by_override uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS (idempotent)
ALTER TABLE outlier.departments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlier.reports        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlier.weeks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlier.report_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlier.paste_logs     ENABLE ROW LEVEL SECURITY;

-- Broad authenticated access (add company scoping later if needed)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='outlier' AND tablename='departments'    AND policyname='auth_sel_departments')    THEN CREATE POLICY auth_sel_departments    ON outlier.departments    FOR SELECT TO authenticated USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='outlier' AND tablename='reports'        AND policyname='auth_sel_reports')        THEN CREATE POLICY auth_sel_reports        ON outlier.reports        FOR SELECT TO authenticated USING (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='outlier' AND tablename='weeks'          AND policyname='auth_all_weeks')          THEN CREATE POLICY auth_all_weeks          ON outlier.weeks          FOR ALL    TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='outlier' AND tablename='report_entries' AND policyname='auth_all_report_entries') THEN CREATE POLICY auth_all_report_entries ON outlier.report_entries FOR ALL    TO authenticated USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='outlier' AND tablename='paste_logs'     AND policyname='auth_all_paste_logs')     THEN CREATE POLICY auth_all_paste_logs     ON outlier.paste_logs     FOR ALL    TO authenticated USING (true) WITH CHECK (true); END IF;
END$$;

-- ── core.user_sidebar_prefs RLS ──────────────────────────────────────────────
-- Table was created in the initial schema; add policies if missing.

ALTER TABLE core.user_sidebar_prefs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='core' AND tablename='user_sidebar_prefs' AND policyname='own_sidebar_prefs_select') THEN
    CREATE POLICY own_sidebar_prefs_select ON core.user_sidebar_prefs
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='core' AND tablename='user_sidebar_prefs' AND policyname='own_sidebar_prefs_upsert') THEN
    CREATE POLICY own_sidebar_prefs_upsert ON core.user_sidebar_prefs
      FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END$$;
