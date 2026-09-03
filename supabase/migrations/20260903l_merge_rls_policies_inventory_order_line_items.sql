-- Phase 3 (multiple_permissive_policies): inventory.order_line_items had 2
-- different ALL policies scoping the table two different ways (a join to
-- order_sessions.company_id, vs a direct company_id column on the table
-- itself) plus a SELECT-only policy duplicating the join condition. Since
-- neither ALL condition is provably a subset of the other without
-- assuming the two always agree (a data-integrity question, not an RLS
-- one), merged them via OR rather than dropping either — this preserves
-- the exact union of what was already independently granted. The
-- SELECT-only duplicate is now fully covered by the merged policy (its
-- condition is one half of the OR) so it's dropped too.
-- Verified: 28 multiple_permissive_policies warnings for this table
-- resolved, no new findings on either advisor.
ALTER POLICY "Company members can manage order_line_items" ON inventory.order_line_items
  USING (
    (EXISTS ( SELECT 1 FROM inventory.order_sessions os WHERE ((os.id = order_line_items.order_session_id) AND (os.company_id = get_my_company_id()))))
    OR (company_id = get_my_company_id())
  )
  WITH CHECK (
    (EXISTS ( SELECT 1 FROM inventory.order_sessions os WHERE ((os.id = order_line_items.order_session_id) AND (os.company_id = get_my_company_id()))))
    OR (company_id = get_my_company_id())
  );

DROP POLICY IF EXISTS "Company members manage order_line_items direct" ON inventory.order_line_items;
DROP POLICY IF EXISTS "Company members can read order_line_items" ON inventory.order_line_items;
