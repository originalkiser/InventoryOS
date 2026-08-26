-- Connection-agnostic sync history, feeding the new "Data Connection
-- Updates" section on the Inventory Alerts page. Additive alongside the
-- existing inventory.droptop_sync_log (which other panels — MonthEndPullPanel,
-- ProductUsageTab — already read from directly and keep using unchanged);
-- this table exists so multiple connections (Droptop, SkyBitz tanks, and
-- whatever comes next) can be displayed together in one history list with a
-- consistent shape, including duration and an "unchanged" count that neither
-- droptop_sync_log nor locations_sync_log track today.

CREATE TABLE IF NOT EXISTS inventory.data_connection_sync_log (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  connection         text        NOT NULL,  -- 'droptop' | 'skybitz_tanks' | ...
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL DEFAULT now(),
  duration_ms        integer,
  items_updated      integer,
  items_unchanged    integer,
  items_inserted     integer,
  status             text        NOT NULL DEFAULT 'success', -- success|partial|error
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_conn_sync_log_company_time
  ON inventory.data_connection_sync_log (company_id, finished_at DESC);

ALTER TABLE inventory.data_connection_sync_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "data_conn_sync_log_select" ON inventory.data_connection_sync_log;
CREATE POLICY "data_conn_sync_log_select" ON inventory.data_connection_sync_log FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Insert-only from server-side (service role) Edge Functions — no
-- authenticated-user insert/update/delete policy needed.
