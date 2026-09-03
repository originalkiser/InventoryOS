-- Phase 3: score_streaks_write (ALL, form-owner OR admin/developer) is a
-- subset of BOTH score_streaks_read (SELECT, any existing form) AND
-- score_streaks_upsert (INSERT, unconditionally true) — redundant for
-- SELECT and INSERT both. Split down to UPDATE+DELETE only.
DROP POLICY IF EXISTS "score_streaks_write" ON forms.score_streaks;
CREATE POLICY "score_streaks_update" ON forms.score_streaks
  FOR UPDATE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  )
  WITH CHECK (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
CREATE POLICY "score_streaks_delete" ON forms.score_streaks
  FOR DELETE
  USING (
    (form_id IN ( SELECT forms.id FROM forms.forms WHERE (forms.created_by = (select auth.uid()))))
    OR (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['administrator'::text, 'developer'::text]))
  );
