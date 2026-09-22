-- Adds last_gallons_shipped to get_rd_last_delivered_by_shop_product —
-- needed for the new "Last Delivered" column/on-hand sanity check
-- (2026-09-22): a bulk product's delivered amount is only meaningful in
-- real gallons (matches rdReconciliation.ts's own unit convention —
-- gallons_shipped for order_type 'bulk', qty_shipped for 'package'), and
-- the original RPC only ever returned qty_shipped.
--
-- Postgres requires DROP + CREATE (not a bare CREATE OR REPLACE) when a
-- function's RETURNS TABLE column list changes — same rule this project's
-- own franchise setup-link migration already documents.
DROP FUNCTION IF EXISTS public.get_rd_last_delivered_by_shop_product();

CREATE FUNCTION public.get_rd_last_delivered_by_shop_product()
RETURNS TABLE (
  location_id uuid, product_code text, last_invoice_date date,
  last_qty_shipped numeric, last_gallons_shipped numeric, sales_order_no text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (location_id, product_code)
    location_id, product_code, invoice_date AS last_invoice_date,
    qty_shipped AS last_qty_shipped, gallons_shipped AS last_gallons_shipped, sales_order_no
  FROM inventory.rd_delivery_ledger
  WHERE company_id = get_my_company_id()
  ORDER BY location_id, product_code, invoice_date DESC NULLS LAST, first_seen_at DESC
$$;
