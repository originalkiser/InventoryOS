-- Address-level geocoding for Customer Heatmap — an OPTIONAL alternative
-- to the existing zip-centroid approach (inventory.zip_centroids), not a
-- replacement. Zip-centroid plots every customer in a zip at the same
-- point (the zip's center); this resolves each order's actual street
-- address to real coordinates via the US Census Bureau's free Geocoding
-- Services API (https://geocoding.geo.census.gov/geocoder/ — no API key,
-- no cost, US addresses only).
--
-- geocoded_lat/lng/status/at live directly on droptop_orders (read path
-- stays a plain column check, no join needed for the heatmap query).
-- geocode_status: 'matched' | 'no_match' | null (not yet attempted) — a
-- real address Census can't match (typo, PO box, new construction) is
-- tracked as 'no_match' so it isn't retried every run, same reasoning as
-- droptop_order_sync_state advancing only on success elsewhere in this
-- system.
ALTER TABLE inventory.droptop_orders
  ADD COLUMN IF NOT EXISTS geocoded_lat numeric,
  ADD COLUMN IF NOT EXISTS geocoded_lng numeric,
  ADD COLUMN IF NOT EXISTS geocode_status text,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_droptop_orders_geocode_pending
  ON inventory.droptop_orders (company_id)
  WHERE geocode_status IS NULL;

-- Cache keyed by normalized address text — a repeat customer (or several
-- customers at the same address) shouldn't cost a fresh Census lookup on
-- every order. address_key is built by the edge function as
-- `${address}|${city}|${region}|${zip}`, uppercased and trimmed.
CREATE TABLE IF NOT EXISTS inventory.geocoded_addresses (
  address_key     text        PRIMARY KEY,
  lat             numeric,
  lng             numeric,
  matched_address text,
  status          text        NOT NULL,
  geocoded_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE inventory.geocoded_addresses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "geocoded_addresses_select" ON inventory.geocoded_addresses;
CREATE POLICY "geocoded_addresses_select" ON inventory.geocoded_addresses FOR SELECT
  USING (auth.role() = 'authenticated');
-- Written by the service-role Edge Function only. Not company-scoped — an
-- address is an address regardless of which company's customer it
-- belongs to, so this cache is shared/global rather than duplicated per
-- company (mirrors inventory.zip_centroids' own global, non-company-
-- scoped shape).
