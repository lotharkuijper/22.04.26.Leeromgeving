/*
  # Nieuwe Flat Folder Structuur
  
  1. Nieuwe Folders
    - `RAG` folder zonder parent (parent_folder_id = NULL)
      - Gebruikt voor RAG documenten die door alle chatbots worden gebruikt
      - bucket_type: 'rag_sources'
      - Embeddings worden automatisch gegenereerd
    
    - `Overig` folder zonder parent (parent_folder_id = NULL)
      - Gebruikt voor algemene documenten
      - bucket_type: 'docs_general'
      - Geen embeddings
    
    - `Data` folder zonder parent (parent_folder_id = NULL)
      - Gebruikt voor datasets en data bestanden
      - bucket_type: 'datasets'
      - Geen embeddings
  
  2. Permissions
    - Student: kan alle folders bekijken (can_view=true)
    - Docent: kan alles bekijken en bewerken (can_view=true, can_edit=true)
    - Admin: kan alles bekijken en bewerken (can_view=true, can_edit=true)
    - Superuser: kan alles bekijken en bewerken (can_view=true, can_edit=true)
  
  3. RAG Assignments
    - RAG folder is gekoppeld aan 'general' en 'explain' modules
    - Documenten in deze folder worden gebruikt door alle chatbots
  
  4. Beschrijvingen
    - Elke folder heeft een duidelijke Nederlandse beschrijving
*/

-- Insert RAG folder
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'RAG',
  'Documenten in deze folder worden gebruikt door alle chatbots voor contextrijke antwoorden. Embeddings worden automatisch gegenereerd.',
  NULL,
  'rag_sources',
  now(),
  now()
) ON CONFLICT DO NOTHING;

-- Insert Overig folder
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'Overig',
  'Algemene documenten die niet door de chatbots worden gebruikt.',
  NULL,
  'docs_general',
  now(),
  now()
) ON CONFLICT DO NOTHING;

-- Insert Data folder
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'Data',
  'Datasets en databestanden voor analyse en onderzoek.',
  NULL,
  'datasets',
  now(),
  now()
) ON CONFLICT DO NOTHING;

-- Create permissions for RAG folder
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'student',
  true,
  false,
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'docent',
  true,
  true,
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'admin',
  true,
  true,
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'superuser',
  true,
  true,
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;

-- Create permissions for Overig folder
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'student',
  true,
  false,
  now()
FROM document_folders WHERE name = 'Overig' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'docent',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Overig' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'admin',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Overig' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'superuser',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Overig' AND parent_folder_id IS NULL;

-- Create permissions for Data folder
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'student',
  true,
  false,
  now()
FROM document_folders WHERE name = 'Data' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'docent',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Data' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'admin',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Data' AND parent_folder_id IS NULL;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
SELECT 
  id,
  'superuser',
  true,
  true,
  now()
FROM document_folders WHERE name = 'Data' AND parent_folder_id IS NULL;

-- Create RAG assignments for RAG folder
INSERT INTO folder_rag_assignments (folder_id, module_type, is_active, created_at, updated_at)
SELECT 
  id,
  'general',
  true,
  now(),
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;

INSERT INTO folder_rag_assignments (folder_id, module_type, is_active, created_at, updated_at)
SELECT 
  id,
  'explain',
  true,
  now(),
  now()
FROM document_folders WHERE name = 'RAG' AND parent_folder_id IS NULL;