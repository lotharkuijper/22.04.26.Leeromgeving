/*
  # Documents and RAG System

  ## Overview
  Dit creëert het document management en Retrieval Augmented Generation (RAG) systeem
  voor de epidemiologie leeromgeving.

  ## Extensions
  - `vector` - pgvector extensie voor vector embeddings

  ## New Tables
  
  ### `documents`
  - `id` (uuid, primary key)
  - `title` (text, not null) - Document titel
  - `filename` (text, not null) - Oorspronkelijke bestandsnaam
  - `file_path` (text, not null) - Supabase Storage path
  - `file_type` (text, not null) - MIME type (PDF, DOCX, etc)
  - `file_size` (bigint) - Bestandsgrootte in bytes
  - `description` (text) - Beschrijving van document
  - `uploaded_by` (uuid, foreign key) - Uploader (docent/admin)
  - `processing_status` (text) - Status: 'pending', 'processing', 'completed', 'failed'
  - `total_chunks` (integer) - Aantal chunks na processing
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### `document_chunks`
  - `id` (uuid, primary key)
  - `document_id` (uuid, foreign key) - Parent document
  - `chunk_index` (integer) - Positie in document (0, 1, 2, ...)
  - `content` (text, not null) - Tekst content van chunk
  - `token_count` (integer) - Aantal tokens in chunk
  - `embedding` (vector(1536)) - Vector embedding voor similarity search
  - `metadata` (jsonb) - Extra metadata (page number, section, etc)
  - `created_at` (timestamptz)

  ## Storage
  - Storage bucket 'documents' voor document bestanden

  ## Security
  - RLS enabled op alle tabellen
  - Alleen docenten en admin kunnen documenten uploaden
  - Alle authenticated users kunnen documenten lezen (voor RAG)
  - Alleen uploader of admin kan documenten verwijderen

  ## Functions
  - `match_document_chunks` - Vector similarity search functie
*/

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create documents table
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  filename text NOT NULL,
  file_path text NOT NULL,
  file_type text NOT NULL,
  file_size bigint DEFAULT 0,
  description text,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  processing_status text DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  total_chunks integer DEFAULT 0,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Create document_chunks table
CREATE TABLE IF NOT EXISTS document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  token_count integer DEFAULT 0,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(document_id, chunk_index)
);

-- Create index on embeddings for faster similarity search
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
  ON document_chunks 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Create index on document_id for faster lookups
CREATE INDEX IF NOT EXISTS document_chunks_document_id_idx 
  ON document_chunks(document_id);

-- Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- Documents policies
CREATE POLICY "All authenticated users can read documents"
  ON documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Docenten and admin can insert documents"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('docent', 'admin')
    )
  );

CREATE POLICY "Docenten and admin can update their own documents"
  ON documents FOR UPDATE
  TO authenticated
  USING (
    uploaded_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    uploaded_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Uploader or admin can delete documents"
  ON documents FOR DELETE
  TO authenticated
  USING (
    uploaded_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Document chunks policies
CREATE POLICY "All authenticated users can read chunks"
  ON document_chunks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "System can insert chunks"
  ON document_chunks FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_id
      AND (
        documents.uploaded_by = auth.uid() OR
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid()
          AND profiles.role IN ('docent', 'admin')
        )
      )
    )
  );

CREATE POLICY "System can delete chunks"
  ON document_chunks FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = document_id
      AND (
        documents.uploaded_by = auth.uid() OR
        EXISTS (
          SELECT 1 FROM profiles
          WHERE profiles.id = auth.uid()
          AND profiles.role = 'admin'
        )
      )
    )
  );

-- Function for vector similarity search
CREATE OR REPLACE FUNCTION match_document_chunks(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  content text,
  similarity float,
  document_title text,
  metadata jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity,
    d.title AS document_title,
    dc.metadata
  FROM document_chunks dc
  JOIN documents d ON d.id = dc.document_id
  WHERE 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Trigger for documents updated_at
DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Create storage bucket for documents (this will be created via Supabase Storage API)
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;