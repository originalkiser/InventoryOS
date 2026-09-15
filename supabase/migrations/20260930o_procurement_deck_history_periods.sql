-- Two additions to the Procurement Deck (see 20260930n_procurement_deck.sql
-- for the base schema):
--
-- 1. procurement_deck_field_history -- every time an already-filled grid
--    cell or KPI value gets overwritten with something different, the OLD
--    value is logged here before the overwrite. Powers the "i" history
--    button next to an edited field (view past values, revert to one) --
--    distinct from the orange "changed this session" highlight, which is
--    plain client-side React state and deliberately NOT persisted here.
-- 2. procurement_deck_periods -- RelaDyne/Valvoline/Mighty Purchases each
--    track spend against two windows: a "usage" period and a "contract"
--    period, each with a start/end month and an end-of-period target. One
--    row per (slide, period_key) rather than folding into
--    procurement_deck_kpis, since a period is a start+end+target triple,
--    not a single label/value pair.
CREATE TABLE IF NOT EXISTS inventory.procurement_deck_field_history (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  slide_key      text        NOT NULL,
  table_key      text        NOT NULL,
  field_kind     text        NOT NULL CHECK (field_kind IN ('grid', 'kpi')),
  row_label      text,       -- grid only
  col_key        text,       -- grid only
  kpi_key        text,       -- kpi only
  old_value_num  numeric,
  old_value_text text,
  changed_by     uuid,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_procurement_deck_field_history_grid
  ON inventory.procurement_deck_field_history (company_id, slide_key, table_key, row_label, col_key) WHERE field_kind = 'grid';
CREATE INDEX IF NOT EXISTS idx_procurement_deck_field_history_kpi
  ON inventory.procurement_deck_field_history (company_id, slide_key, table_key, kpi_key) WHERE field_kind = 'kpi';

CREATE TABLE IF NOT EXISTS inventory.procurement_deck_periods (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  slide_key     text        NOT NULL,
  period_key    text        NOT NULL CHECK (period_key IN ('usage', 'contract')),
  start_col_key text,       -- 'YYYY-MM', nullable -- not yet configured
  start_label   text,
  end_col_key   text,
  end_label     text,
  target_num    numeric,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slide_key, period_key)
);

ALTER TABLE inventory.procurement_deck_field_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.procurement_deck_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "procurement_deck_field_history_select" ON inventory.procurement_deck_field_history;
CREATE POLICY "procurement_deck_field_history_select" ON inventory.procurement_deck_field_history FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "procurement_deck_field_history_manage" ON inventory.procurement_deck_field_history;
CREATE POLICY "procurement_deck_field_history_manage" ON inventory.procurement_deck_field_history FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "procurement_deck_periods_select" ON inventory.procurement_deck_periods;
CREATE POLICY "procurement_deck_periods_select" ON inventory.procurement_deck_periods FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "procurement_deck_periods_manage" ON inventory.procurement_deck_periods;
CREATE POLICY "procurement_deck_periods_manage" ON inventory.procurement_deck_periods FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  inventory.procurement_deck_field_history,
  inventory.procurement_deck_periods
TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  inventory.procurement_deck_field_history,
  inventory.procurement_deck_periods
TO service_role;

NOTIFY pgrst, 'reload schema';

-- Seed Contract Period for the 3 purchase-tracking slides with what the
-- July 2026 deck's own text supports (Usage Period is left unset -- no
-- reliable start/end/target for that window in either source file, and a
-- guessed one could be actively misleading; the admin fills it in from the
-- Tracking Periods panel once it's defined).
DO $$
DECLARE v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id FROM core.locations LIMIT 1;

  INSERT INTO inventory.procurement_deck_periods
    (company_id, slide_key, period_key, start_col_key, start_label, end_col_key, end_label, target_num)
  VALUES
    -- RelaDyne: "twelve months into the agreement" as of Jul-26 -> contract start Jul-25;
    -- end = Est Contract Fulfillment (8/31/2027); target = Contract Commitment (6,000,000 gal).
    (v_company_id, 'reladyne_purchases', 'contract', '2025-07', 'Jul-25', '2027-08', 'Aug-27', 6000000),
    -- Valvoline: "Contract Extension: Year 1 contract extended and backdated to October 2025" ->
    -- Year 1 window Oct-25 through Sep-26; target = Contract Year 1 Commitment (300,000 gal).
    (v_company_id, 'valvoline_purchases', 'contract', '2025-10', 'Oct-25', '2026-09', 'Sep-26', 300000),
    -- Mighty: "Executed contract extension effective 12/1/2025 through 11/30/2026"; target = $10MM.
    (v_company_id, 'mighty_purchases', 'contract', '2025-12', 'Dec-25', '2026-11', 'Nov-26', 10000000)
  ON CONFLICT (company_id, slide_key, period_key) DO NOTHING;
END $$;
