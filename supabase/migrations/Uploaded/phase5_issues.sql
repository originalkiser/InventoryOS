-- =====================================================================
-- PHASE 5 — Issues: free-form title so issues don't need a location.
-- Idempotent.
-- =====================================================================

alter table issues add column if not exists title text;
