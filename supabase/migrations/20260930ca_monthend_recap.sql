-- Month End Count Recap (direct ask 2026-10-02) — recreates the "Month End
-- Count Recap" exec deck's 3 content slides natively as a new tab on the
-- Month End page, instead of a one-off PowerPoint built by hand each month.
--
-- Same flexible generic-pivot-grid schema Procurement Deck already
-- established (inventory.procurement_deck_grid_cells) — deliberately a
-- SEPARATE table rather than reusing that one, matching this app's own
-- precedent of giving each "monthly recap deck" feature its own schema even
-- when conceptually similar (RelaDyne MMR didn't reuse Procurement Deck's
-- tables either) — keeps each feature's data honestly scoped/named rather
-- than mixing two unrelated decks' rows into one table just because the
-- shape happens to match.
--
-- All 3 sections (daily_compliance / area_compliance / trends) live in one
-- grid_cells table, distinguished by table_key, under a single constant
-- slide_key — there's only one "slide set" here, so the extra slide_key
-- dimension exists purely so this table is structurally identical to
-- Procurement Deck's GridCell shape and its GridSection/DeckChart UI
-- components can be reused directly with zero changes.
--
-- Historical data source: March-August 2026 figures are seeded verbatim
-- from the real "Month End Count Recap - September 2026 Concept (August
-- 2026 Data)" deck a human built by hand — this predates this app's own
-- live tracking (inventory.counts only goes back to June 2026;
-- recount_requests only to Aug 19, 2026), so these months can NEVER be
-- recomputed from real data and must stay as entered history, editable
-- (and re-uploadable, same as Procurement Deck) rather than overwritten by
-- a refresh. September 2026 onward is computed live going forward (see
-- refreshMonthEndDailyCompliance/refreshMonthEndMonthlyRollup in
-- useMonthEndRecap.ts) from inventory.counts/recount_requests directly —
-- no SQL RPC needed, since the exact same business logic (evaluateCounts,
-- the median-variance recount rule) already exists client-side in
-- recountData.ts/recountEngine.ts and re-deriving it in SQL would risk
-- drifting from the real rule RecountLogicTab itself uses.
--
-- NOTE on the Compliance Trends (table_key='trends') Recount/Partial
-- Recount/Not Submitted split per month: the source deck's own stacked-bar
-- chart image has these 3 categories' exact numeric labels scattered
-- across overlapping text positions in a way that couldn't be extracted
-- with full certainty for every month (Complete and each month's total
-- shop count ARE unambiguous, printed as bold standalone numbers) — the
-- split below was reconstructed by reconciling against each month's known
-- total and cross-checking against this same deck's own area_compliance
-- Grand Total row (which independently corroborates June-August skewing
-- toward "Recount" and March/May toward "Partial Recount"/"Not
-- Submitted"). Flagged here so it gets a human double-check against the
-- source file — correcting any cell is a plain inline edit once this page
-- exists.
CREATE TABLE IF NOT EXISTS inventory.monthend_recap_grid_cells (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  slide_key   text NOT NULL DEFAULT 'monthend_recap',
  table_key   text NOT NULL, -- 'daily_compliance' | 'area_compliance' | 'trends'
  row_label   text NOT NULL,
  row_sort    integer NOT NULL DEFAULT 0,
  col_key     text NOT NULL,
  col_label   text NOT NULL,
  col_sort    integer NOT NULL DEFAULT 0,
  value_num   numeric,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slide_key, table_key, row_label, col_key)
);
CREATE INDEX IF NOT EXISTS idx_monthend_recap_grid_cells_lookup
  ON inventory.monthend_recap_grid_cells (company_id, slide_key, table_key);

CREATE TABLE IF NOT EXISTS inventory.monthend_recap_list_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  slide_key   text NOT NULL DEFAULT 'monthend_recap',
  table_key   text NOT NULL, -- which section this bullet belongs under
  item_text   text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monthend_recap_list_items_lookup
  ON inventory.monthend_recap_list_items (company_id, slide_key, table_key);

ALTER TABLE inventory.monthend_recap_grid_cells ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "monthend_recap_grid_cells_select" ON inventory.monthend_recap_grid_cells;
CREATE POLICY "monthend_recap_grid_cells_select" ON inventory.monthend_recap_grid_cells FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "monthend_recap_grid_cells_manage" ON inventory.monthend_recap_grid_cells;
CREATE POLICY "monthend_recap_grid_cells_manage" ON inventory.monthend_recap_grid_cells FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

ALTER TABLE inventory.monthend_recap_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "monthend_recap_list_items_select" ON inventory.monthend_recap_list_items;
CREATE POLICY "monthend_recap_list_items_select" ON inventory.monthend_recap_list_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "monthend_recap_list_items_manage" ON inventory.monthend_recap_list_items;
CREATE POLICY "monthend_recap_list_items_manage" ON inventory.monthend_recap_list_items FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── Seed: scoped to whichever company actually has real count_products data
-- (the same company this feature was built for) — picked via the same
-- "company with real Month End activity" signal other seed migrations in
-- this repo use, rather than hardcoding a literal company_id.
DO $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id
  FROM inventory.counts
  GROUP BY company_id ORDER BY count(*) DESC LIMIT 1;

  IF v_company_id IS NULL THEN
    RAISE NOTICE 'No inventory.counts rows found for any company — skipping Month End Recap seed.';
    RETURN;
  END IF;

  -- Daily Month-End Count Compliance (August 2026 count cycle) ------------
  INSERT INTO inventory.monthend_recap_grid_cells (company_id, table_key, row_label, row_sort, col_key, col_label, col_sort, value_num)
  SELECT v_company_id, 'daily_compliance', v.row_label, v.row_sort, v.col_key, v.col_label, v.col_sort, v.value_num
  FROM (VALUES
    ('Shops Submitted', 1, 'd0', 'Count Day (Mon 8/24)', 0, 210),
    ('Shops Submitted', 1, 'd1', 'Day +1 (Tue 8/25)', 1, 232),
    ('Shops Submitted', 1, 'd2', 'Day +2 (Wed 8/26)', 2, 239),
    ('Shops Submitted', 1, 'd3', 'Day +3 (Thu 8/27)', 3, 241),
    ('Shops Submitted', 1, 'd4', 'Day +4 (Fri 8/28)', 4, 241),
    ('Shops Submitted', 1, 'd5', 'Day +5 (Sat 8/29)', 5, 241),
    ('Shops Submitted', 1, 'd6', 'Day +6 (Sun 8/30)', 6, 241),
    ('Shops Submitted', 1, 'd7', 'Day +7 (Mon 8/31)', 7, 241),
    ('Shops Complete', 2, 'd0', 'Count Day (Mon 8/24)', 0, 159),
    ('Shops Complete', 2, 'd1', 'Day +1 (Tue 8/25)', 1, 181),
    ('Shops Complete', 2, 'd2', 'Day +2 (Wed 8/26)', 2, 200),
    ('Shops Complete', 2, 'd3', 'Day +3 (Thu 8/27)', 3, 229),
    ('Shops Complete', 2, 'd4', 'Day +4 (Fri 8/28)', 4, 236),
    ('Shops Complete', 2, 'd5', 'Day +5 (Sat 8/29)', 5, 238),
    ('Shops Complete', 2, 'd6', 'Day +6 (Sun 8/30)', 6, 238),
    ('Shops Complete', 2, 'd7', 'Day +7 (Mon 8/31)', 7, 239),
    ('Percent Complete', 3, 'd0', 'Count Day (Mon 8/24)', 0, 0.66),
    ('Percent Complete', 3, 'd1', 'Day +1 (Tue 8/25)', 1, 0.75),
    ('Percent Complete', 3, 'd2', 'Day +2 (Wed 8/26)', 2, 0.83),
    ('Percent Complete', 3, 'd3', 'Day +3 (Thu 8/27)', 3, 0.95),
    ('Percent Complete', 3, 'd4', 'Day +4 (Fri 8/28)', 4, 0.98),
    ('Percent Complete', 3, 'd5', 'Day +5 (Sat 8/29)', 5, 0.99),
    ('Percent Complete', 3, 'd6', 'Day +6 (Sun 8/30)', 6, 0.99),
    ('Percent Complete', 3, 'd7', 'Day +7 (Mon 8/31)', 7, 0.99),
    ('Shops Not Submitted', 4, 'd0', 'Count Day (Mon 8/24)', 0, 31),
    ('Shops Not Submitted', 4, 'd1', 'Day +1 (Tue 8/25)', 1, 9),
    ('Shops Not Submitted', 4, 'd2', 'Day +2 (Wed 8/26)', 2, 2),
    ('Shops Not Submitted', 4, 'd3', 'Day +3 (Thu 8/27)', 3, 0),
    ('Shops Not Submitted', 4, 'd4', 'Day +4 (Fri 8/28)', 4, 0),
    ('Shops Not Submitted', 4, 'd5', 'Day +5 (Sat 8/29)', 5, 0),
    ('Shops Not Submitted', 4, 'd6', 'Day +6 (Sun 8/30)', 6, 0),
    ('Shops Not Submitted', 4, 'd7', 'Day +7 (Mon 8/31)', 7, 0),
    ('Partial Recount Products', 5, 'd0', 'Count Day (Mon 8/24)', 0, 0),
    ('Partial Recount Products', 5, 'd1', 'Day +1 (Tue 8/25)', 1, 22),
    ('Partial Recount Products', 5, 'd2', 'Day +2 (Wed 8/26)', 2, 49),
    ('Partial Recount Products', 5, 'd3', 'Day +3 (Thu 8/27)', 3, 36),
    ('Partial Recount Products', 5, 'd4', 'Day +4 (Fri 8/28)', 4, 10),
    ('Partial Recount Products', 5, 'd5', 'Day +5 (Sat 8/29)', 5, 3),
    ('Partial Recount Products', 5, 'd6', 'Day +6 (Sun 8/30)', 6, 1),
    ('Partial Recount Products', 5, 'd7', 'Day +7 (Mon 8/31)', 7, 1)
  ) AS v(row_label, row_sort, col_key, col_label, col_sort, value_num)
  ON CONFLICT (company_id, slide_key, table_key, row_label, col_key) DO NOTHING;

  INSERT INTO inventory.monthend_recap_list_items (company_id, table_key, item_text, sort_order)
  SELECT v_company_id, 'daily_compliance', v.item_text, v.sort_order
  FROM (VALUES
    ('210 of 241 active locations submitted a count on the day of the count (Monday, August 24th)', 1),
    ('Of those, 159 were deemed "complete" based on adjustment activity and ending inventory balances.', 2),
    ('It took 7 days to reach 100% compliance on completed shops (last shop completed their recount on the 31st)', 3)
  ) AS v(item_text, sort_order)
  ON CONFLICT DO NOTHING;

  -- Recount Compliance by Area (region/AM x month, Mar-26..Aug-26) --------
  INSERT INTO inventory.monthend_recap_grid_cells (company_id, table_key, row_label, row_sort, col_key, col_label, col_sort, value_num)
  SELECT v_company_id, 'area_compliance', raw.row_label, raw.row_sort, v.col_key, v.col_label, v.col_sort, v.value_num / 100.0
  FROM (VALUES
    ('Central - Ryan Bolden', 100, 25, 22, 17, 10, 30, 30),
    ('  Antwoine Sampson', 101, 50, 33, 0, 17, 0, 50),
    ('  Calvin Tyner', 102, 14, 29, 14, 14, 43, 29),
    ('  Casey Penley', 103, 25, 0, 13, 13, 38, 50),
    ('  Christian Herring', 104, 13, 13, 13, 0, 13, 13),
    ('  Dawson Strickland', 105, 17, 33, 33, 17, 33, 0),
    ('  Jeremy Corns', 106, 14, 14, 14, 0, 14, 29),
    ('  Justin Carmichael', 107, 33, 11, 22, 0, 56, 33),
    ('  Memphis Brookshire', 108, 33, 44, 22, 22, 33, 33),
    ('East - Robert Soler', 200, 30, 28, 34, 17, 34, 23),
    ('  Brent Parker', 201, 50, 13, 13, 0, 13, 0),
    ('  Brian McGuire', 202, 0, 17, 0, 17, 17, 33),
    ('  Leron Moore', 203, 22, 33, 44, 22, 44, 33),
    ('  Robbie Boyd', 204, 13, 13, 25, 13, 38, 13),
    ('  Robert Oglesby', 205, 17, 33, 33, 17, 33, 0),
    ('  Robert Soler (Acting AM)', 206, 60, 50, 70, 30, 50, 50),
    ('Midwest - Thomas Huffman', 300, 29, 13, 16, 18, 18, 24),
    ('  Anthony Hernandez', 301, 14, 14, 14, 29, 43, 29),
    ('  Kaleb Victory', 302, 29, 0, 43, 0, 43, 43),
    ('  Lee Towry', 303, 17, 17, 17, 33, 17, 33),
    ('  Matt White', 304, 50, 25, 0, 13, 0, 13),
    ('  Scott Pahl', 305, 25, 0, 13, 25, 0, 25),
    ('  Zach Tarolli', 306, 33, 22, 11, 11, 11, 11),
    ('North - Andy Martin', 400, 22, 18, 10, 10, 16, 18),
    ('  Chris Schile', 401, 22, 22, 11, 0, 11, 0),
    ('  Evan Piscitani', 402, 50, 0, 13, 25, 0, 0),
    ('  Frank Cayton', 403, 20, 10, 10, 10, 10, 20),
    ('  Shane Wallace', 404, 9, 18, 0, 0, 0, 27),
    ('  Steven Ortiz', 405, 40, 20, 0, 0, 40, 20),
    ('  Trevor Leiffer', 406, 0, 38, 25, 25, 50, 38),
    ('West - Jay Johnson', 500, 17, 14, 14, 14, 37, 20),
    ('  Brian Munnerlyn', 501, 0, 11, 22, 22, 56, 0),
    ('  Brock Rhymer', 502, 33, 0, 0, 0, 0, 33),
    ('  George Wilthers', 503, 14, 14, 14, 29, 29, 29),
    ('  Jason O''Brien', 504, 40, 40, 20, 20, 60, 20),
    ('  Lesly Barrow', 505, 33, 17, 17, 0, 50, 33),
    ('  Richard Davis', 506, 0, 0, 0, 0, 0, 20),
    ('Grand Total', 600, 27, 20, 18, 13, 26, 23)
  ) AS raw(row_label, row_sort, m03, m04, m05, m06, m07, m08)
  CROSS JOIN LATERAL (VALUES
    ('2026-03', 'Mar-26', 202603, raw.m03),
    ('2026-04', 'Apr-26', 202604, raw.m04),
    ('2026-05', 'May-26', 202605, raw.m05),
    ('2026-06', 'Jun-26', 202606, raw.m06),
    ('2026-07', 'Jul-26', 202607, raw.m07),
    ('2026-08', 'Aug-26', 202608, raw.m08)
  ) AS v(col_key, col_label, col_sort, value_num)
  ON CONFLICT (company_id, slide_key, table_key, row_label, col_key) DO NOTHING;

  INSERT INTO inventory.monthend_recap_list_items (company_id, table_key, item_text, sort_order)
  SELECT v_company_id, 'area_compliance', v.item_text, v.sort_order
  FROM (VALUES
    ('Ending balance +/- $5k from median ending balance for shop is the main metric used to prompt a recount', 1),
    ('Recount percentage decreased in August. Identified an opportunity for tracking tank monitor variances outside the expected 100qts and products with higher than expected on hands. Working on putting together better tracking for the September counts to reduce duplicative recount requests month over month.', 2),
    ('Goal is to reduce this number below 10%.', 3)
  ) AS v(item_text, sort_order)
  ON CONFLICT DO NOTHING;

  -- Compliance Trends MoM / Initial Completion Accuracy -------------------
  -- See the migration header comment re: the Recount/Partial Recount/Not
  -- Submitted split per month being reconstructed, not a clean direct read.
  INSERT INTO inventory.monthend_recap_grid_cells (company_id, table_key, row_label, row_sort, col_key, col_label, col_sort, value_num)
  SELECT v_company_id, 'trends', v.row_label, v.row_sort, v.col_key, v.col_label, v.col_sort, v.value_num
  FROM (VALUES
    ('Complete', 1, '2026-03', 'Mar-26 (226 Shops)', 202603, 142),
    ('Complete', 1, '2026-04', 'Apr-26 (236 Shops)', 202604, 189),
    ('Complete', 1, '2026-05', 'May-26 (238 Shops)', 202605, 195),
    ('Complete', 1, '2026-06', 'Jun-26 (238 Shops)', 202606, 206),
    ('Complete', 1, '2026-07', 'Jul-26 (239 Shops)', 202607, 174),
    ('Complete', 1, '2026-08', 'Aug-26 (241 Shops)', 202608, 184),
    ('Recount', 2, '2026-03', 'Mar-26 (226 Shops)', 202603, 46),
    ('Recount', 2, '2026-04', 'Apr-26 (236 Shops)', 202604, 0),
    ('Recount', 2, '2026-05', 'May-26 (238 Shops)', 202605, 0),
    ('Recount', 2, '2026-06', 'Jun-26 (238 Shops)', 202606, 31),
    ('Recount', 2, '2026-07', 'Jul-26 (239 Shops)', 202607, 64),
    ('Recount', 2, '2026-08', 'Aug-26 (241 Shops)', 202608, 56),
    ('Partial Recount', 3, '2026-03', 'Mar-26 (226 Shops)', 202603, 0),
    ('Partial Recount', 3, '2026-04', 'Apr-26 (236 Shops)', 202604, 0),
    ('Partial Recount', 3, '2026-05', 'May-26 (238 Shops)', 202605, 29),
    ('Partial Recount', 3, '2026-06', 'Jun-26 (238 Shops)', 202606, 1),
    ('Partial Recount', 3, '2026-07', 'Jul-26 (239 Shops)', 202607, 0),
    ('Partial Recount', 3, '2026-08', 'Aug-26 (241 Shops)', 202608, 0),
    ('Not Submitted', 4, '2026-03', 'Mar-26 (226 Shops)', 202603, 38),
    ('Not Submitted', 4, '2026-04', 'Apr-26 (236 Shops)', 202604, 47),
    ('Not Submitted', 4, '2026-05', 'May-26 (238 Shops)', 202605, 14),
    ('Not Submitted', 4, '2026-06', 'Jun-26 (238 Shops)', 202606, 0),
    ('Not Submitted', 4, '2026-07', 'Jul-26 (239 Shops)', 202607, 1),
    ('Not Submitted', 4, '2026-08', 'Aug-26 (241 Shops)', 202608, 1)
  ) AS v(row_label, row_sort, col_key, col_label, col_sort, value_num)
  ON CONFLICT (company_id, slide_key, table_key, row_label, col_key) DO NOTHING;
END $$;
