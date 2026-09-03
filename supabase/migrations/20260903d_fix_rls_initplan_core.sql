-- Phase 2 (auth_rls_initplan): wrap unwrapped auth.uid()/auth.jwt()/auth.role()
-- calls in core schema policies as (select auth.*()) so Postgres evaluates
-- them once per query (an init-plan) instead of once per row. Mechanical only —
-- every USING/WITH CHECK expression is unchanged except for this wrapping, so
-- access is identical to before.

ALTER POLICY "admin_dev_manage_location_data_source" ON core.location_data_source USING (((( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text])) AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))));
ALTER POLICY "company_read_location_data_source" ON core.location_data_source USING ((((select auth.role()) = 'authenticated'::text) AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))));
ALTER POLICY "location_routes_delete" ON core.location_routes USING (((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))) AND (EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['admin'::text, 'developer'::text])))))));
ALTER POLICY "location_routes_insert" ON core.location_routes WITH CHECK ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "location_routes_select" ON core.location_routes USING ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "location_routes_update" ON core.location_routes USING ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))) WITH CHECK ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "loc_suppl_delete" ON core.location_supplemental USING ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "loc_suppl_insert" ON core.location_supplemental WITH CHECK ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "loc_suppl_select" ON core.location_supplemental USING ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "loc_suppl_update" ON core.location_supplemental USING ((company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))));
ALTER POLICY "Authenticated users can insert locations_sync_log" ON core.location_sync_log WITH CHECK (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can read locations_sync_log" ON core.location_sync_log USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Users manage own dismissals" ON core.task_popup_dismissals USING ((user_id = (select auth.uid()))) WITH CHECK ((user_id = (select auth.uid())));
ALTER POLICY "user scope" ON core.tasks USING (((company_id IN ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))) AND ((created_by = (select auth.uid())) OR (assignee_id = (select auth.uid())) OR (is_public = true))));
ALTER POLICY "Authenticated users can delete uom_thresholds" ON core.uom_thresholds USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can insert uom_thresholds" ON core.uom_thresholds WITH CHECK (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can read uom_thresholds" ON core.uom_thresholds USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Authenticated users can update uom_thresholds" ON core.uom_thresholds USING (((select auth.role()) = 'authenticated'::text));
ALTER POLICY "Admins can manage feature access" ON core.user_feature_access USING (((( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (EXISTS ( SELECT 1 FROM platform.user_profiles up WHERE ((up.id = user_feature_access.user_id) AND (up.company_id = get_my_company_id())))))) WITH CHECK (((( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])) AND (EXISTS ( SELECT 1 FROM platform.user_profiles up WHERE ((up.id = user_feature_access.user_id) AND (up.company_id = get_my_company_id()))))));
ALTER POLICY "Admins manage feature access" ON core.user_feature_access USING ((EXISTS ( SELECT 1 FROM platform.user_profiles WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = ANY (ARRAY['administrator'::text, 'developer'::text, 'admin'::text]))))));
ALTER POLICY "Users can read own feature access" ON core.user_feature_access USING ((user_id = (select auth.uid())));
ALTER POLICY "Users read own feature access" ON core.user_feature_access USING (((select auth.uid()) = user_id));
ALTER POLICY "Users manage own sidebar prefs" ON core.user_sidebar_prefs USING (((select auth.uid()) = user_id)) WITH CHECK (((select auth.uid()) = user_id));
ALTER POLICY "own_sidebar_prefs_select" ON core.user_sidebar_prefs USING ((user_id = (select auth.uid())));
ALTER POLICY "own_sidebar_prefs_upsert" ON core.user_sidebar_prefs USING ((user_id = (select auth.uid()))) WITH CHECK ((user_id = (select auth.uid())));
