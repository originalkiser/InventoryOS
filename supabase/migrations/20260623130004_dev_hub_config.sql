-- Developer Hub config metadata table (non-sensitive values only)
-- Actual secrets live in vault.secrets — referenced by vault_secret_name

CREATE TABLE IF NOT EXISTS platform.dev_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  config_key text NOT NULL,
  config_value text,                 -- non-sensitive values only (tenant IDs, URLs, etc.)
  is_secret boolean DEFAULT false,   -- if true, actual value is in vault.secrets
  vault_secret_name text,            -- name of the vault secret for this config
  description text,
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company_id, config_key)
);

ALTER TABLE platform.dev_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Developer role can read/write dev_config" ON platform.dev_config;
CREATE POLICY "Developer role can read/write dev_config"
  ON platform.dev_config FOR ALL
  USING (
    company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) = 'developer'
  )
  WITH CHECK (
    company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) = 'developer'
  );
