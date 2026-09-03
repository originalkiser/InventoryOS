-- Phase 3: literal duplicate — SELECT policy has the identical condition
-- as the ALL policy. Same access, one fewer evaluation.
DROP POLICY IF EXISTS "Company members read pos_location_map" ON core.pos_location_map;
