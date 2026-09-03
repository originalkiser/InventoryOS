-- Phase 3: assignments_write (ALL, form-owner OR admin/developer) is a
-- strict subset of assignments_read (SELECT, assigned_to=me OR
-- form-owner OR admin/developer) for SELECT. Split write off SELECT.
DROP POLICY IF EXISTS "assignments_write" ON forms.assignments;
CREATE POLICY "assignments_insert" ON forms.assignments
  FOR INSERT WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "assignments_update" ON forms.assignments
  FOR UPDATE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "assignments_delete" ON forms.assignments
  FOR DELETE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
