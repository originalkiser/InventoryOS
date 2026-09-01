-- inventory.zip_boundaries — US ZCTA (Zip Code Tabulation Area) polygon
-- boundaries, for the Customer Heatmap's choropleth view (actual zip
-- outlines, color-coded the same way as the existing density circles)
-- as a toggleable alternative to the circle-based view — not a
-- replacement (see CustomerHeatmapPage.tsx's own view-mode toggle).
--
-- Data: US Census Bureau 2020 Cartographic Boundary Files, ZCTA5 at
-- 1:500,000 resolution (cb_2020_us_zcta520_500k, public domain —
-- https://www2.census.gov/geo/tiger/GENZ2020/shp/), converted from
-- shapefile to GeoJSON and simplified 8% via mapshaper (pulled
-- 2026-09-01). 33,791 ZCTAs nationwide, ~16MB total as GeoJSON — stored
-- per-zip here so the app only ever fetches the handful to few thousand
-- zips actually in view, never the whole dataset at once.
--
-- geometry is a raw GeoJSON Polygon/MultiPolygon object (no "type":
-- "Feature" wrapper, no properties) — the app wraps it itself when
-- building a Feature for react-leaflet's <GeoJSON>. A ZCTA is an
-- approximation of a ZIP code's area (Census's own tabulation geography,
-- not the Postal Service's actual delivery boundary), same caveat every
-- ZCTA-based map has — close enough for a density visualization, not
-- authoritative for anything address-exact.
--
-- Unlike zip_centroids (whose ~2.7MB of data is committed as SQL insert
-- files), this table's data (~15MB, 31,375 rows) is NOT committed to the
-- repo — regenerable on demand from a public, versioned government source
-- rather than a one-off community CSV. To reproduce: download
-- cb_2020_us_zcta520_500k.zip from the URL above, run
-- `npx mapshaper <file>.zip -simplify 8% -filter-fields ZCTA5CE20 -o
-- format=geojson precision=0.0001 out.geojson`, then batch-insert
-- (zip=properties.ZCTA5CE20, geometry=the geometry object) in chunks of
-- ~300 rows per INSERT (dollar-quote the jsonb literal to avoid escaping).
-- Applied directly to production 2026-09-01 via the Supabase CLI.
CREATE TABLE IF NOT EXISTS inventory.zip_boundaries (
  zip      text  PRIMARY KEY,
  geometry jsonb NOT NULL
);
ALTER TABLE inventory.zip_boundaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "zip_boundaries_select" ON inventory.zip_boundaries;
CREATE POLICY "zip_boundaries_select" ON inventory.zip_boundaries FOR SELECT
  USING (auth.role() = 'authenticated');
