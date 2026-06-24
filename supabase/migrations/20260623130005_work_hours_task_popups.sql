-- Work hours config on user profiles + task popup scheduling support

-- Add work hours config to platform.user_profiles
ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS work_start_time time DEFAULT '08:00:00',
  ADD COLUMN IF NOT EXISTS work_end_time time DEFAULT '17:00:00',
  ADD COLUMN IF NOT EXISTS eod_review_time time DEFAULT '16:45:00',
  ADD COLUMN IF NOT EXISTS task_popups_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS eod_review_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS popup_timezone text DEFAULT 'America/Chicago',
  ADD COLUMN IF NOT EXISTS browser_notifications_enabled boolean DEFAULT false;

-- Task popup_time: optional time-of-day to surface a popup for this task
ALTER TABLE inventory.tasks
  ADD COLUMN IF NOT EXISTS popup_time time;

-- Task dismissal log — scoped to calendar date, not persistent across days
CREATE TABLE IF NOT EXISTS inventory.task_popup_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES inventory.tasks(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  dismissed_at timestamptz DEFAULT now(),
  dismissed_for_date date NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(task_id, user_id, dismissed_for_date)
);

CREATE INDEX IF NOT EXISTS idx_task_popup_dismissals_user ON inventory.task_popup_dismissals (user_id, dismissed_for_date);

ALTER TABLE inventory.task_popup_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own dismissals" ON inventory.task_popup_dismissals;
CREATE POLICY "Users manage own dismissals"
  ON inventory.task_popup_dismissals FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
