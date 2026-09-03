-- Phase 3 (multiple_permissive_policies): inventory.counts had 7 permissive
-- policies where 4 would do. "Admins can manage monthly_counts" (ALL,
-- company AND is_admin()) is a strict subset of the plain company-only
-- policies already covering every command it touches — SELECT/INSERT via
-- "Company members can read/insert monthly_counts", UPDATE/DELETE via
-- counts_update/counts_delete — so any admin already gets in via those.
-- counts_select/counts_insert are literal duplicates of the newer-named
-- "Company members can read/insert monthly_counts" (same condition, old
-- vs new naming style). Dropping all three changes nothing about who can
-- see or modify what — same access, fewer policy evaluations per row.
-- Verified: 28 multiple_permissive_policies warnings for this table
-- resolved, no new findings on either advisor.
DROP POLICY IF EXISTS "Admins can manage monthly_counts" ON inventory.counts;
DROP POLICY IF EXISTS "counts_select" ON inventory.counts;
DROP POLICY IF EXISTS "counts_insert" ON inventory.counts;
