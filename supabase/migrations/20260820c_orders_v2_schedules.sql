-- ============================================================
-- Orders v2 — cumulative over-ordering flag + per-shop delivery schedules.
--
--  1. The two flag pairs collapse to ONE rule with a clear purpose: are we
--     ordering the same product over and over because on-hand isn't
--     reflecting what's already been delivered? That's a cumulative
--     question ("45+ days of supply ordered across the last 30 days"), not
--     a per-order one, so the old per-order rules are dropped outright.
--  2. Valvoline runs several delivery patterns, so delivery dates become a
--     per-shop schedule rather than a single weekday: a fixed weekly day, an
--     A/B alternating-week day driven by an uploaded calendar, or a flat
--     "+N business days" turnaround.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. One cumulative over-ordering flag ────────────────────────────────
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS flag_cumulative_days     integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS flag_cumulative_dos_over numeric NOT NULL DEFAULT 45;

COMMENT ON COLUMN inventory.ov2_settings.flag_cumulative_days IS
  'Lookback window for the repeat-ordering check.';
COMMENT ON COLUMN inventory.ov2_settings.flag_cumulative_dos_over IS
  'Flag when the days of supply ordered across ALL orders in the window exceeds this — a sign on-hand is not reflecting deliveries.';

ALTER TABLE inventory.ov2_settings
  DROP COLUMN IF EXISTS flag_if_ordered_over_dos,
  DROP COLUMN IF EXISTS flag_if_ordered_within_days,
  DROP COLUMN IF EXISTS flag_recent_order_days,
  DROP COLUMN IF EXISTS flag_recent_order_dos_over;

-- ── 2. Per-shop delivery schedules ──────────────────────────────────────
-- RelaDyne keeps using core.locations.reladyne_delivery_day. This table is
-- for vendors (Valvoline today) whose shops don't share one pattern.
CREATE TABLE IF NOT EXISTS inventory.ov2_location_schedules (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  location_id   uuid        NOT NULL,
  vendor_id     uuid        NOT NULL,
  schedule_type text        NOT NULL DEFAULT 'weekly'
                  CHECK (schedule_type IN ('weekly', 'week_ab', 'plus_business_days')),
  delivery_dow  integer     CHECK (delivery_dow BETWEEN 0 AND 6),   -- weekly
  week_a_dow    integer     CHECK (week_a_dow  BETWEEN 0 AND 6),    -- week_ab
  week_b_dow    integer     CHECK (week_b_dow  BETWEEN 0 AND 6),    -- week_ab
  -- weekly / week_ab: minimum business days of lead before a delivery day
  -- can be used (an order placed too close rolls to the next occurrence).
  -- plus_business_days: the turnaround itself.
  lead_business_days integer NOT NULL DEFAULT 4,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_ov2_schedules_vendor
  ON inventory.ov2_location_schedules (company_id, vendor_id);

-- Which calendar weeks are "A" and which are "B". Uploaded, since the
-- pattern isn't a clean alternation across holidays.
CREATE TABLE IF NOT EXISTS inventory.ov2_delivery_calendar (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  vendor_id   uuid        NOT NULL,
  week_start  date        NOT NULL,          -- the Sunday that starts the week
  week_label  text        NOT NULL CHECK (week_label IN ('A', 'B')),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, vendor_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_ov2_calendar_vendor
  ON inventory.ov2_delivery_calendar (company_id, vendor_id, week_start);

-- ── 3. RLS, matching the rest of the module ─────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ov2_location_schedules', 'ov2_delivery_calendar']
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

NOTIFY pgrst, 'reload schema';
