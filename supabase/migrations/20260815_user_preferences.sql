-- Per-user cross-device UI preferences (dark mode, nav order, hover-panel
-- configs, etc.) stored as a single jsonb blob on the user's profile.
alter table platform.user_profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb;
