-- Multiple checklist items per calendar event, each with its own optional date
-- window (target_date = start, target_date_end = due-by). Lets a checklist item
-- have a deadline range instead of matching the event's date/time, and lets one
-- event carry several items.
CREATE TABLE IF NOT EXISTS platform.event_checklist_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL,
  event_id        uuid        NOT NULL,
  title           text        NOT NULL,
  target_date     date,
  target_date_end date,
  completed       boolean     NOT NULL DEFAULT false,
  completed_at    timestamptz,
  completed_by    uuid,
  sort_order      integer     NOT NULL DEFAULT 0,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_checklist_items_event
  ON platform.event_checklist_items (company_id, event_id);

ALTER TABLE platform.event_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "eci_select" ON platform.event_checklist_items;
CREATE POLICY "eci_select" ON platform.event_checklist_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "eci_insert" ON platform.event_checklist_items;
CREATE POLICY "eci_insert" ON platform.event_checklist_items FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "eci_update" ON platform.event_checklist_items;
CREATE POLICY "eci_update" ON platform.event_checklist_items FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "eci_delete" ON platform.event_checklist_items;
CREATE POLICY "eci_delete" ON platform.event_checklist_items FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
