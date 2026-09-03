-- Phase 3: "Company members can manage count_upload_batches" (ALL) already
-- covers every command with a condition identical to all four of these
-- (old-style per-command policies plus a duplicate SELECT).
DROP POLICY IF EXISTS "Company members can read count_upload_batches" ON inventory.count_batches;
DROP POLICY IF EXISTS "count_batches_delete" ON inventory.count_batches;
DROP POLICY IF EXISTS "count_batches_insert" ON inventory.count_batches;
DROP POLICY IF EXISTS "count_batches_select" ON inventory.count_batches;
