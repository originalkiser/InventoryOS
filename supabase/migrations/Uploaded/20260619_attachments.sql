-- Generic attachments table for issues and projects
-- Paired with Supabase Storage bucket "attachments"
-- Path pattern: {company_id}/{entity_type}/{entity_id}/{uuid}_{original_filename}

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('attachments', 'attachments', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS
CREATE POLICY "Auth users can upload attachments"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'attachments');

CREATE POLICY "Auth users can read attachments"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'attachments');

CREATE POLICY "Auth users can delete attachments"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'attachments');

-- Metadata table
CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('issue', 'project')),
  entity_id uuid NOT NULL,
  company_id uuid NOT NULL,
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  file_size bigint,
  content_type text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS attachments_company_idx ON attachments(company_id);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their company's attachments"
  ON attachments FOR SELECT USING (
    company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Users can insert attachments for their company"
  ON attachments FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "Users can delete their company's attachments"
  ON attachments FOR DELETE USING (
    company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid())
  );
