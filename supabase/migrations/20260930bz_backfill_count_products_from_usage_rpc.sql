-- Direct ask 2026-10-02: the automated Droptop on-hand sync only ran once
-- today (the morning of Oct 1, correctly capturing Sept 30's true closing
-- state), but it ran BEFORE the data-connection-dispatcher's own
-- monthEndCountMonthFor fix (same session) was deployed, so September's
-- inventory.count_products row never got that final write. A manual
-- catch-up was needed — but the manual "Run Now" path (useDataConnectionRunner
-- .ts) makes a FRESH live call to Droptop's inventory API whenever it runs,
-- which would pull on-hand AS OF WHENEVER IT'S CLICKED, not a replay of this
-- morning's reading — contaminating the previous month's ending balance
-- with whatever has happened on the new month's own first day since then.
--
-- This RPC instead copies CURRENTLY-STORED inventory.product_usage (the
-- same table the regular daily sync already wrote this morning's reading
-- into, and which nothing else has touched since) into count_products for
-- a given month — no live Droptop API call at all, so it can safely be run
-- any time, not just right after the morning sync. Same insert shape
-- (company_id/upload_batch_id/location_id/product_id/category/on_hand/
-- ending_value/count_month) and the same scoped-delete-then-insert-by-
-- batch-id pattern droptop-sync-usage's own writeToCountProducts block
-- already uses, reusing that same "Droptop Daily Pull" / source_type 'api'
-- batch per (company, month) so this never stacks duplicate rows.
CREATE OR REPLACE FUNCTION public.backfill_count_products_from_product_usage(p_count_month date)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_company_id uuid := (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid());
  v_batch_id uuid;
  v_count integer;
BEGIN
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'no company for current user';
  END IF;

  SELECT id INTO v_batch_id FROM inventory.count_batches
  WHERE company_id = v_company_id AND module = 'monthly' AND count_month = p_count_month
    AND source_type = 'api' AND file_name = 'Droptop Daily Pull';

  IF v_batch_id IS NULL THEN
    INSERT INTO inventory.count_batches (company_id, module, count_month, file_name, source_type, row_count)
    VALUES (v_company_id, 'monthly', p_count_month, 'Droptop Daily Pull', 'api', 0)
    RETURNING id INTO v_batch_id;
  END IF;

  DELETE FROM inventory.count_products
  WHERE company_id = v_company_id AND upload_batch_id = v_batch_id;

  INSERT INTO inventory.count_products
    (company_id, upload_batch_id, location_id, product_id, category, on_hand, ending_value, count_month)
  SELECT
    pu.company_id, v_batch_id, pu.location_id, pu.product_id, pu.category, pu.on_hands,
    CASE WHEN pu.unit_cost IS NOT NULL THEN pu.on_hands * pu.unit_cost ELSE NULL END,
    p_count_month
  FROM inventory.product_usage pu
  JOIN core.locations l ON l.id = pu.location_id
  WHERE pu.company_id = v_company_id
    AND pu.on_hands IS NOT NULL
    AND l.droptop_operation_id IS NOT NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE inventory.count_batches SET row_count = v_count WHERE id = v_batch_id;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.backfill_count_products_from_product_usage(date) TO authenticated;
