/*
  # Voeg Superuser toe aan Folder Permissions
  
  1. Wijzigingen
    - Update folder_permissions_role_check constraint om 'superuser' toe te staan
    - Dit is nodig zodat superusers ook folder permissions kunnen krijgen
  
  Noten:
    - Superusers hebben nu expliciete folder permissions nodig
*/

-- Drop the old constraint
ALTER TABLE folder_permissions DROP CONSTRAINT IF EXISTS folder_permissions_role_check;

-- Add new constraint that includes superuser
ALTER TABLE folder_permissions ADD CONSTRAINT folder_permissions_role_check 
  CHECK (role IN ('student', 'docent', 'admin', 'superuser'));