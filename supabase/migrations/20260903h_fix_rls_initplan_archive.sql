-- Phase 2 (auth_rls_initplan): wrap unwrapped auth.uid()/auth.jwt()/auth.role()
-- calls in archive schema policies as (select auth.*()) so Postgres evaluates
-- them once per query (an init-plan) instead of once per row. Mechanical only —
-- every USING/WITH CHECK expression is unchanged except for this wrapping, so
-- access is identical to before.

ALTER POLICY "archive_select_own_company" ON archive.deleted_rows USING (((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))));
