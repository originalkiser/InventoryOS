-- Marketing Planner module
-- Schema + tables + RLS + PostgREST grants
-- Seed data applied separately via the UI "Seed Defaults" button

CREATE SCHEMA IF NOT EXISTS marketing;

-- ─── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketing.campaign_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL,
  name           text NOT NULL,
  category       text NOT NULL,
  description    text,
  is_active      boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);

CREATE TABLE IF NOT EXISTS marketing.campaign_template_tasks (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_template_id   uuid NOT NULL REFERENCES marketing.campaign_templates(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  description            text,
  is_required            boolean NOT NULL DEFAULT true,
  default_status         text NOT NULL DEFAULT 'not_started',
  is_active              boolean NOT NULL DEFAULT true,
  sort_order             integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid
);

CREATE TABLE IF NOT EXISTS marketing.monthly_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  location_id  uuid NOT NULL,
  plan_month   integer NOT NULL CHECK (plan_month BETWEEN 1 AND 12),
  plan_year    integer NOT NULL CHECK (plan_year >= 2020),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  UNIQUE (company_id, location_id, plan_month, plan_year)
);

CREATE TABLE IF NOT EXISTS marketing.campaign_assignments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monthly_plan_id             uuid NOT NULL REFERENCES marketing.monthly_plans(id) ON DELETE CASCADE,
  campaign_template_id        uuid REFERENCES marketing.campaign_templates(id) ON DELETE SET NULL,
  campaign_name_snapshot      text NOT NULL,
  campaign_category_snapshot  text NOT NULL,
  status                      text NOT NULL DEFAULT 'active',
  sort_order                  integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid,
  UNIQUE (monthly_plan_id, campaign_template_id)
);

CREATE TABLE IF NOT EXISTS marketing.campaign_tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_assignment_id   uuid NOT NULL REFERENCES marketing.campaign_assignments(id) ON DELETE CASCADE,
  template_task_id         uuid REFERENCES marketing.campaign_template_tasks(id) ON DELETE SET NULL,
  task_name_snapshot       text NOT NULL,
  task_description_snapshot text,
  status                   text NOT NULL DEFAULT 'not_started'
                           CHECK (status IN ('not_started','in_progress','complete','blocked','not_applicable')),
  is_required              boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  notes                    text,
  completed_at             timestamptz,
  completed_by             uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid
);

-- ─── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_mkt_templates_company   ON marketing.campaign_templates (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_mkt_tmpl_tasks_template ON marketing.campaign_template_tasks (campaign_template_id, is_active);
CREATE INDEX IF NOT EXISTS idx_mkt_plans_company_month ON marketing.monthly_plans (company_id, plan_year, plan_month);
CREATE INDEX IF NOT EXISTS idx_mkt_plans_location      ON marketing.monthly_plans (location_id);
CREATE INDEX IF NOT EXISTS idx_mkt_assignments_plan    ON marketing.campaign_assignments (monthly_plan_id);
CREATE INDEX IF NOT EXISTS idx_mkt_tasks_assignment    ON marketing.campaign_tasks (campaign_assignment_id, status);

-- ─── Row-level security ────────────────────────────────────────────────────

ALTER TABLE marketing.campaign_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.campaign_template_tasks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.monthly_plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.campaign_assignments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.campaign_tasks           ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'marketing' AND tablename = 'campaign_templates' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON marketing.campaign_templates       FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'marketing' AND tablename = 'campaign_template_tasks' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON marketing.campaign_template_tasks  FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'marketing' AND tablename = 'monthly_plans' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON marketing.monthly_plans            FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'marketing' AND tablename = 'campaign_assignments' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON marketing.campaign_assignments     FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'marketing' AND tablename = 'campaign_tasks' AND policyname = 'auth_all') THEN
    CREATE POLICY auth_all ON marketing.campaign_tasks           FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── PostgREST access ──────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA marketing TO anon, authenticated;
GRANT ALL ON ALL TABLES    IN SCHEMA marketing TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA marketing TO anon, authenticated;
