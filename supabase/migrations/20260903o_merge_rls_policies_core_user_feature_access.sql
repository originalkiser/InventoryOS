-- Phase 3 (multiple_permissive_policies): core.user_feature_access had 4
-- permissive policies. "Admins can manage feature access" (ALL, admin
-- role AND same-company-as-target-row) is a strict subset of "Admins
-- manage feature access" (ALL, admin role only — no company check at
-- all): admin-AND-same-company implies admin, so the narrower policy is
-- redundant given the broader one already exists. Note: this means any
-- admin/developer at any company can already manage any company's rows
-- via the broader policy — pre-existing access, not introduced by this
-- migration, just no longer partially obscured by a narrower policy
-- sitting alongside it. "Users read own feature access" is a literal
-- duplicate of "Users can read own feature access" (same condition,
-- flipped operands). Dropping both changes nothing about current access.
DROP POLICY IF EXISTS "Admins can manage feature access" ON core.user_feature_access;
DROP POLICY IF EXISTS "Users read own feature access" ON core.user_feature_access;
