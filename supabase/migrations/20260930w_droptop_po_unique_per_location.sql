-- Fix the real root cause of "only 13 of 279 shops ever synced a PO"
-- (2026-09-16) — Droptop's po_id ("PO178", "PO179", ...) is scoped per
-- Droptop OPERATION (i.e. per shop), not globally unique company-wide, the
-- opposite of what the sync function's own prior comment assumed ("the
-- same PO visible under more than one operation_id"). Confirmed live: shop
-- "1521" and shop "3" (Elkin) each independently have their own PO178/
-- PO179/PO180 with entirely different custom_po_id values
-- ("1521-07012026B" vs "3-09092026P"). The old UNIQUE (company_id, po_id)
-- constraint made every shop's Nth PO collide with every other shop's Nth
-- PO — whichever shop's sync ran last for a given number silently
-- overwrote every earlier shop's row under that same po_id, which is
-- exactly why only a small, essentially-arbitrary set of "winning" shops
-- ever ended up with any data at all.
ALTER TABLE inventory.droptop_purchase_orders
  DROP CONSTRAINT droptop_purchase_orders_company_id_po_id_key,
  ADD CONSTRAINT droptop_purchase_orders_company_id_location_id_po_id_key
    UNIQUE (company_id, location_id, po_id);
