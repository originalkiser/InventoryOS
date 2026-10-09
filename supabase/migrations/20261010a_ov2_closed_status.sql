-- Orders v2: a 'closed' status, treated like 'exported' (the order is done) but without having to export it.
ALTER TABLE inventory.ov2_order_drafts DROP CONSTRAINT IF EXISTS ov2_order_drafts_status_check;
ALTER TABLE inventory.ov2_order_drafts ADD CONSTRAINT ov2_order_drafts_status_check
  CHECK (status = ANY (ARRAY['generating','review','final_review','exported','closed','cancelled']));
