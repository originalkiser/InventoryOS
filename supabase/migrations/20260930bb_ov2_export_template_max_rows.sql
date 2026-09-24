-- Orders v2 Export's per-vendor template (inventory.ov2_export_templates)
-- gains an optional "split into files of at most N lines" setting —
-- Valvoline's own upload portal rejects a CSV over 100 lines, so a large
-- order has to be split into several sequentially-numbered files rather
-- than exported as one. NULL/0 means "don't split" (today's existing
-- single-file behavior, unchanged for every other vendor's template).
ALTER TABLE inventory.ov2_export_templates
  ADD COLUMN IF NOT EXISTS max_rows_per_file integer;
