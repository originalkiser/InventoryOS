-- Meeting notes
CREATE TABLE IF NOT EXISTS meeting_notes (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT 'Untitled Meeting',
  meeting_date date,
  meeting_time time,
  vendor       text,
  category     text,
  notes        text,
  created_by   uuid REFERENCES profiles(id),
  created_at   timestamptz DEFAULT now() NOT NULL,
  updated_at   timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE meeting_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members" ON meeting_notes
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

-- Standalone + meeting-sourced tasks
CREATE TABLE IF NOT EXISTS tasks (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title        text NOT NULL,
  notes        text,
  target_date  date,
  completed    boolean DEFAULT false NOT NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES profiles(id),
  source       text DEFAULT 'manual',   -- 'manual' | 'meeting'
  meeting_id   uuid REFERENCES meeting_notes(id) ON DELETE SET NULL,
  sort_order   int DEFAULT 0,
  created_by   uuid REFERENCES profiles(id),
  created_at   timestamptz DEFAULT now() NOT NULL,
  updated_at   timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company members" ON tasks
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));
