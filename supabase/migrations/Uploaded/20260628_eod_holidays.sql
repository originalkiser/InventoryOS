-- Add task-push behaviour settings to user profiles
ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS auto_push_tasks boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_weekends_holidays boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocked_days jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Company-shared holiday calendar (used for skip-weekends-&-holidays push logic)
CREATE TABLE IF NOT EXISTS core.company_holidays (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  date        date        NOT NULL,
  name        text        NOT NULL DEFAULT '',
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, date)
);

ALTER TABLE core.company_holidays ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_holidays_select" ON core.company_holidays
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "company_holidays_insert" ON core.company_holidays
  FOR INSERT WITH CHECK (company_id = get_my_company_id());

CREATE POLICY "company_holidays_delete" ON core.company_holidays
  FOR DELETE USING (company_id = get_my_company_id());
