-- Per-location "last date we successfully synced orders through" —
-- powers droptop-sync-orders' new mode:'incremental' (pulls just
-- yesterday, catching up automatically on any gap since it tracks
-- whether the *sync itself* ran successfully, not whether any orders
-- existed that day). That distinction matters specifically because a
-- real cohort of locations don't operate Sundays: a naive "did we get
-- orders yesterday" check would treat every closed Sunday as a failed
-- sync needing to be re-caught-up forever. This table only advances when
-- the fetch for that location actually succeeded, regardless of whether
-- it came back with zero orders — a legitimately closed day and a
-- successful-but-empty day look identical here, which is correct.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_sync_state (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL,
  location_id       uuid        NOT NULL,
  last_synced_date  date        NOT NULL, -- last UTC calendar date successfully covered
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id)
);

ALTER TABLE inventory.droptop_order_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_sync_state_select" ON inventory.droptop_order_sync_state;
CREATE POLICY "droptop_order_sync_state_select" ON inventory.droptop_order_sync_state FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only.

-- Grant Power BI read access, matching every other Droptop-orders-related
-- table (see 20260904/20260905) — added up front this time rather than as a
-- follow-up fix, since a missed grant here already happened once.
GRANT SELECT ON inventory.droptop_order_sync_state TO powerbi_reader;
