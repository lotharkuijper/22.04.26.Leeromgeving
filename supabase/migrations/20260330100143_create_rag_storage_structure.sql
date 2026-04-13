/*
  # Create RAG Storage Structure

  ## Overview
  This migration creates a comprehensive storage structure for the RAG system,
  separating documents into three buckets based on their purpose and processing needs.

  ## New Storage Buckets

  ### `rag_sources`
  - Purpose: Documents that will be processed for RAG (embeddings generated)
  - Allowed: PDF, DOCX, PPTX, TXT
  - Max size: 20MB per file
  - Access: Docents/Admins upload, Students can read
  - RAG Enabled: Yes

  ### `datasets`
  - Purpose: Data files for student download (no RAG processing)
  - Allowed: XLSX, CSV, OMV
  - Max size: 50MB per file
  - Access: Docents/Admins upload, Students can download
  - RAG Enabled: No

  ### `docs_general`
  - Purpose: General documentation and resources
  - Allowed: All file types
  - Max size: 10MB per file
  - Access: Docents/Admins upload, Students can read
  - RAG Enabled: No

  ## Modified Tables

  ### `document_folders`
  - Added `bucket_type` (text) - Which bucket this folder uses
  - Default: 'rag_sources' for backwards compatibility

  ## Security
  - All buckets are private (not publicly accessible)
  - RLS policies enforce role-based access
  - Students can only read/download, cannot upload
  - Docents and Admins can upload and manage files

  ## Notes
  - Existing 'documents' bucket remains for backwards compatibility
  - New uploads should use the appropriate bucket based on file type
  - Chunk size configuration: 1000 target tokens (800-1200 range)
*/

-- Create rag_sources bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rag_sources',
  'rag_sources',
  false,
  20971520,
  ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain']
)
ON CONFLICT (id) DO NOTHING;

-- Create datasets bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'datasets',
  'datasets',
  false,
  52428800,
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- Create docs_general bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'docs_general',
  'docs_general',
  false,
  10485760
)
ON CONFLICT (id) DO NOTHING;

-- Add bucket_type to document_folders table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_folders' AND column_name = 'bucket_type'
  ) THEN
    ALTER TABLE document_folders ADD COLUMN bucket_type text DEFAULT 'rag_sources'
      CHECK (bucket_type IN ('rag_sources', 'datasets', 'docs_general'));
  END IF;
END $$;

-- Add bucket column to documents table to track which bucket a document is in
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'bucket'
  ) THEN
    ALTER TABLE documents ADD COLUMN bucket text DEFAULT 'documents';
  END IF;
END $$;

-- Storage policies for rag_sources bucket

CREATE POLICY "Docents and admins can upload to rag_sources"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'rag_sources' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "All authenticated users can view rag_sources"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'rag_sources');

CREATE POLICY "Docents and admins can delete from rag_sources"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'rag_sources' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Storage policies for datasets bucket

CREATE POLICY "Docents and admins can upload to datasets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'datasets' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "All authenticated users can view datasets"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'datasets');

CREATE POLICY "Docents and admins can delete from datasets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'datasets' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Storage policies for docs_general bucket

CREATE POLICY "Docents and admins can upload to docs_general"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'docs_general' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "All authenticated users can view docs_general"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'docs_general');

CREATE POLICY "Docents and admins can delete from docs_general"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'docs_general' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

-- Create index for bucket_type
CREATE INDEX IF NOT EXISTS idx_document_folders_bucket_type ON document_folders(bucket_type);
CREATE INDEX IF NOT EXISTS idx_documents_bucket ON documents(bucket);
