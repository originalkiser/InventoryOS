-- Phase 2 (auth_rls_initplan): wrap unwrapped auth.uid()/auth.jwt()/auth.role()
-- calls in realtime schema policies as (select auth.*()) so Postgres evaluates
-- them once per query (an init-plan) instead of once per row. Mechanical only —
-- every USING/WITH CHECK expression is unchanged except for this wrapping, so
-- access is identical to before.

ALTER POLICY "join_me_receive" ON realtime.messages USING ((realtime.topic() = ('joinme:'::text || ((select auth.uid()))::text)));
