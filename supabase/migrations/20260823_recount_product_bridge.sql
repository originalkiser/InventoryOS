-- ============================================================
-- Month End — tank-monitor-variance recount flag.
--
-- The category-expectations engine (category_simplification,
-- category_expectations, get_product_expectation_exceptions RPC) already
-- exists and already compares VMI tank readings to on-hand, but only to
-- SUPPRESS a false-positive bulk-oil category flag — it's never been its
-- own independent recount trigger, and it only applies to engine oil.
-- This adds a dedicated threshold for a standalone check (VMI tanks of
-- any product, not just oil): if a tank's reading differs from the
-- shop's counted on-hand for that product by more than this many quarts,
-- the shop flags for recount. NULL = disabled, matching every other
-- threshold column on this table.
--
-- Deliberately separate from category_expectations' own
-- monthend.tankVarianceQts app-setting (used only for the oil-bulk
-- suppression) — same general idea, different specific purpose, so they
-- stay independently tunable rather than forcing one number to serve two
-- different jobs.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS tank_variance_qts_threshold numeric;

COMMENT ON COLUMN inventory.recount_config.tank_variance_qts_threshold IS
  'Flag a shop for recount when a VMI tank''s reading differs from its counted on-hand by more than this many quarts. NULL = disabled.';

NOTIFY pgrst, 'reload schema';
