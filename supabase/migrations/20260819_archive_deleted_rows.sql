-- ============================================================
-- archive schema — keep a copy of every deleted row for tables whose ids
-- other records point at.
--
-- Why: rows in these tables are referenced by id from elsewhere, and those
-- references are plain uuid columns with no foreign key. Deleting a row
-- (or clearing + re-uploading a table, which is a delete plus fresh ids)
-- silently orphans everything pointing at it — it doesn't error, it just
-- stops matching. That is exactly how a locations replace detached 36
-- exception reports, 23 location comms and a project's assignments, with
-- no in-database way to rebuild the mapping afterward.
--
-- This captures the full pre-delete row as jsonb, so the old id -> business
-- key mapping survives and a restore is a single INSERT (recipes at the
-- bottom of this file).
--
-- Trigger-based on purpose: it catches deletes from the app, the SQL
-- editor, Edge Functions and scripts alike, rather than only the paths the
-- frontend happens to route through.
--
-- Safe to re-run.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS archive;

CREATE TABLE IF NOT EXISTS archive.deleted_rows (
  id           bigserial   PRIMARY KEY,
  schema_name  text        NOT NULL,
  table_name   text        NOT NULL,
  row_id       uuid,                       -- the deleted row's own id
  company_id   uuid,                       -- for tenant-scoped reads
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  deleted_by   uuid,                       -- auth.uid() when deleted via the app
  row_data     jsonb       NOT NULL        -- the complete row, pre-delete
);

CREATE INDEX IF NOT EXISTS idx_archive_deleted_rows_table
  ON archive.deleted_rows (schema_name, table_name, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_deleted_rows_row_id
  ON archive.deleted_rows (row_id);
CREATE INDEX IF NOT EXISTS idx_archive_deleted_rows_company
  ON archive.deleted_rows (company_id, deleted_at DESC);

-- Generic capture trigger. SECURITY DEFINER so it can always write to the
-- archive regardless of the deleting role's grants; empty search_path so
-- every reference below has to be fully qualified (prevents search-path
-- hijacking of a definer function).
CREATE OR REPLACE FUNCTION archive.capture_deleted_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  payload jsonb := to_jsonb(OLD);
BEGIN
  INSERT INTO archive.deleted_rows (schema_name, table_name, row_id, company_id, deleted_by, row_data)
  VALUES (
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    NULLIF(payload ->> 'id', '')::uuid,
    NULLIF(payload ->> 'company_id', '')::uuid,
    auth.uid(),
    payload
  );
  RETURN OLD;
END
$$;

-- Attach to the tables where a delete can orphan other records. Add to this
-- list whenever a new table gets referenced by id from somewhere else.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('core',      'locations'),           -- referenced by ~10 tables; the costly one
      ('core',      'pos_location_map'),
      ('inventory', 'vendors'),             -- vendor_parts.vendor_id, location_order_config.vendor_id
      ('inventory', 'vendor_parts'),
      ('inventory', 'issue_statuses'),      -- platform.issues.status_id
      ('inventory', 'issue_categories'),    -- platform.issues.category_id
      ('platform',  'departments')          -- user_department_memberships, forms shares, issues
    ) AS v(schema_name, table_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = t.schema_name AND c.relname = t.table_name AND c.relkind = 'r'
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I.%I', t.schema_name, t.table_name);
      EXECUTE format(
        'CREATE TRIGGER trg_archive_deleted AFTER DELETE ON %I.%I
           FOR EACH ROW EXECUTE FUNCTION archive.capture_deleted_row()',
        t.schema_name, t.table_name
      );
    END IF;
  END LOOP;
END
$$;

-- Readable by members of the same company. Writes only ever happen through
-- the SECURITY DEFINER trigger above, so no insert/update/delete policy is
-- granted — the archive is append-only from the application's perspective.
ALTER TABLE archive.deleted_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "archive_select_own_company" ON archive.deleted_rows;
CREATE POLICY "archive_select_own_company" ON archive.deleted_rows FOR SELECT
  USING (
    company_id IS NULL
    OR company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
  );

-- ============================================================
-- Restore recipes (run by hand in the SQL editor)
-- ============================================================
--
-- 1. What was deleted, and when:
--
--   SELECT deleted_at, count(*), min(row_data ->> 'name') AS sample
--   FROM archive.deleted_rows
--   WHERE schema_name = 'core' AND table_name = 'locations'
--   GROUP BY deleted_at ORDER BY deleted_at DESC;
--
-- 2. Restore rows with their ORIGINAL ids (the point of all this — every
--    reference that pointed at them starts resolving again).
--    jsonb_populate_recordset maps by column name, so columns added since
--    the delete simply take their defaults:
--
--   INSERT INTO core.locations
--   SELECT * FROM jsonb_populate_recordset(NULL::core.locations, (
--     SELECT jsonb_agg(row_data) FROM archive.deleted_rows
--     WHERE schema_name = 'core' AND table_name = 'locations'
--       AND deleted_at >= '2026-08-19'::date
--   ))
--   ON CONFLICT (id) DO NOTHING;
--
-- 3. If the rows were already re-created under NEW ids (a clear + re-upload)
--    restoring the old ones would duplicate every shop. Instead, use the
--    archive purely as the old-id -> business-key map and repoint the
--    orphaned children:
--
--   CREATE TEMP TABLE loc_remap AS
--   SELECT (a.row_data ->> 'id')::uuid AS old_id, l.id AS new_id
--   FROM archive.deleted_rows a
--   JOIN core.locations l
--     ON lower(trim(l.name)) = lower(trim(a.row_data ->> 'name'))
--   WHERE a.schema_name = 'core' AND a.table_name = 'locations'
--     AND (a.row_data ->> 'id')::uuid <> l.id;
--
--   -- verify 1:1 (must return no rows), then:
--   UPDATE inventory.exception_reports e SET location_id = m.new_id
--     FROM loc_remap m WHERE m.old_id = e.location_id;
--
-- 4. Pruning, if the archive ever grows large:
--
--   DELETE FROM archive.deleted_rows WHERE deleted_at < now() - interval '1 year';
-- ============================================================

NOTIFY pgrst, 'reload schema';
