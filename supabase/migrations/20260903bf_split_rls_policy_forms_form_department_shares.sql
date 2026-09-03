-- Phase 3: "Manage department shares" (ALL, form-owner OR
-- admin/developer) is a subset of "Read department shares" (SELECT, any
-- authenticated user) for SELECT. Split off SELECT.
DROP POLICY IF EXISTS "Manage department shares" ON forms.form_department_shares;
CREATE POLICY "Insert department shares" ON forms.form_department_shares
  FOR INSERT WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "Update department shares" ON forms.form_department_shares
  FOR UPDATE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "Delete department shares" ON forms.form_department_shares
  FOR DELETE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
