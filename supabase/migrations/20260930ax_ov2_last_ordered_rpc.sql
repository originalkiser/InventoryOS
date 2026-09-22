-- "Last Ordered" (date/qty/uom + the raw order_type/quarts_per_unit needed
-- to interpret that qty correctly) by shop+product, scoped to one vendor —
-- vendor-agnostic data source (our own order history, exists for every
-- vendor already) backing the new Review/Final Review columns (2026-09-22
-- request). Same DISTINCT ON shape as get_rd_last_ordered_by_shop_product,
-- but reads inventory.ov2_order_history_lines directly instead of the
-- RelaDyne-specific upload ledger, so this works for any vendor.
CREATE OR REPLACE FUNCTION public.get_ov2_last_ordered_by_shop_product(p_vendor_id uuid)
RETURNS TABLE (
  location_id uuid, product_id text, order_date date, qty numeric,
  uom text, order_type text, quarts_per_unit numeric, po_number text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (l.location_id, l.product_id)
    l.location_id, l.product_id, h.order_date, l.qty, l.uom, l.order_type, l.quarts_per_unit, l.po_number
  FROM inventory.ov2_order_history_lines l
  JOIN inventory.ov2_order_history h ON h.id = l.order_id
  WHERE h.vendor_id = p_vendor_id
  ORDER BY l.location_id, l.product_id, h.order_date DESC, l.created_at DESC
$$;
