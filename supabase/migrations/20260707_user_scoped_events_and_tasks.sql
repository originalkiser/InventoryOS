-- User-scoped calendar events and tasks
-- Apply via Supabase SQL editor before deploying the matching app build.

-- 1. Add created_by to platform.schedule_events
ALTER TABLE platform.schedule_events
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- 2. RLS on platform.schedule_events
--    Visible to: the creator, anyone in assigned_to, or legacy events (created_by IS NULL)
ALTER TABLE platform.schedule_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company members" ON platform.schedule_events;
DROP POLICY IF EXISTS "user scope"      ON platform.schedule_events;

CREATE POLICY "user scope" ON platform.schedule_events
  USING (
    company_id IN (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
    AND (
      created_by IS NULL
      OR created_by = auth.uid()
      OR auth.uid() = ANY(COALESCE(assigned_to, ARRAY[]::uuid[]))
    )
  );

-- 3. Fix RLS on core.tasks
--    The prior policy referenced bare `profiles` which may not resolve correctly.
--    This replacement uses the schema-qualified platform.user_profiles.
ALTER TABLE core.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company members" ON core.tasks;
DROP POLICY IF EXISTS "user scope"      ON core.tasks;

CREATE POLICY "user scope" ON core.tasks
  USING (
    company_id IN (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
    AND (
      created_by = auth.uid()
      OR assignee_id = auth.uid()
      OR is_public = true
    )
  );
