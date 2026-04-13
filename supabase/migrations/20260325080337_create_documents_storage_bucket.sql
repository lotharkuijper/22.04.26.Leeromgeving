/*
  # Create Documents Storage Bucket

  1. Storage
    - Create 'documents' bucket for storing PDF and DOCX files
    - Set bucket to private (not publicly accessible)
    - Files only accessible through backend with proper authentication
  
  2. Security
    - Enable RLS on storage.objects table
    - Add policies for authenticated users to upload documents
    - Add policies for authenticated users to read their own documents
    - Add policies for docents/admins to manage all documents
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload documents"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'documents' AND
    auth.uid()::text = (storage.foldername(name))[1]
  );

CREATE POLICY "Users can view their own documents"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'documents' AND
    (
      auth.uid()::text = (storage.foldername(name))[1] OR
      EXISTS (
        SELECT 1 FROM profiles
        WHERE profiles.id = auth.uid()
        AND profiles.role IN ('docent', 'admin')
      )
    )
  );

CREATE POLICY "Docents and admins can delete documents"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'documents' AND
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );
