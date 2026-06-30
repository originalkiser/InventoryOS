-- Add weekly_shop_exclusions to user_sidebar_prefs.
-- Stores an array of location IDs the user has manually excluded from
-- the Weekly Counts view. Persisted per-user, applies across all weeks.

ALTER TABLE core.user_sidebar_prefs
  ADD COLUMN IF NOT EXISTS weekly_shop_exclusions jsonb DEFAULT '[]'::jsonb;
