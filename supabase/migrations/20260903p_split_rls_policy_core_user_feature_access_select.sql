-- Phase 3 continued: after 20260903o dropped the redundant company-scoped
-- admin policy, core.user_feature_access still had a genuine overlap on
-- SELECT between "Admins manage feature access" (ALL, admin role) and
-- "Users can read own feature access" (SELECT, own row) — neither
-- condition is a subset of the other (an admin viewing someone else's
-- row satisfies only the first; a user viewing their own row satisfies
-- only the second), so this is a real "admin OR own row" union, not
-- redundancy. Can't just OR-merge into the existing ALL policy though —
-- that would leak "own row" into INSERT/UPDATE/DELETE too, which today
-- only admins can do. Split the ALL policy into explicit
-- INSERT/UPDATE/DELETE policies (same admin-only condition, unchanged),
-- and replaced the two SELECT policies with one that's the actual union:
-- admin OR own row. Net effect: identical access, SELECT now has exactly
-- one policy.
-- Verified: all 21 multiple_permissive_policies warnings for this table
-- resolved (across both migrations), no new findings on either advisor.
DROP POLICY IF EXISTS "Admins manage feature access" ON core.user_feature_access;
DROP POLICY IF EXISTS "Users can read own feature access" ON core.user_feature_access;

CREATE POLICY "Admins manage feature access (insert)" ON core.user_feature_access
  FOR INSERT WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text]))))
  );
CREATE POLICY "Admins manage feature access (update)" ON core.user_feature_access
  FOR UPDATE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text]))))
  )
  WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text]))))
  );
CREATE POLICY "Admins manage feature access (delete)" ON core.user_feature_access
  FOR DELETE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text]))))
  );
CREATE POLICY "Admins or own row can read feature access" ON core.user_feature_access
  FOR SELECT
  USING (
    (EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text])))))
    OR (user_id = (select auth.uid()))
  );
