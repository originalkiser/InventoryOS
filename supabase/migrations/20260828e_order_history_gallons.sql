-- Orders v2 — cache total gallons ordered on the finalized-order header,
-- alongside the existing line_count/total_dollars totals. Saved best-effort
-- by useOrderHistory.ts's finalizeDraft() (a follow-up update, not part of
-- the core insert) so a database that hasn't run this migration yet still
-- finalizes orders correctly — it just won't have this column populated.
ALTER TABLE inventory.ov2_order_history ADD COLUMN IF NOT EXISTS total_gallons numeric;
