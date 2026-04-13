/*
  # Fix Document Folders RLS Policies
  
  1. Changes
    - Drop existing problematic RLS policies on document_folders
    - Create simplified, efficient RLS policies
    - Avoid nested subqueries that cause 500 errors
    
  2. Security
    - Authenticated users can view folders they have permission for
    - Admins and docents can create folders
    - Admins and docents can update/delete folders
    - Students can only view folders (through folder_permissions)
*/

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage all folders" ON document_folders;
DROP POLICY IF EXISTS "Docents can create folders" ON document_folders;
DROP POLICY IF EXISTS "Users can view folders they have permission for" ON document_folders;

-- Create simple, direct SELECT policy
-- Users can view folders if they have permission through folder_permissions table
CREATE POLICY "Users can view permitted folders"
  ON document_folders
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 
      FROM folder_permissions fp
      JOIN profiles p ON p.id = auth.uid()
      WHERE fp.folder_id = document_folders.id
        AND fp.role = p.role
        AND fp.can_view = true
    )
  );

-- Admins and docents can insert folders
CREATE POLICY "Admins and docents can create folders"
  ON document_folders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 
      FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'docent')
    )
  );

-- Admins and docents can update folders
CREATE POLICY "Admins and docents can update folders"
  ON document_folders
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 
      FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'docent')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 
      FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'docent')
    )
  );

-- Admins can delete folders
CREATE POLICY "Admins can delete folders"
  ON document_folders
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 
      FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );
