-- New locations feed added via monday-sync-locations pull in items this
-- app has never seen before (including a real cohort that turned out to be
-- car-wash-only sites, not oil-change shops) with no way to tell which is
-- which — every downstream inventory surface (Location Lookup, AM/RD
-- Lookup, Inventory Alerts, Orders v2, ...) was silently treating them like
-- any other operational shop.
--
-- location_type is a manual classification, set once per location via the
-- new "New Locations — Need Classification" prompt (Locations page): NULL
-- means "not yet classified, or a location that predates this feature and
-- has always behaved as an oil-change shop" (never treated as excluded);
-- 'car_wash' is the only value that actually changes behavior anywhere —
-- see useLocations.ts's isOperationalLocation() and every other place that
-- reads it. 'oil_change' is recorded when a location is explicitly
-- confirmed (mostly so the "needs classification" list can tell "not yet
-- looked at" apart from "looked at, it's a normal shop").
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS location_type text CHECK (location_type IN ('oil_change', 'car_wash'));

CREATE INDEX IF NOT EXISTS idx_core_locations_location_type ON core.locations (company_id, location_type);
