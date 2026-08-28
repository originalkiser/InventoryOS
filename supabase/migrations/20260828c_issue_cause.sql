-- Optional "Cause" (category + sub-cause) on Issues — see
-- src/lib/causeTaxonomy.ts for the fixed category/sub-cause list. Location
-- Comms' own cause fields live in its existing metadata jsonb column
-- instead (same convention that column already uses for resolution_notes),
-- so no migration is needed there.
ALTER TABLE platform.issues ADD COLUMN IF NOT EXISTS cause_category text;
ALTER TABLE platform.issues ADD COLUMN IF NOT EXISTS cause_subcause text;
