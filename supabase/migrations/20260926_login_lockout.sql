-- Login lockout: tracks consecutive failed sign-in attempts per user and
-- locks the account after too many. Written to by the (unauthenticated)
-- check-login-email / record-login-attempt Edge Functions using the
-- service role — an anonymous visitor obviously can't update their own
-- row under RLS before they've signed in, so this can't be a client-side
-- update. locked_at is the source of truth the app checks; the Edge
-- Functions also set a matching ban on the actual auth.users row via the
-- Admin API so a locked account can't sign in even by calling
-- supabase.auth.signInWithPassword() directly, bypassing this app's own
-- two-step login screen.

ALTER TABLE platform.user_profiles
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;
