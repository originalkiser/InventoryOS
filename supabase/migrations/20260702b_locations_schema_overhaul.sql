-- core.locations schema overhaul
-- Renames key columns, promotes metadata fields to real columns,
-- adds ~70 new operational columns.
-- Apply in Supabase SQL editor AFTER 20260702_location_routes.sql

-- ── 1. Rename primary identifier columns ────────────────────────────────────
-- location_code → name  (the short code, e.g. "001")
-- name          → shop_city  (the human label, e.g. "101 - Atlanta")
ALTER TABLE core.locations RENAME COLUMN name         TO shop_city;
ALTER TABLE core.locations RENAME COLUMN location_code TO name;

-- ── 2. Promote metadata JSONB fields → real columns ─────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS owner          text,
  ADD COLUMN IF NOT EXISTS market         text,
  ADD COLUMN IF NOT EXISTS area_manager   text,
  ADD COLUMN IF NOT EXISTS am_phone       text,
  ADD COLUMN IF NOT EXISTS am_email       text,
  ADD COLUMN IF NOT EXISTS director       text,
  ADD COLUMN IF NOT EXISTS rd_email       text;

UPDATE core.locations SET
  owner        = metadata->>'owner',
  market       = metadata->>'market',
  area_manager = metadata->>'area_manager',
  am_phone     = metadata->>'area_manager_phone',
  am_email     = metadata->>'am_email',
  director     = COALESCE(metadata->>'regional_director', metadata->>'director'),
  rd_email     = metadata->>'rd_email'
WHERE metadata IS NOT NULL;

-- ── 3. status (replaces active boolean) ─────────────────────────────────────
ALTER TABLE core.locations ADD COLUMN IF NOT EXISTS status text;
UPDATE core.locations SET status = CASE WHEN active THEN 'Active' ELSE 'Inactive' END;
-- Keep active column for now; RLS/existing policies may reference it.
-- Drop it only after confirming no dependent policies remain:
-- ALTER TABLE core.locations DROP COLUMN active;

-- ── 4. Address / contact fields ──────────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS address      text,
  ADD COLUMN IF NOT EXISTS city         text,
  ADD COLUMN IF NOT EXISTS state        text,
  ADD COLUMN IF NOT EXISTS county       text,
  ADD COLUMN IF NOT EXISTS zip          text,
  ADD COLUMN IF NOT EXISTS store_phone  text,
  ADD COLUMN IF NOT EXISTS store_email  text,
  ADD COLUMN IF NOT EXISTS location     text;

-- ── 5. Operational / capacity fields ────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS num_bays               integer,
  ADD COLUMN IF NOT EXISTS pit_type               text,
  ADD COLUMN IF NOT EXISTS store_type             text,
  ADD COLUMN IF NOT EXISTS classification         text,
  ADD COLUMN IF NOT EXISTS groups                 text,
  ADD COLUMN IF NOT EXISTS entity_name            text,
  ADD COLUMN IF NOT EXISTS brand_used             text,
  ADD COLUMN IF NOT EXISTS developer              text,
  ADD COLUMN IF NOT EXISTS landlord               text,
  ADD COLUMN IF NOT EXISTS num_days_open          integer,
  ADD COLUMN IF NOT EXISTS manager_workweek       text,
  ADD COLUMN IF NOT EXISTS second_asm_approved    boolean;

-- ── 6. Date fields ───────────────────────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS date_opened         date,
  ADD COLUMN IF NOT EXISTS acquisition_date    date,
  ADD COLUMN IF NOT EXISTS year_opened         integer,
  ADD COLUMN IF NOT EXISTS droptop_go_live     date,
  ADD COLUMN IF NOT EXISTS last_price_change   date,
  ADD COLUMN IF NOT EXISTS review_pricing_date date,
  ADD COLUMN IF NOT EXISTS last_day_of_business date;

-- ── 7. Store hours ───────────────────────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS monday_hours    text,
  ADD COLUMN IF NOT EXISTS tuesday_hours   text,
  ADD COLUMN IF NOT EXISTS wednesday_hours text,
  ADD COLUMN IF NOT EXISTS thursday_hours  text,
  ADD COLUMN IF NOT EXISTS friday_hours    text,
  ADD COLUMN IF NOT EXISTS saturday_hours  text,
  ADD COLUMN IF NOT EXISTS sunday_hours    text,
  ADD COLUMN IF NOT EXISTS holiday_hours   text;

-- ── 8. Services offered (boolean flags) ─────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS tire_rotations      boolean,
  ADD COLUMN IF NOT EXISTS safety_inspections  boolean,
  ADD COLUMN IF NOT EXISTS emissions_inspections boolean;

-- ── 9. Financial / rate fields ───────────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS royalty_rate            numeric,
  ADD COLUMN IF NOT EXISTS local_ad_percent        numeric,
  ADD COLUMN IF NOT EXISTS local_ad_dollar         numeric,
  ADD COLUMN IF NOT EXISTS brand_fund              numeric,
  ADD COLUMN IF NOT EXISTS technology_fee          numeric,
  ADD COLUMN IF NOT EXISTS sales_quartile          text,
  ADD COLUMN IF NOT EXISTS economy                 numeric,
  ADD COLUMN IF NOT EXISTS premium_hm              numeric,
  ADD COLUMN IF NOT EXISTS premium_full_synthetic  numeric,
  ADD COLUMN IF NOT EXISTS premium_full_synthetic_hm numeric,
  ADD COLUMN IF NOT EXISTS rp                      numeric,
  ADD COLUMN IF NOT EXISTS diesel_syn_blend        numeric,
  ADD COLUMN IF NOT EXISTS diesel_full_syn         numeric,
  ADD COLUMN IF NOT EXISTS european                numeric,
  ADD COLUMN IF NOT EXISTS supply_fee              numeric,
  ADD COLUMN IF NOT EXISTS disposal_fee            numeric,
  ADD COLUMN IF NOT EXISTS oil_inflation_surcharge numeric;

-- ── 10. Planning / reporting fields ─────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS planned_2023  numeric,
  ADD COLUMN IF NOT EXISTS planned_2024  numeric;

-- ── 11. Integrations / external IDs ─────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS valvoline_account_num    text,
  ADD COLUMN IF NOT EXISTS ai_shop_id               text,
  ADD COLUMN IF NOT EXISTS ai_username              text,
  ADD COLUMN IF NOT EXISTS partnerconnect_username  text,
  ADD COLUMN IF NOT EXISTS google_review_url        text,
  ADD COLUMN IF NOT EXISTS google_review_qr_code    text,
  ADD COLUMN IF NOT EXISTS training_shops           text,
  ADD COLUMN IF NOT EXISTS integration_manager_region text,
  ADD COLUMN IF NOT EXISTS opus_serial_primary      text,
  ADD COLUMN IF NOT EXISTS opus_serial_secondary    text,
  ADD COLUMN IF NOT EXISTS former_fz_store_num      text,
  ADD COLUMN IF NOT EXISTS tmcw_ql                  text,
  ADD COLUMN IF NOT EXISTS am_data_map              text,
  ADD COLUMN IF NOT EXISTS rd_data_map              text,
  ADD COLUMN IF NOT EXISTS droptop_num              text,
  ADD COLUMN IF NOT EXISTS droptop_operation_id     text,
  ADD COLUMN IF NOT EXISTS reladyne_delivery_day    text,
  ADD COLUMN IF NOT EXISTS ai_call_center           text,
  ADD COLUMN IF NOT EXISTS ai_call_center_phone     text,
  ADD COLUMN IF NOT EXISTS mighty_fz                text,
  ADD COLUMN IF NOT EXISTS camera_system            text,
  ADD COLUMN IF NOT EXISTS inspection_station_id    text,
  ADD COLUMN IF NOT EXISTS mighty_po_upload         boolean;

-- ── 12. People / contact fields ──────────────────────────────────────────────
ALTER TABLE core.locations
  ADD COLUMN IF NOT EXISTS marketing_manager text,
  ADD COLUMN IF NOT EXISTS mm_email          text,
  ADD COLUMN IF NOT EXISTS mm_cell           text,
  ADD COLUMN IF NOT EXISTS hrbp              text;
