-- Phase 3: field_conditions_write (ALL, form-owner OR admin/developer) is
-- a subset of field_conditions_read (SELECT, any existing form —
-- unrestricted) for SELECT. Split write off SELECT.
DROP POLICY IF EXISTS "field_conditions_write" ON forms.field_conditions;
CREATE POLICY "field_conditions_insert" ON forms.field_conditions
  FOR INSERT WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "field_conditions_update" ON forms.field_conditions
  FOR UPDATE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "field_conditions_delete" ON forms.field_conditions
  FOR DELETE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
