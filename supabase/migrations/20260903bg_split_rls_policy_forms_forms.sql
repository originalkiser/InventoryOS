-- Phase 3: forms_write (ALL, own form OR admin/developer) is a subset of
-- forms_read (SELECT, any authenticated user OR published) for SELECT.
-- Split write off SELECT.
DROP POLICY IF EXISTS "forms_write" ON forms.forms;
CREATE POLICY "forms_insert" ON forms.forms
  FOR INSERT WITH CHECK (
    (created_by = (select auth.uid()))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "forms_update" ON forms.forms
  FOR UPDATE
  USING (
    (created_by = (select auth.uid()))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (created_by = (select auth.uid()))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "forms_delete" ON forms.forms
  FOR DELETE
  USING (
    (created_by = (select auth.uid()))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
