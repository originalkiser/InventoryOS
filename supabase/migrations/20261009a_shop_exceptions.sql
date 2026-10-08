-- Shop exceptions: the five automatic inventory exceptions, ONE open row per shop per type that accumulates instead of a new row per product/day:
--   po_late        PO should have delivered            (medium)
--   zero_sales     Selling at zero on hand             (high)   — stacks days + quantity sold per product
--   adj_positive   Large positive adjustment           (medium) — products/dates added to the one card
--   adj_negative   Large negative adjustment           (high)
--   duplicate_case Duplicate case types on hand        (mixed)  — high when the quantities are within 40 qts of each other, else low
-- Written by the run-automated-checks Edge Function (service role); people change status (pending / skipped / excused / logged) from the
-- Location Lookup card, its modal, and Exception Reporting's triage view. `items` is the current list of what's wrong; `acked_keys` is the item
-- keys present when a person last set the status, so a NEW item reopens an excused/skipped/logged exception but the old ones don't.
CREATE TABLE IF NOT EXISTS inventory.shop_exceptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL,
  location_id       uuid NOT NULL,
  type              text NOT NULL CHECK (type IN ('po_late', 'zero_sales', 'adj_positive', 'adj_negative', 'duplicate_case')),
  severity          smallint NOT NULL DEFAULT 2 CHECK (severity BETWEEN 1 AND 3),   -- 1 low, 2 medium, 3 high
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'skipped', 'excused', 'logged', 'resolved')),
  first_seen        date NOT NULL,
  last_seen         date NOT NULL,
  items             jsonb NOT NULL DEFAULT '[]'::jsonb,
  acked_keys        text[] NOT NULL DEFAULT '{}',
  status_changed_at timestamptz,
  status_changed_by uuid,
  logged_message    text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- At most one OPEN exception per shop + type — a resolved one stays as history and a recurrence starts a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS shop_exceptions_one_open ON inventory.shop_exceptions (company_id, location_id, type) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS shop_exceptions_company_status ON inventory.shop_exceptions (company_id, status);

ALTER TABLE inventory.shop_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shop_exceptions_select ON inventory.shop_exceptions;
CREATE POLICY shop_exceptions_select ON inventory.shop_exceptions FOR SELECT USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS shop_exceptions_manage ON inventory.shop_exceptions;
CREATE POLICY shop_exceptions_manage ON inventory.shop_exceptions FOR ALL USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.shop_exceptions TO authenticated;
