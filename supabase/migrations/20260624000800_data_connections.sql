-- Data Connections registry: centralized config for all external integrations.
-- Non-sensitive config values live here; secrets stay in vault.secrets.

CREATE TABLE IF NOT EXISTS platform.data_connections (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_key     text        NOT NULL UNIQUE,
  connection_name    text        NOT NULL,
  connection_type    text        NOT NULL CHECK (connection_type IN ('oauth', 'api_key', 'connection_string', 'readonly_status')),
  is_configured      boolean     DEFAULT false,
  config             jsonb       DEFAULT '{}',
  vault_secret_names text[]      DEFAULT '{}',
  last_tested_at     timestamptz,
  last_test_status   text        CHECK (last_test_status IN ('success', 'failed', 'untested')),
  last_test_message  text,
  updated_by         uuid        REFERENCES auth.users(id),
  updated_at         timestamptz DEFAULT now()
);

ALTER TABLE platform.data_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_dev_manage_connections"
  ON platform.data_connections
  USING ((SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('developer', 'administrator'));

CREATE POLICY "authenticated_read_connections"
  ON platform.data_connections FOR SELECT
  USING (auth.role() = 'authenticated');

-- Pre-seed standard connections
INSERT INTO platform.data_connections (connection_key, connection_name, connection_type, config, vault_secret_names)
VALUES
  ('azure_oauth',
   'Azure OAuth (Microsoft SSO)',
   'oauth',
   '{"tenant_id": null, "client_id": null, "redirect_uri": null, "allowed_domains": null}',
   ARRAY['azure_client_secret']),

  ('azure_datalake',
   'Azure Data Lake',
   'connection_string',
   '{"storage_account": null, "container": null, "tenant_id": null, "client_id": null, "sync_interval": "manual", "locations_path": null, "staff_path": null}',
   ARRAY['azure_datalake_client_secret']),

  ('monday',
   'Monday.com',
   'api_key',
   '{"board_id": null, "sync_direction": "pull", "sync_schedule": "manual"}',
   ARRAY['monday_api_token']),

  ('outlook',
   'Outlook / Microsoft Graph (Calendar)',
   'oauth',
   '{"calendar_scope": "read", "webhook_enabled": true}',
   ARRAY[]::text[]),

  ('supabase_status',
   'Supabase Project Status',
   'readonly_status',
   '{"project_ref": null, "region": null}',
   ARRAY['supabase_service_key'])

ON CONFLICT (connection_key) DO NOTHING;

-- Column prefs for per-user table column order + visibility (cross-device).
-- Structure: { "core.locations": { "order": [...], "hidden": [...] }, "dashboard.pills": { "order": [...], "hidden": [...] } }
ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS column_prefs jsonb DEFAULT '{}';
