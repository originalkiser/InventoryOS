-- Enhance core.location_data_source to support multiple sources per company,
-- flexible connection config, field mappings, scheduled refresh, and write mode.
-- Uses ADD COLUMN IF NOT EXISTS throughout — safe to re-run.

ALTER TABLE core.location_data_source
  ADD COLUMN IF NOT EXISTS company_id        uuid,
  ADD COLUMN IF NOT EXISTS name              text,
  ADD COLUMN IF NOT EXISTS target_schema     text DEFAULT 'inventory',
  ADD COLUMN IF NOT EXISTS target_table      text DEFAULT 'locations',
  ADD COLUMN IF NOT EXISTS connection_config jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS field_mappings    jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS refresh_schedule  jsonb DEFAULT '{"mode":"manual","times":[]}',
  ADD COLUMN IF NOT EXISTS write_mode        text DEFAULT 'replace_source_data',
  ADD COLUMN IF NOT EXISTS active            boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_tested_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_status  text,
  ADD COLUMN IF NOT EXISTS last_test_error   text;

-- Extend source_type to support additional source types
ALTER TABLE core.location_data_source
  DROP CONSTRAINT IF EXISTS location_data_source_source_type_check;

ALTER TABLE core.location_data_source
  ADD CONSTRAINT location_data_source_source_type_check
  CHECK (source_type IN (
    'manual', 'monday', 'azure_datalake', 'onedrive',
    'powerbi_datalake', 'power_automate', 'generic_api', 'azure_blob'
  ));

-- Update RLS: scope reads to own company (or legacy null rows readable by all)
DROP POLICY IF EXISTS "authenticated_read_location_data_source" ON core.location_data_source;
DROP POLICY IF EXISTS "admin_dev_manage_location_data_source"   ON core.location_data_source;

CREATE POLICY "company_read_location_data_source"
  ON core.location_data_source FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND (
      company_id IS NULL
      OR company_id = (
        SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
      )
    )
  );

CREATE POLICY "admin_dev_manage_location_data_source"
  ON core.location_data_source FOR ALL
  USING (
    (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('developer', 'administrator')
    AND (
      company_id IS NULL
      OR company_id = (
        SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
      )
    )
  );

NOTIFY pgrst, 'reload schema';
