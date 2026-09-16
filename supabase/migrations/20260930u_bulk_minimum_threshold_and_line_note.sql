-- Orders v2 bulk-order minimum rule (2026-09-16 request): a bulk product's
-- calculated demand below its configured per-product minimum (e.g. 55
-- gallons, a drum) shouldn't always be rounded all the way up to a full
-- drum — only when the shortfall is at least bulk_round_up_threshold_gal
-- (default 35) worth of real demand, OR the shop's current days of supply
-- is already critical (< bulk_urgent_dos_threshold, default 15 — meaning
-- it would likely run low again before the next order cycle regardless).
-- Otherwise the line is skipped entirely rather than force-ordering a drum
-- nobody asked for. Both are per-company settings, not hardcoded, per an
-- explicit ask to keep them tunable without a code deploy.
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS bulk_round_up_threshold_gal numeric,
  ADD COLUMN IF NOT EXISTS bulk_urgent_dos_threshold numeric;

-- Carries the engine's own explanation ("can order 33, rounding up to
-- minimum") alongside the line it applies to, so it survives a draft
-- reload and still shows up once the order is finalized into history —
-- not just visible for the moment a draft is first generated.
ALTER TABLE inventory.ov2_order_draft_lines
  ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE inventory.ov2_order_history_lines
  ADD COLUMN IF NOT EXISTS note text;
