-- Adds 'manual_product' to recount_preview_actions.action — a user manually
-- adding a product (a sibling case type shown in the "equivalent on-hand"
-- hover, or any arbitrary product from the catalog) to a shop's recount
-- consideration for the period, alongside the existing hidden/excluded/
-- flagged-later actions this table already tracks. Same (company_id,
-- count_month, location_id, product_id) shape — product_id required for
-- this action (like hidden_product), no schema change needed beyond the
-- CHECK constraint.
ALTER TABLE inventory.recount_preview_actions DROP CONSTRAINT recount_preview_actions_action_check;
ALTER TABLE inventory.recount_preview_actions ADD CONSTRAINT recount_preview_actions_action_check
  CHECK (action IN ('hidden_product', 'excluded_shop', 'flagged_later', 'manual_product'));
