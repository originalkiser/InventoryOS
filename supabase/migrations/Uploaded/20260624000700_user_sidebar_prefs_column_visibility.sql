-- Add column_visibility JSONB to user_sidebar_prefs.
-- Structure: { "locations": { "region": false, "updated_at": false }, ... }
-- Keyed by table name so multiple read-only tables can share one column.

ALTER TABLE core.user_sidebar_prefs
  ADD COLUMN IF NOT EXISTS column_visibility jsonb NOT NULL DEFAULT '{}';
