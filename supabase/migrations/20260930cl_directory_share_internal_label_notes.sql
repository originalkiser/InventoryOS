-- Shop-links directory share: INTERNAL tracking fields (direct ask 2026-10-02).
-- `label` stays the title shown on the shared page; `link_label` is an admin-only
-- name for telling links apart and `notes` is why/when it was made. Neither is
-- ever returned by get_menu_board_directory, so they never reach the public page.
ALTER TABLE marketing.menu_board_directory_shares
  ADD COLUMN IF NOT EXISTS link_label text,
  ADD COLUMN IF NOT EXISTS notes text;
