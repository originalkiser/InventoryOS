-- VIN-decode cache (Trim/Engine) for the Droptop Vehicles page.
--
-- Droptop's own vehicle payload only ever carries vin/license_plate/
-- mileage/vin_vehicle_year/_make/_model (confirmed against live raw_data
-- and against Droptop's own API spec) — no Trim or Engine anywhere. This
-- table fills that gap via NHTSA's free vPIC VIN-decode API
-- (https://vpic.nhtsa.dot.gov/api/ — no key, no cost, US-market VINs).
--
-- Keyed by VIN only, no company_id: a VIN's factory Trim/Engine spec is a
-- fact about the vehicle, not about which company's shop serviced it —
-- same "global reference data" shape as inventory.zip_centroids (a zip's
-- lat/lng doesn't depend on company either), and this is a single-tenant
-- deployment regardless. Written only by the vin-decode Edge Function
-- (service role); read directly by the Vehicles page client-side, unlike
-- the geocoded_addresses cache (which denormalizes onto droptop_orders
-- instead) — nothing here needs denormalizing onto droptop_order_vehicles
-- since the page already has the vin to look up.
CREATE TABLE IF NOT EXISTS inventory.vin_decoded (
  vin              text        PRIMARY KEY,
  trim             text,
  engine           text,       -- human-readable summary, e.g. "3.5L V6 Gas"
  engine_cylinders text,
  displacement_l   text,
  fuel_type        text,
  -- 'decoded' | 'not_found' | 'error' — a definite non-decodable VIN
  -- (bad check digit, pre-1981, NHTSA has no record) still gets a row so
  -- it isn't retried on every future "Decode" click, same "advance past a
  -- definite outcome" rule geocode_status already uses on droptop_orders.
  decode_status    text        NOT NULL DEFAULT 'decoded',
  decoded_at       timestamptz NOT NULL DEFAULT now(),
  raw_response     jsonb
);

ALTER TABLE inventory.vin_decoded ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vin_decoded_select" ON inventory.vin_decoded;
CREATE POLICY "vin_decoded_select" ON inventory.vin_decoded FOR SELECT
  USING ((SELECT auth.role()) = 'authenticated');
-- Written by the vin-decode Edge Function (service role) only.
