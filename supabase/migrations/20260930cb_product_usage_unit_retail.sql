-- Direct ask 2026-10-02: Droptop's get-inventory response carries a
-- per-product `unit_retail` field (confirmed against Droptop's own API docs
-- screenshot — e.g. unit_cost "1.99" / unit_retail "6.99" on the same item)
-- distinct from unit_cost — this is the price a shop charges when a package
-- is configured to bill at that product's own retail rate, and the user
-- wants it captured so shops with a non-standard per-product retail price
-- can be audited/flagged. Droptop-synced (same treatment as unit_cost
-- already gets), not user-editable via the Product Usage config tab's own
-- manual cost_per_unit column — see droptop-sync-usage/index.ts.
ALTER TABLE inventory.product_usage ADD COLUMN IF NOT EXISTS unit_retail numeric;
