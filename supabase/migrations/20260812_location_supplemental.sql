-- Supplemental location data: extra columns keyed to a location, uploaded
-- separately from the main location list (e.g. RD Distributor). Arbitrary
-- columns live in the `data` jsonb so new fields don't need schema changes.
CREATE TABLE IF NOT EXISTS core.location_supplemental (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid,
  data               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_supplemental_company
  ON core.location_supplemental (company_id, location_id);

ALTER TABLE core.location_supplemental ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loc_suppl_select" ON core.location_supplemental;
CREATE POLICY "loc_suppl_select" ON core.location_supplemental FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "loc_suppl_insert" ON core.location_supplemental;
CREATE POLICY "loc_suppl_insert" ON core.location_supplemental FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "loc_suppl_update" ON core.location_supplemental;
CREATE POLICY "loc_suppl_update" ON core.location_supplemental FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "loc_suppl_delete" ON core.location_supplemental;
CREATE POLICY "loc_suppl_delete" ON core.location_supplemental FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
