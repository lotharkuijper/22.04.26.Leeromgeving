/*
  # Cleanup Existing Folder Structure

  1. Purpose
    - Remove all existing document folders and related data
    - Clean storage buckets
    - Prepare for new hierarchical folder structure
    - This is a complete reset to start fresh

  2. Actions
    - Delete all document chunks (RAG embeddings)
    - Delete all documents from database
    - Delete folder RAG assignments
    - Delete folder permissions
    - Delete all folders
    - Reset sequences if needed

  3. Important Notes
    - This will remove ALL existing document data
    - Storage bucket files will remain but orphaned (cleanup edge function handles this)
    - After this migration, a new structure will be created
*/

-- Step 1: Delete all document chunks (contains embeddings)
DELETE FROM document_chunks;

-- Step 2: Delete all documents
DELETE FROM documents;

-- Step 3: Delete folder RAG assignments
DELETE FROM folder_rag_assignments;

-- Step 4: Delete folder permissions
DELETE FROM folder_permissions;

-- Step 5: Delete all folders (cascading will handle children)
DELETE FROM document_folders;

-- Step 6: Clean up storage bucket (we'll keep the bucket itself)
-- Note: Files in storage will be orphaned, but the cleanup edge function will handle them
-- We don't delete the bucket itself as it's needed for the new structure
