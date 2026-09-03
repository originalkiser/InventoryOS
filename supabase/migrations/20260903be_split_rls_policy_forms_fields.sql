-- Phase 3: fields_write (ALL, form-owner OR admin/developer) is a subset
-- of fields_read (SELECT, any existing form — unrestricted) for SELECT.
-- Split write off SELECT.
DROP POLICY IF EXISTS "fields_write" ON forms.fields;
CREATE POLICY "fields_insert" ON forms.fields
  FOR INSERT WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "fields_update" ON forms.fields
  FOR UPDATE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "fields_delete" ON forms.fields
  FOR DELETE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
