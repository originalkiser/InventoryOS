-- ============================================================
-- Orders v2 — let a UOM Conversions row declare its order type.
--
-- orderTypeOf() classifies a line as bulk only when its uom string is
-- exactly "bulk" (case-insensitive); anything else — including a real
-- bulk product whose configured uom text just doesn't literally say
-- "bulk" — falls through to "package", which is wrong and throws off the
-- PO number's B/P code plus the group it's counted toward for minimums.
-- This gives each vendor-scoped UOM row an explicit override, so a UOM
-- like "Tank" or "Oil - Bulk" can be marked Bulk without renaming it.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE inventory.uom_mappings
  ADD COLUMN IF NOT EXISTS order_type text CHECK (order_type IN ('package', 'bulk'));

COMMENT ON COLUMN inventory.uom_mappings.order_type IS
  'Optional override for Orders v2''s package-vs-bulk classification of this UOM. NULL falls back to the default (uom text must literally say "bulk").';

NOTIFY pgrst, 'reload schema';
