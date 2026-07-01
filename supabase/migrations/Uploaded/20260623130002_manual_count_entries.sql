-- Manual count override for locations that counted but didn't upload a file

CREATE TABLE IF NOT EXISTS inventory.manual_count_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES core.locations(id) ON DELETE CASCADE,
  count_period text NOT NULL,       -- e.g. '2026-06' — matches the monthly count period
  count_type text,                  -- same count_type values as uploaded counts
  performed_by uuid REFERENCES auth.users(id),
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(company_id, location_id, count_period)
);

CREATE INDEX IF NOT EXISTS idx_manual_count_entries_period ON inventory.manual_count_entries (company_id, count_period);

ALTER TABLE inventory.manual_count_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Company members read manual_count_entries" ON inventory.manual_count_entries;
CREATE POLICY "Company members read manual_count_entries"
  ON inventory.manual_count_entries FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Admin manage manual_count_entries" ON inventory.manual_count_entries;
CREATE POLICY "Admin manage manual_count_entries"
  ON inventory.manual_count_entries FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
