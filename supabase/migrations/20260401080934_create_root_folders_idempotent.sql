/*
  # Create Root Document Folders

  1. Root Folders Created
    - **RAG** folder (parent_folder_id = NULL)
      - Description: Documents used by all chatbots for context-rich responses
      - bucket_type: 'rag_sources'
      - Automatically generates embeddings
    
    - **Overig** folder (parent_folder_id = NULL)
      - Description: General documents not used by chatbots
      - bucket_type: 'docs_general'
      - No embeddings
    
    - **Data** folder (parent_folder_id = NULL)
      - Description: Datasets and data files for analysis
      - bucket_type: 'datasets'
      - No embeddings
  
  2. Permissions Configuration
    Each folder has role-based permissions:
    - **Student**: View only (can_view=true, can_edit=false)
    - **Docent**: View and edit (can_view=true, can_edit=true)
    - **Admin**: View and edit (can_view=true, can_edit=true)
    - **Superuser**: View and edit (can_view=true, can_edit=true)
  
  3. RAG Module Assignments
    - RAG folder is assigned to 'general' and 'explain' modules
    - Documents in this folder are used by all chatbots
  
  4. Idempotency
    - Uses ON CONFLICT to prevent duplicate inserts
    - Safe to run multiple times without creating duplicates
    - Relies on unique constraint: document_folders_parent_folder_id_name_key

  Important Notes:
  - All inserts use ON CONFLICT DO NOTHING to ensure idempotency
  - Permissions and RAG assignments only created if folders exist
  - No data loss on reruns
*/

-- Insert RAG folder (idempotent)
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'RAG',
  'Documenten in deze folder worden gebruikt door alle chatbots voor contextrijke antwoorden. Embeddings worden automatisch gegenereerd.',
  NULL,
  'rag_sources',
  now(),
  now()
)
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Insert Overig folder (idempotent)
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'Overig',
  'Algemene documenten die niet door de chatbots worden gebruikt.',
  NULL,
  'docs_general',
  now(),
  now()
)
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Insert Data folder (idempotent)
INSERT INTO document_folders (name, description, parent_folder_id, bucket_type, created_at, updated_at)
VALUES (
  'Data',
  'Datasets en databestanden voor analyse en onderzoek.',
  NULL,
  'datasets',
  now(),
  now()
)
ON CONFLICT (parent_folder_id, name) DO NOTHING;

-- Create permissions for all folders and all roles (idempotent)
-- Using DO block to check if permissions already exist before inserting

DO $$
DECLARE
  folder_record RECORD;
  role_name TEXT;
  can_edit_permission BOOLEAN;
BEGIN
  -- Loop through each root folder
  FOR folder_record IN 
    SELECT id, name FROM document_folders WHERE parent_folder_id IS NULL AND name IN ('RAG', 'Overig', 'Data')
  LOOP
    -- Loop through each role
    FOR role_name IN SELECT unnest(ARRAY['student', 'docent', 'admin', 'superuser'])
    LOOP
      -- Determine can_edit permission based on role
      can_edit_permission := (role_name != 'student');
      
      -- Insert permission if it doesn't exist
      IF NOT EXISTS (
        SELECT 1 FROM folder_permissions 
        WHERE folder_id = folder_record.id AND role = role_name
      ) THEN
        INSERT INTO folder_permissions (folder_id, role, can_view, can_edit, created_at)
        VALUES (folder_record.id, role_name, true, can_edit_permission, now());
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Create RAG assignments for RAG folder (idempotent)
DO $$
DECLARE
  rag_folder_id UUID;
  module_name TEXT;
BEGIN
  -- Get RAG folder ID
  SELECT id INTO rag_folder_id 
  FROM document_folders 
  WHERE name = 'RAG' AND parent_folder_id IS NULL
  LIMIT 1;
  
  -- Only proceed if RAG folder exists
  IF rag_folder_id IS NOT NULL THEN
    -- Loop through modules
    FOR module_name IN SELECT unnest(ARRAY['general', 'explain'])
    LOOP
      -- Insert RAG assignment if it doesn't exist
      IF NOT EXISTS (
        SELECT 1 FROM folder_rag_assignments 
        WHERE folder_id = rag_folder_id AND module_type = module_name
      ) THEN
        INSERT INTO folder_rag_assignments (folder_id, module_type, is_active, created_at, updated_at)
        VALUES (rag_folder_id, module_name, true, now(), now());
      END IF;
    END LOOP;
  END IF;
END $$;
