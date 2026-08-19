-- ============================================================
-- Orders v2 — proposed-order generation, review, export, history.
--
-- Self-contained: nothing here alters the existing ordering module's
-- tables (inventory.orders, order_profiles, order_sessions). All new
-- objects are prefixed ov2_ so the two can run side by side until the
-- old module is retired.
--
-- Settings live in real tables (not platform.app_settings) because they
-- belong to this module's own settings screen and are structured enough
-- to want columns + constraints.
--
-- Safe to re-run.
-- ============================================================

-- ── Helper: company scoping used by every policy below ─────────────────
-- (get_my_company_id() already exists; re-stated here only as a comment
-- so this file reads standalone.)

-- ============================================================
-- 1. Module settings (one row per company)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_settings (
  company_id                        uuid        PRIMARY KEY,
  days_of_supply_target             numeric     NOT NULL DEFAULT 21,
  days_of_supply_min_trigger        numeric     NOT NULL DEFAULT 14,
  days_of_supply_max                numeric     NOT NULL DEFAULT 35,
  order_minimum_dollars_package     numeric     NOT NULL DEFAULT 375,
  -- ASSUMPTION: bulk minimum defaults to the same $375 as package until a
  -- real figure is supplied; editable per company and per vendor below.
  order_minimum_dollars_bulk        numeric     NOT NULL DEFAULT 375,
  skip_order_if_dos_over            numeric     NOT NULL DEFAULT 45,
  flag_if_ordered_over_dos          numeric     NOT NULL DEFAULT 30,   -- x
  flag_if_ordered_within_days       integer     NOT NULL DEFAULT 30,   -- y
  flag_if_last_order_usage_under    integer     NOT NULL DEFAULT 7,    -- x days
  -- Bulk is dispensed, not packaged, so it can be ordered fractionally.
  -- 0 = whole gallons, 1 = tenths, etc. Discrete UOMs always order whole.
  bulk_rounding_decimals            integer     NOT NULL DEFAULT 0,
  updated_by                        uuid,
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. Vendor-level rules
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_vendor_order_minimums (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL,
  vendor_id       uuid        NOT NULL,
  order_type      text        NOT NULL CHECK (order_type IN ('package', 'bulk')),
  minimum_dollars numeric     NOT NULL DEFAULT 375,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id, order_type)
);

-- Generic rather than hard-coded to Valvoline bay boxes, so a new vendor
-- or a second capped case type needs data, not a code change.
CREATE TABLE IF NOT EXISTS inventory.ov2_vendor_case_type_limits (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  vendor_id   uuid        NOT NULL,
  case_type   text        NOT NULL,          -- matches order config UOM/package type
  limit_qty   numeric     NOT NULL,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id, case_type)
);

-- Per-shop, per-vendor order day. Generic (not RelaDyne-only) so other
-- vendors can be restricted the same way; a shop with no row for a vendor
-- is treated as orderable any day.
CREATE TABLE IF NOT EXISTS inventory.ov2_location_vendor_days (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  location_id   uuid        NOT NULL,
  vendor_id     uuid        NOT NULL,
  order_dow     integer     CHECK (order_dow BETWEEN 0 AND 6),   -- 0 = Sunday
  delivery_dow  integer     CHECK (delivery_dow BETWEEN 0 AND 6),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, vendor_id)
);

-- ============================================================
-- 3. Per shop x product ordering rules
--    Extends inventory.location_order_config without altering it, so the
--    existing ordering module and config tab keep working untouched.
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_product_rules (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    uuid        NOT NULL,
  location_id                   uuid        NOT NULL,
  product_id                    text        NOT NULL,
  uom                           text,       -- 'bay_box' | 'case' | 'drum' | 'bulk'
  units_per_uom_gallons         numeric,    -- gallons in one orderable unit
  unit_cost                     numeric,    -- $ per orderable unit
  max_capacity_gallons          numeric,
  vmi_keepfill_enabled          boolean     NOT NULL DEFAULT false,
  can_ignore_minimum            boolean     NOT NULL DEFAULT false,
  ignore_minimum_if_ordered_alone boolean   NOT NULL DEFAULT true,
  default_order_amount_if_alone numeric     NOT NULL DEFAULT 2,
  include_in_total_shop_order   boolean     NOT NULL DEFAULT true,
  updated_by                    uuid,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_ov2_product_rules_loc
  ON inventory.ov2_product_rules (company_id, location_id);

-- ============================================================
-- 4. Drafts — server-side from the moment "Start New Order" is clicked
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_order_drafts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  vendor_id      uuid,
  order_date     date        NOT NULL DEFAULT CURRENT_DATE,
  status         text        NOT NULL DEFAULT 'generating'
                   CHECK (status IN ('generating', 'review', 'final_review', 'exported', 'cancelled')),
  -- Snapshot of the settings/rules the run was generated under, so a draft
  -- reopened after a settings change still explains its own numbers.
  settings_snapshot jsonb    NOT NULL DEFAULT '{}'::jsonb,
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_edited_by uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ov2_drafts_company_status
  ON inventory.ov2_order_drafts (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inventory.ov2_order_draft_lines (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  draft_id           uuid        NOT NULL REFERENCES inventory.ov2_order_drafts(id) ON DELETE CASCADE,
  location_id        uuid,
  product_id         text        NOT NULL,
  order_type         text        NOT NULL CHECK (order_type IN ('package', 'bulk')),
  uom                text,
  -- What the engine proposed vs. what the user settled on. Keeping both is
  -- what lets the review UI highlight overrides and count them.
  system_qty         numeric     NOT NULL DEFAULT 0,
  qty                numeric     NOT NULL DEFAULT 0,
  is_override        boolean     NOT NULL DEFAULT false,
  included           boolean     NOT NULL DEFAULT true,
  unit_cost          numeric,
  -- Inputs captured at generation time so history stays explainable even if
  -- usage/on-hand later change.
  on_hand            numeric,
  daily_usage        numeric,
  dos_before         numeric,
  dos_after          numeric,
  dos_after_delivery numeric,
  max_capacity_gallons numeric,
  -- Why this line looks the way it does: smoothing/cap/flag reasons.
  flags              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  added_by_smoothing boolean     NOT NULL DEFAULT false,
  triggered_smoothing boolean    NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ov2_draft_lines_draft
  ON inventory.ov2_order_draft_lines (draft_id, location_id);

-- ============================================================
-- 5. History — finalized orders, independent of the working tables
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_order_history (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL,
  draft_id          uuid,                    -- provenance; draft may be deleted later
  vendor_id         uuid,
  order_date        date        NOT NULL,
  order_type        text        CHECK (order_type IN ('package', 'bulk')),
  location_count    integer     NOT NULL DEFAULT 0,
  line_count        integer     NOT NULL DEFAULT 0,
  total_dollars     numeric     NOT NULL DEFAULT 0,
  export_status     text        NOT NULL DEFAULT 'exported',
  export_count      integer     NOT NULL DEFAULT 1,
  last_exported_at  timestamptz,
  settings_snapshot jsonb       NOT NULL DEFAULT '{}'::jsonb,
  finalized_by      uuid,
  finalized_at      timestamptz NOT NULL DEFAULT now(),
  -- Set when someone edits an already-logged order (confirmation-gated).
  edited_after_finalize boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ov2_history_company_date
  ON inventory.ov2_order_history (company_id, order_date DESC);

CREATE TABLE IF NOT EXISTS inventory.ov2_order_history_lines (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  order_id           uuid        NOT NULL REFERENCES inventory.ov2_order_history(id) ON DELETE CASCADE,
  location_id        uuid,
  product_id         text        NOT NULL,
  order_type         text        NOT NULL CHECK (order_type IN ('package', 'bulk')),
  uom                text,
  po_number          text,
  system_qty         numeric     NOT NULL DEFAULT 0,
  qty                numeric     NOT NULL DEFAULT 0,
  is_override        boolean     NOT NULL DEFAULT false,
  unit_cost          numeric,
  line_total         numeric,
  on_hand            numeric,
  daily_usage        numeric,
  dos_before         numeric,
  dos_after          numeric,
  dos_after_delivery numeric,
  flags              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Post-finalization edit trail (section 7).
  edited_after_finalize boolean  NOT NULL DEFAULT false,
  edited_by          uuid,
  edited_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ov2_history_lines_order
  ON inventory.ov2_order_history_lines (order_id, location_id);
-- Backs the "ordered over X DOS in the last Y days" / "last order's usage
-- under X days" flag queries in the generation engine.
CREATE INDEX IF NOT EXISTS idx_ov2_history_lines_product
  ON inventory.ov2_order_history_lines (company_id, location_id, product_id);

-- Audit of edits made to an already-finalized order.
CREATE TABLE IF NOT EXISTS inventory.ov2_order_history_audit (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  order_id    uuid        NOT NULL REFERENCES inventory.ov2_order_history(id) ON DELETE CASCADE,
  line_id     uuid,
  field       text        NOT NULL,
  old_value   text,
  new_value   text,
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ov2_history_audit_order
  ON inventory.ov2_order_history_audit (order_id, changed_at DESC);

-- ============================================================
-- 6. Export templates (per vendor, saved as the reusable default)
-- ============================================================
CREATE TABLE IF NOT EXISTS inventory.ov2_export_templates (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  vendor_id      uuid        NOT NULL,
  -- [{ kind: 'source'|'constant'|'blank'|'composite', header, field?, value?, template? }]
  columns        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  file_name_template  text   NOT NULL DEFAULT '{vendor}-{date:MMDDYYYY}',
  sheet_name_template text   NOT NULL DEFAULT 'Order',
  format         text        NOT NULL DEFAULT 'xlsx' CHECK (format IN ('xlsx', 'csv')),
  include_subject boolean    NOT NULL DEFAULT false,
  subject_template text      NOT NULL DEFAULT '{vendor} Order - {date:MMDDYYYY}',
  use_body_template boolean  NOT NULL DEFAULT false,
  body_template  text        NOT NULL DEFAULT '',
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id)
);

-- ============================================================
-- 7. RLS — company-scoped read/write for authenticated members
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ov2_settings', 'ov2_vendor_order_minimums', 'ov2_vendor_case_type_limits',
    'ov2_location_vendor_days', 'ov2_product_rules', 'ov2_order_drafts',
    'ov2_order_draft_lines', 'ov2_order_history', 'ov2_order_history_lines',
    'ov2_order_history_audit', 'ov2_export_templates'
  ]
  LOOP
    EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_rw', t);
    EXECUTE format($pol$
      CREATE POLICY %I ON inventory.%I FOR ALL
        USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
        WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
    $pol$, t || '_rw', t);
  END LOOP;
END
$$;

-- Deleting a finalized order or its lines would destroy the record the
-- flag rules read from, so archive those too (see 20260819_archive_deleted_rows).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT unnest(ARRAY['ov2_order_history', 'ov2_order_history_lines']) AS name
  LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'archive' AND p.proname = 'capture_deleted_row') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON inventory.%I', t.name);
      EXECUTE format(
        'CREATE TRIGGER trg_archive_deleted AFTER DELETE ON inventory.%I
           FOR EACH ROW EXECUTE FUNCTION archive.capture_deleted_row()', t.name);
    END IF;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
