-- Location Data Source config: defines where location data is pulled from.
-- Single-row table — app inserts a default row on first load if none exists.

CREATE TABLE IF NOT EXISTS core.location_data_source (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type           text        NOT NULL DEFAULT 'manual'
                          CHECK (source_type IN ('manual', 'monday', 'azure_datalake')),
  -- Monday.com specific
  monday_board_id       text,
  monday_name_column    text,
  monday_code_column    text,
  monday_region_column  text,
  monday_market_column  text,
  monday_status_filter  text        DEFAULT 'active',
  -- Azure Data Lake specific
  azure_container_path  text,
  -- Shared
  sync_schedule         text        DEFAULT 'manual'
                          CHECK (sync_schedule IN ('manual', '15min', '1hour', 'daily')),
  last_synced_at        timestamptz,
  last_sync_count       integer,
  updated_by            uuid        REFERENCES auth.users(id),
  updated_at            timestamptz DEFAULT now()
);

ALTER TABLE core.location_data_source ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_location_data_source"
  ON core.location_data_source FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "admin_dev_manage_location_data_source"
  ON core.location_data_source FOR ALL
  USING ((SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('developer', 'administrator'));
