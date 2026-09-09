-- Orders v2 — two related but distinct new controls, both requested
-- together (2026-09-09) but solving different problems:
--
-- 1. Per-product "critical minimum" (global_products.min_on_hand_qty) —
--    applies to a product at EVERY shop that carries it. Even when usage is
--    so low the normal days-of-supply math would never trigger an order
--    (e.g. a slow-moving Euro oil), on-hand dropping to or below "enough
--    for one oil change" (12qt diesel, 8qt Euro, 5qt others — entered
--    manually per product, no auto-derivation) should still trigger
--    ordering at least 1 unit, sized by the normal usage/DOS math beyond
--    that floor. See engine.ts's belowCriticalFloor for how this is used.
--
-- 2. Shop+product exceptions (inventory.ov2_product_exceptions) — a
--    per-(location, product) override, for the cases a company-wide number
--    can't capture:
--      floor_qty   — on-hand at or below this amount is physically
--                    inaccessible/unusable at THIS shop for THIS product
--                    (e.g. tank dead volume) — subtracted from raw on-hand
--                    before anything else sees it, so a 200qt reading with
--                    a 50qt floor is treated as 150qt usable throughout.
--      ceiling_qty / ceiling_unit — a hard cap on how far this shop can be
--                    ordered up for this product, entered in either cases
--                    (this product's own orderable unit) or gallons.
--                    Overrides the shop's regular location_order_config
--                    capacity for this one product when set, rather than
--                    stacking with it.
-- Both are optional per row — a row can set just one, or both.
--
-- No FK on location_id/product_id — matches this app's existing convention
-- of plain uuid/text columns with no foreign keys (see CLAUDE.md's
-- archive.deleted_rows section for why); a location or product deleted out
-- from under a row here just makes that row unreachable through the normal
-- UI, not left dangling in a way that breaks anything.

ALTER TABLE inventory.global_products ADD COLUMN IF NOT EXISTS min_on_hand_qty numeric;

CREATE TABLE IF NOT EXISTS inventory.ov2_product_exceptions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  location_id   uuid        NOT NULL,
  product_id    text        NOT NULL,
  floor_qty     numeric,
  ceiling_qty   numeric,
  ceiling_unit  text        CHECK (ceiling_unit IN ('cases', 'gallons')),
  notes         text,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id)
);

ALTER TABLE inventory.ov2_product_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ov2_product_exceptions_select" ON inventory.ov2_product_exceptions;
CREATE POLICY "ov2_product_exceptions_select" ON inventory.ov2_product_exceptions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "ov2_product_exceptions_manage" ON inventory.ov2_product_exceptions;
CREATE POLICY "ov2_product_exceptions_manage" ON inventory.ov2_product_exceptions FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_ov2_product_exceptions_location ON inventory.ov2_product_exceptions (company_id, location_id);
