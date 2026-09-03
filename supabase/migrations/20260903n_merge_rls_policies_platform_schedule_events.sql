-- Phase 3 (multiple_permissive_policies): platform.schedule_events had 3
-- permissive policies. "user scope" (ALL, company AND creator-or-assigned)
-- is a strict subset of "Company members can manage schedule_events"
-- (ALL, plain company_id match, no extra restriction) — anyone "user
-- scope" would restrict already gets full company-wide access via the
-- broader policy, so it's currently 100% inert (flagged in the Phase 1
-- audit). "Company members can read schedule_events" is a literal
-- duplicate of the ALL policy for SELECT. Dropping both changes nothing
-- about current access — same as before, fewer policy evaluations.
-- Verified: 28 multiple_permissive_policies warnings for this table
-- resolved, no new findings on either advisor.
DROP POLICY IF EXISTS "user scope" ON platform.schedule_events;
DROP POLICY IF EXISTS "Company members can read schedule_events" ON platform.schedule_events;
