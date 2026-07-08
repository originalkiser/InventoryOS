-- Droptop integration: operation ID mapping on locations + sync audit log.
-- Safe to apply before or after 20260702b_locations_schema_overhaul.sql.

-- droptop_operation_id is already in 20260702b but that migration may be pending.
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS droptop_operation_id text;

-- Droptop sync audit log
CREATE TABLE IF NOT EXISTS inventory.droptop_sync_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  operations_count  integer,
  products_upserted integer,
  status            text NOT NULL DEFAULT 'success',
  error_message     text
);

CREATE INDEX IF NOT EXISTS idx_droptop_sync_log_company
  ON inventory.droptop_sync_log(company_id, synced_at DESC);
