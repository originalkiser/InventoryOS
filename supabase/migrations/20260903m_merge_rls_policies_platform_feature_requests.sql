-- Phase 3 (multiple_permissive_policies): platform.feature_requests had 2
-- ALL policies with genuinely different conditions (admin role check with
-- no company scoping, vs self-submitted-only) — neither is a subset of
-- the other, so merged via OR rather than dropping either. Preserves the
-- exact union of what was already independently granted.
--
-- Note (not fixed here — performance-only pass): "Admins manage all
-- requests"'s condition has no company_id check at all, meaning any
-- admin/developer at any company can see/manage every company's feature
-- requests. Flagged in the Phase 1 audit; worth a follow-up decision on
-- whether that's intentional, separately from this cleanup.
--
-- Verified: 28 multiple_permissive_policies warnings for this table
-- resolved, no new findings on either advisor.
ALTER POLICY "Admins manage all requests" ON platform.feature_requests
  USING (
    (EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text])))))
    OR ((select auth.uid()) = submitted_by)
  )
  WITH CHECK (
    (EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text])))))
    OR ((select auth.uid()) = submitted_by)
  );

DROP POLICY IF EXISTS "Users manage own requests" ON platform.feature_requests;
