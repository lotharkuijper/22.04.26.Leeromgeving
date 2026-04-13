/*
  # Create Hierarchical Folder Structure

  1. New Structure
    - Root folder: "Bestandenomgeving" (File Environment)
      - Main folder: "Basiscursus" (Basic Course)
        - Subfolder: "RAG" (Documents for chatbot AI)
        - Subfolder: "Data" (Datasets and data files)
        - Subfolder: "Rollen" (Role definitions)
        - Subfolder: "Overige" (Miscellaneous)

  2. Tables Modified
    - document_folders: Add is_root flag and folder_type
    - Creates initial folder hierarchy
    - Sets up permissions for all folders

  3. Security
    - All folders have RLS enabled
    - Permissions are set for admin, docent roles
    - Students can view but not edit
    - Superuser has automatic access to all folders

  4. Folder Types
    - root: Top-level "Bestandenomgeving"
    - course: Course folders like "Basiscursus"
    - rag_sources: RAG document folder
    - data: Data and dataset folder
    - roles: Role definition folder
    - general: General/miscellaneous folder
*/

-- Step 1: Add folder_type column to document_folders if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_folders' AND column_name = 'folder_type'
  ) THEN
    ALTER TABLE document_folders ADD COLUMN folder_type text DEFAULT 'general';
  END IF;
END $$;

-- Step 2: Add is_root column to document_folders if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_folders' AND column_name = 'is_root'
  ) THEN
    ALTER TABLE document_folders ADD COLUMN is_root boolean DEFAULT false;
  END IF;
END $$;

-- Step 3: Create root folder "Bestandenomgeving"
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
VALUES (
  'Bestandenomgeving',
  'Root directory voor alle cursus documenten',
  NULL,
  'root',
  true,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
)
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 4: Create main course folder "Basiscursus" under root
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
SELECT
  'Basiscursus',
  'Basisopleiding voor nieuwe gebruikers',
  df.id,
  'course',
  false,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
FROM document_folders df
WHERE df.name = 'Bestandenomgeving' AND df.is_root = true
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 5: Create RAG subfolder under Basiscursus
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
SELECT
  'RAG',
  'Documenten in deze folder worden gebruikt door alle chatbots voor RAG (Retrieval Augmented Generation)',
  df.id,
  'rag_sources',
  false,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
FROM document_folders df
WHERE df.name = 'Basiscursus' AND df.folder_type = 'course'
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 6: Create Data subfolder under Basiscursus
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
SELECT
  'Data',
  'Datasets en databestanden voor analyse en onderzoek',
  df.id,
  'data',
  false,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
FROM document_folders df
WHERE df.name = 'Basiscursus' AND df.folder_type = 'course'
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 7: Create Rollen subfolder under Basiscursus
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
SELECT
  'Rollen',
  'Rol definities en permissie configuraties',
  df.id,
  'roles',
  false,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
FROM document_folders df
WHERE df.name = 'Basiscursus' AND df.folder_type = 'course'
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 8: Create Overige subfolder under Basiscursus
INSERT INTO document_folders (name, description, parent_folder_id, folder_type, is_root, created_by)
SELECT
  'Overige',
  'Algemene documenten die niet in andere folders passen',
  df.id,
  'general',
  false,
  (SELECT id FROM profiles WHERE role = 'admin' LIMIT 1)
FROM document_folders df
WHERE df.name = 'Basiscursus' AND df.folder_type = 'course'
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Step 9: Set up folder permissions for all folders (admin and docent can edit, student can view)
INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
SELECT 
  df.id,
  'admin',
  true,
  true
FROM document_folders df
ON CONFLICT (folder_id, role) DO UPDATE
SET can_view = true, can_edit = true;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
SELECT 
  df.id,
  'docent',
  true,
  true
FROM document_folders df
ON CONFLICT (folder_id, role) DO UPDATE
SET can_view = true, can_edit = true;

INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
SELECT 
  df.id,
  'student',
  true,
  false
FROM document_folders df
ON CONFLICT (folder_id, role) DO UPDATE
SET can_view = true, can_edit = false;

-- Step 10: Create RAG assignment for the RAG folder to all chat modules
-- Note: module_type uses different names than previously - checking existing schema
INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
SELECT
  df.id,
  'general',
  true
FROM document_folders df
WHERE df.name = 'RAG' AND df.folder_type = 'rag_sources'
ON CONFLICT (folder_id, module_type) DO UPDATE
SET is_active = true;

INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
SELECT
  df.id,
  'explain',
  true
FROM document_folders df
WHERE df.name = 'RAG' AND df.folder_type = 'rag_sources'
ON CONFLICT (folder_id, module_type) DO UPDATE
SET is_active = true;

INSERT INTO folder_rag_assignments (folder_id, module_type, is_active)
SELECT
  df.id,
  'quiz',
  true
FROM document_folders df
WHERE df.name = 'RAG' AND df.folder_type = 'rag_sources'
ON CONFLICT (folder_id, module_type) DO UPDATE
SET is_active = true;
