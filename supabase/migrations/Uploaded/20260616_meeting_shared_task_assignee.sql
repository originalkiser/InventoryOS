-- ── Meeting Notes ────────────────────────────────────────────────────────────
-- Meetings are private to the creator by default; creator can share with org.
ALTER TABLE meeting_notes
  ADD COLUMN IF NOT EXISTS shared boolean DEFAULT false NOT NULL;

-- Rebuild RLS: visible to creator OR shared with the org.
DROP POLICY IF EXISTS "company members" ON meeting_notes;
CREATE POLICY "company members" ON meeting_notes
  USING (
    company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (created_by = auth.uid() OR shared = true)
  );

-- ── Tasks ─────────────────────────────────────────────────────────────────────
-- Tasks are private to creator/assignee by default; creator can make them visible to org.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_public  boolean DEFAULT false NOT NULL;

-- Rebuild RLS: visible to creator, assignee, or when marked public.
DROP POLICY IF EXISTS "company members" ON tasks;
CREATE POLICY "company members" ON tasks
  USING (
    company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (created_by = auth.uid() OR assignee_id = auth.uid() OR is_public = true)
  );
