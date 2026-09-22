-- get_ov2_last_ordered_by_shop_product (20260930ax, same day) needs the
-- historical line's own on_hand too — it's the real recorded snapshot the
-- on-hand plausibility check (onHandCheck.ts) uses as its baseline, per
-- 20260930ba's own corrected design. Column list changed, so DROP + CREATE.
DROP FUNCTION IF EXISTS public.get_ov2_last_ordered_by_shop_product(uuid);

CREATE FUNCTION public.get_ov2_last_ordered_by_shop_product(p_vendor_id uuid)
RETURNS TABLE (
  location_id uuid, product_id text, order_date date, qty numeric,
  uom text, order_type text, quarts_per_unit numeric, po_number text,
  on_hand numeric, daily_usage numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (l.location_id, l.product_id)
    l.location_id, l.product_id, h.order_date, l.qty, l.uom, l.order_type, l.quarts_per_unit, l.po_number,
    l.on_hand, l.daily_usage
  FROM inventory.ov2_order_history_lines l
  JOIN inventory.ov2_order_history h ON h.id = l.order_id
  WHERE h.vendor_id = p_vendor_id
  ORDER BY l.location_id, l.product_id, h.order_date DESC, l.created_at DESC
$$;
