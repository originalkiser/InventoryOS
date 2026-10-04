-- Orders v2: cancel (keeps the order in the list, shown red/struck-through) and soft delete (kept 90 days in a
-- "Deleted" list and restorable, then purged nightly).
ALTER TABLE inventory.ov2_order_drafts
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by          uuid,
  ADD COLUMN IF NOT EXISTS status_before_cancel text;

CREATE INDEX IF NOT EXISTS idx_ov2_drafts_deleted
  ON inventory.ov2_order_drafts (company_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory.purge_deleted_ov2_drafts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = inventory, pg_temp AS $$
DECLARE n integer;
BEGIN
  -- ON DELETE CASCADE removes the draft's lines with it.
  DELETE FROM inventory.ov2_order_drafts WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION inventory.purge_deleted_ov2_drafts() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('purge-deleted-ov2-drafts', '30 4 * * *', $$SELECT inventory.purge_deleted_ov2_drafts()$$);
