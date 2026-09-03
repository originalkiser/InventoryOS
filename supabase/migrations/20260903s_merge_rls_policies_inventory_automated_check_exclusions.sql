-- Phase 3: literal duplicate — SELECT policy has the identical condition
-- as the ALL policy.
DROP POLICY IF EXISTS "automated_check_exclusions_select" ON inventory.automated_check_exclusions;
