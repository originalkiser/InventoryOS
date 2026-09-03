-- "Admins can view company users" is a literal duplicate of "Users can
-- view teammates" (identical condition). INSERT/UPDATE overlaps on this
-- table are handled separately (genuine OR-merges, see later migrations).
DROP POLICY IF EXISTS "Admins can view company users" ON platform.user_profiles;
