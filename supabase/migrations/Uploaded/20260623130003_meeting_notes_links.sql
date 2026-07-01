-- Meeting Notes: add links column for URL list with optional labels
-- Array of { label: string, url: string }

ALTER TABLE inventory.meeting_notes
  ADD COLUMN IF NOT EXISTS links jsonb DEFAULT '[]';

-- Also ensure attachments table supports meeting_note entity type
-- by dropping and recreating the CHECK constraint to include 'meeting_note'
ALTER TABLE attachments
  DROP CONSTRAINT IF EXISTS attachments_entity_type_check;

ALTER TABLE attachments
  ADD CONSTRAINT attachments_entity_type_check
    CHECK (entity_type IN ('issue', 'project', 'meeting_note'));
