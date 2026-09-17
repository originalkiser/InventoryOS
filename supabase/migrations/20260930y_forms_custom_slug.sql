-- Customizable public form URL (2026-09-17 request): forms.sboc.app/:slug
-- instead of always the random /f/:share_token link — same "own subdomain,
-- pretty slug" pattern Menu Board already uses (menu.sboc.app), see that
-- module's own notes in CLAUDE.md. Globally unique, not per-company — the
-- forms.sboc.app/:slug URL space has no company qualifier in it the way
-- Menu Board's own <shop number>-<hash> shape effectively does.
ALTER TABLE forms.forms ADD COLUMN IF NOT EXISTS slug text;
CREATE UNIQUE INDEX IF NOT EXISTS forms_forms_slug_key ON forms.forms (slug) WHERE slug IS NOT NULL;

-- No RLS change needed — forms.forms' existing "forms_read" SELECT policy
-- (auth.role() = 'authenticated' OR is_published = true) already allows an
-- anonymous lookup by any column, share_token included; querying by slug
-- instead is covered by the same policy.
