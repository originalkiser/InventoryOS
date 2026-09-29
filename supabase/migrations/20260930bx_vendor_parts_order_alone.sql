-- "Order alone" exception (2026-09-29 ask) — a product like HM0806 that can
-- legitimately be the ONLY thing on an order and still ship (e.g. "2 cases"
-- is a real, acceptable order on its own) shouldn't trigger this app's
-- group-dollar-minimum smoothing (which pulls in OTHER products / inflates
-- quantities purely to clear a $ threshold) or the resulting "below
-- minimum" flag when it's the sole line.
--
-- engine.ts's Pass 2 (dollar-smoothing) ALREADY has this exact behavior
-- built in — `can_ignore_minimum` / `ignore_minimum_if_ordered_alone` /
-- `default_order_amount_if_alone` on ProductRule, resolved from
-- inventory.ov2_product_rules — but that table is per-(location_id,
-- product_id), has NO editing UI anywhere in the app, and is confirmed
-- completely empty in production (0 rows), so this has never actually been
-- usable by anyone since it was built. Rather than building a UI for a
-- per-shop table (meaning re-configuring the same product at every shop
-- that carries it), this adds the same 2 fields to inventory.vendor_parts
-- instead — the existing, already-editable, COMPANY-WIDE per-product home
-- for exactly this kind of setting (min_on_hand_qty already lives here for
-- the identical reason). useOrdersV2.ts's buildGenerationInputs falls back
-- to these vendor_parts values whenever no real per-shop ov2_product_rules
-- override exists (which today is always, but a future per-shop override
-- can still take precedence once/if that table ever gets its own UI).
ALTER TABLE inventory.vendor_parts
  ADD COLUMN IF NOT EXISTS can_ignore_minimum boolean,
  ADD COLUMN IF NOT EXISTS default_order_amount_if_alone numeric;
