-- Guards against two background backfills for the SAME connection running
-- at once (found live 2026-09-19, user question: "what happens if a new
-- one is stacked on top... does it override or add more"). Answer before
-- this fix: it adds more, silently -- data-connection-backfill-dispatcher's
-- own job loop does `select('*').eq('status', 'running')` with no
-- per-connection dedup at all, so two 'running' rows for the same
-- (company_id, connection_key) both get ticked, every cycle, independently
-- -- each hitting Droptop's API for potentially the very same shops/months,
-- multiplying outbound load and making the exact chunk-timeout problem
-- fixed the same day (20260930ag's forms fix aside -- see this migration's
-- sibling commit) worse, not better. BackgroundBackfillPanel.tsx's own
-- start() always INSERTs a new row with no existence check first, so this
-- was reachable via a genuine race (two users, or one user across two
-- tabs, both loading the panel before either's insert lands) as well as
-- deliberately.
--
-- A DB-level partial unique index is the only race-proof fix (a
-- client-side "check first, then insert" has the exact same race window
-- as the current code does) -- enforced regardless of how many browsers/
-- users are looking at the page. BackgroundBackfillPanel.tsx's start()
-- catches the resulting unique-violation and shows a friendly message
-- plus a fresh reload of the existing running job, instead of a raw DB
-- error.
CREATE UNIQUE INDEX data_connection_backfill_jobs_one_running_per_connection
  ON inventory.data_connection_backfill_jobs (company_id, connection_key)
  WHERE status = 'running';
