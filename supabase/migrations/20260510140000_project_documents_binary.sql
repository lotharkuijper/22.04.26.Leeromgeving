-- Sta binaire bestanden toe (zoals Jamovi .omv) in project_documents.
-- Voor binaire bestanden is er geen content_text; studenten kunnen ze
-- alleen downloaden, niet als context in de chat krijgen.
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS file_bytes bytea;

-- content_text mag nu NULL zijn (binaire uploads hebben geen tekst).
ALTER TABLE project_documents ALTER COLUMN content_text DROP NOT NULL;
