-- Phase 3: own_sidebar_prefs_select (SELECT) and own_sidebar_prefs_upsert
-- (ALL) both have the identical condition (user_id = auth.uid()) as
-- "Users manage own sidebar prefs" (ALL, role public — already covers
-- authenticated users). Same access, fewer evaluations.
DROP POLICY IF EXISTS "own_sidebar_prefs_select" ON core.user_sidebar_prefs;
DROP POLICY IF EXISTS "own_sidebar_prefs_upsert" ON core.user_sidebar_prefs;
