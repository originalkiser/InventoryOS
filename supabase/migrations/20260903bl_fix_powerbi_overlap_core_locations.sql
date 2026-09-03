-- Phase 3: "Company members can read locations" (role public) and
-- "locations_powerbi" (role powerbi_reader, unconditional true) both
-- apply to a powerbi_reader session since `public` matches every role.
-- Narrowing the company policy to `authenticated` removes the overlap
-- with zero effect on real app users (who only ever connect as
-- `authenticated`).
ALTER POLICY "Company members can read locations" ON core.locations TO authenticated;
