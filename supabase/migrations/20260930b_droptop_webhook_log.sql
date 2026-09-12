-- Droptop webhook delivery log — one row per delivery attempt, keyed by
-- Droptop's own delivery id (the "id" field in every webhook payload, e.g.
-- "WDELIV3565875554211089410"). Doubles as the idempotency guard: the
-- webhook function checks whether a delivery id already logged 'success'
-- before doing any real work, so a Droptop-side retry/manual resend of the
-- same delivery is a fast no-op instead of reprocessing.
CREATE TABLE IF NOT EXISTS inventory.droptop_webhook_log (
  id             text        PRIMARY KEY,
  event          text        NOT NULL,
  operation_id   text,
  company_id     uuid,
  received_at    timestamptz NOT NULL DEFAULT now(),
  status         text        NOT NULL,  -- 'success' | 'error' | 'ignored'
  error_message  text,
  -- The exact shape of a populated `data` field has never actually been
  -- observed live (built from Droptop's docs/examples, not a real
  -- delivery) — kept whole so a wrong assumption about field nesting is
  -- immediately diagnosable from this table instead of a silent failure.
  raw_payload    jsonb
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_webhook_log_received ON inventory.droptop_webhook_log (received_at DESC);

ALTER TABLE inventory.droptop_webhook_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_webhook_log_select" ON inventory.droptop_webhook_log;
CREATE POLICY "droptop_webhook_log_select" ON inventory.droptop_webhook_log FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role webhook function only. company_id can be
-- NULL (an unresolvable operation_id, or a payload with no data at all) —
-- those rows are invisible under the policy above by design; query as
-- service role directly when troubleshooting a delivery that never
-- resolved to a company.
