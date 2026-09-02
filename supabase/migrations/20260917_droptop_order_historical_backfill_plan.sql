-- Tracked checklist for the "backfill Droptop order history back to May
-- 2025, working sequentially backwards month by month" project — per
-- explicit direction, this is scaffolding ONLY: a durable, cross-session
-- list of which months are done, not an automated runner. Each month's
-- actual backfill still runs through the existing Historical Backfill
-- controls on Config -> Data Connections (a date-ranged pull against
-- droptop-sync-orders) — this table just tracks progress against that
-- 15-month plan so it isn't only living in one conversation's memory.
--
-- Seeded newest-month-first (July 2026) since that's the stated starting
-- point, walking backwards to May 2025.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_backfill_plan (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  year_month     text        NOT NULL,   -- 'YYYY-MM', first-of-month
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  orders_synced  integer,
  notes          text,
  started_at     timestamptz,
  completed_at   timestamptz,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, year_month)
);

ALTER TABLE inventory.droptop_order_backfill_plan ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "droptop_order_backfill_plan_select" ON inventory.droptop_order_backfill_plan;
CREATE POLICY "droptop_order_backfill_plan_select" ON inventory.droptop_order_backfill_plan FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Any signed-in user of the company can check a month off / add a note —
-- this is a progress checklist, not a permissions-sensitive config table.
DROP POLICY IF EXISTS "droptop_order_backfill_plan_manage" ON inventory.droptop_order_backfill_plan;
CREATE POLICY "droptop_order_backfill_plan_manage" ON inventory.droptop_order_backfill_plan FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Seed the full 15-month plan (2025-05 through 2026-07) for every existing
-- company, newest first. ON CONFLICT DO NOTHING so re-running this
-- migration (or applying it after some months are already checked off some
-- other way) never resets progress.
INSERT INTO inventory.droptop_order_backfill_plan (company_id, year_month)
SELECT DISTINCT l.company_id, ym.year_month
FROM core.locations l, (VALUES
  ('2026-07'), ('2026-06'), ('2026-05'), ('2026-04'), ('2026-03'), ('2026-02'), ('2026-01'),
  ('2025-12'), ('2025-11'), ('2025-10'), ('2025-09'), ('2025-08'), ('2025-07'), ('2025-06'), ('2025-05')
) AS ym(year_month)
ON CONFLICT (company_id, year_month) DO NOTHING;
