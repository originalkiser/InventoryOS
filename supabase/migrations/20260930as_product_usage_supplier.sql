-- Adds a supplier column to inventory.product_usage (2026-09-21 request,
-- Orders v2 pre-work) — lets a product's usage row carry which supplier
-- manages it (e.g. "Mighty", which vendor-manages inventory/ordering at
-- most shops directly, vs. a handful of shops that need a manual order).
-- Purely additive — no existing column touched, matches the decoupled
-- save pattern for a new column that may not exist in production yet.
ALTER TABLE inventory.product_usage
  ADD COLUMN IF NOT EXISTS supplier text;
