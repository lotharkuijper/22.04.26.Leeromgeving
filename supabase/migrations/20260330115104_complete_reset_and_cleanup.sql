/*
  # Complete Database Reset en Cleanup
  
  1. Cleanup Acties
    - Verwijder alle document chunks uit document_chunks tabel
    - Verwijder alle documenten uit documents tabel
    - Verwijder alle folder RAG assignments uit folder_rag_assignments tabel
    - Verwijder alle folder permissions uit folder_permissions tabel
    - Verwijder alle document folders uit document_folders tabel
  
  2. Voorbereiding
    - Maak database schoon voor nieuwe folderstructuur
    - Verwijder alle orphaned data
  
  Noten:
    - Dit is een destructieve operatie
    - Alle bestaande documenten en folders worden verwijderd
    - Storage bestanden moeten apart worden verwijderd
*/

-- Disable RLS temporarily for cleanup
ALTER TABLE document_chunks DISABLE ROW LEVEL SECURITY;
ALTER TABLE documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE folder_rag_assignments DISABLE ROW LEVEL SECURITY;
ALTER TABLE folder_permissions DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_folders DISABLE ROW LEVEL SECURITY;

-- Delete all data in correct order (respecting foreign keys)
DELETE FROM document_chunks;
DELETE FROM folder_rag_assignments;
DELETE FROM documents;
DELETE FROM folder_permissions;
DELETE FROM document_folders;

-- Re-enable RLS
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_rag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;