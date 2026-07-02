-- Adds latitude/longitude to core.locations
-- Creates core.location_routes for route distance/time data
-- Apply in Supabase SQL editor

ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS latitude  numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric;

CREATE TABLE IF NOT EXISTS core.location_routes (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid        NOT NULL,
  origin_location_id      uuid        NOT NULL REFERENCES core.locations(id) ON DELETE CASCADE,
  destination_location_id uuid        NOT NULL REFERENCES core.locations(id) ON DELETE CASCADE,
  distance_miles          numeric,
  drive_time_minutes      integer,
  route_geometry          text,
  data_source             text        NOT NULL DEFAULT 'manual'
                            CHECK (data_source IN ('api', 'manual', 'imported', 'saved_api')),
  api_provider            text,
  api_response_metadata   jsonb,
  created_by              uuid        REFERENCES auth.users(id),
  updated_by              uuid        REFERENCES auth.users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  last_verified_at        timestamptz,
  CONSTRAINT location_routes_pair_unique
    UNIQUE (company_id, origin_location_id, destination_location_id)
);

ALTER TABLE core.location_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY location_routes_select ON core.location_routes
  FOR SELECT TO authenticated
  USING (
    company_id = (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY location_routes_insert ON core.location_routes
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id = (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY location_routes_update ON core.location_routes
  FOR UPDATE TO authenticated
  USING (
    company_id = (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    company_id = (
      SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY location_routes_delete ON core.location_routes
  FOR DELETE TO authenticated
  USING (
    company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM platform.user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'developer')
    )
  );
