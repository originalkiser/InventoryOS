-- Add helpful_links column to issues and projects
-- Stored as a text array of raw URLs; labels are derived client-side from the URL

ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS helpful_links text[] NOT NULL DEFAULT '{}';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS helpful_links text[] NOT NULL DEFAULT '{}';
