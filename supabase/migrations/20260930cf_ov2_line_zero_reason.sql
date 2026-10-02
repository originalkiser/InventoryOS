-- Orders v2 (direct ask 2026-10-02): when a suggested product is adjusted to 0
-- on Review, the user can tag WHY (on order / inaccurate on hands / not
-- needed / other + free text) so changes to the engine's suggestion can be
-- tracked later. Optional — a zeroed line without a reason is still valid.
-- Draft lines only: zeroed lines aren't copied into ov2_order_history_lines
-- (history keeps just what was actually ordered), and the draft itself stays
-- around after export.
ALTER TABLE inventory.ov2_order_draft_lines
  ADD COLUMN IF NOT EXISTS zero_reason text,
  ADD COLUMN IF NOT EXISTS zero_reason_note text;
