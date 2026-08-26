-- Lets an admin/developer force a user's password without them owning email
-- access to complete a reset link — the new admin-password-reset Edge
-- Function sets a temp password via the service-role Admin API and flags
-- this column so the app makes them set a real one on next login.
ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false;
