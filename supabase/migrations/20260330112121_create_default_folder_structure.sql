/*
  # Create Default Folder Structure for RAG System

  ## Overview
  This migration creates the standard folder structure:
  - RAG folder: Documents used by chatbot in Chat and Explain modules
  - Overig folder: Miscellaneous documents (not used for RAG)
  - Data folder: Datasets and analysis files (not used for RAG)

  ## Changes
  1. Creates three root-level folders with appropriate bucket types
  2. Sets up permissions for all user roles
  3. Creates RAG assignments for the RAG folder

  ## Security
  - All users can view all folders
  - Only docent and admin can upload
*/

-- Create RAG folder
INSERT INTO document_folders (id, name, description, bucket_type, parent_folder_id, created_by)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
  'RAG',
  'Documenten die gebruikt worden door de chatbot voor beantwoording van vragen in Chat en Ik leg uit modules',
  'rag_sources',
  NULL,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
)
ON CONFLICT DO NOTHING;

-- Create Overig folder
INSERT INTO document_folders (id, name, description, bucket_type, parent_folder_id, created_by)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000002'::uuid,
  'Overig',
  'Algemene documenten zoals hoorcollege presentaties en extra materiaal',
  'docs_general',
  NULL,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
)
ON CONFLICT DO NOTHING;

-- Create Data folder
INSERT INTO document_folders (id, name, description, bucket_type, parent_folder_id, created_by)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000003'::uuid,
  'Data',
  'Datasets voor analyse: Excel, Jamovi, R en andere data bestanden',
  'datasets',
  NULL,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
)
ON CONFLICT DO NOTHING;

-- Set up permissions for RAG folder (all can view, docent/admin can edit)
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'student', true, false),
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'docent', true, true),
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'admin', true, true)
ON CONFLICT DO NOTHING;

-- Set up permissions for Overig folder
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'student', true, false),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'docent', true, true),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'admin', true, true)
ON CONFLICT DO NOTHING;

-- Set up permissions for Data folder
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'student', true, false),
  ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'docent', true, true),
  ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 'admin', true, true)
ON CONFLICT DO NOTHING;

-- Create RAG assignment for Chat module (general)
INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'general', true)
ON CONFLICT DO NOTHING;

-- Create RAG assignment for Explain module
INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'explain', true)
ON CONFLICT DO NOTHING;