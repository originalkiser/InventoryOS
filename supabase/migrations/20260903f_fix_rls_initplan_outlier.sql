-- Phase 2 (auth_rls_initplan): wrap unwrapped auth.uid()/auth.jwt()/auth.role()
-- calls in outlier schema policies as (select auth.*()) so Postgres evaluates
-- them once per query (an init-plan) instead of once per row. Mechanical only —
-- every USING/WITH CHECK expression is unchanged except for this wrapping, so
-- access is identical to before.

ALTER POLICY "departments_all_read" ON outlier.departments USING (((select auth.uid()) IS NOT NULL));
ALTER POLICY "Admins can update paste_logs" ON outlier.paste_logs USING ((( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])));
ALTER POLICY "Authenticated users can insert paste_logs" ON outlier.paste_logs WITH CHECK (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can read paste_logs" ON outlier.paste_logs USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can insert report_entries" ON outlier.report_entries WITH CHECK (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can read report_entries" ON outlier.report_entries USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can update report_entries" ON outlier.report_entries USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "reports_all_read" ON outlier.reports USING (((select auth.uid()) IS NOT NULL));
ALTER POLICY "profiles_own_select" ON outlier.user_profiles USING ((auth_user_id = (select auth.uid())));
ALTER POLICY "Admins can update weeks" ON outlier.weeks USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can read weeks" ON outlier.weeks USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can upsert weeks" ON outlier.weeks WITH CHECK (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "weeks_all_read" ON outlier.weeks USING (((select auth.uid()) IS NOT NULL));
