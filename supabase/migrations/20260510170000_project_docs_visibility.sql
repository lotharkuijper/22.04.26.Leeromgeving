-- Zichtbaarheidscontrole per projectdocument.
-- Docent kan per bestand instellen of studenten het zien en kunnen downloaden.
-- Default true zodat bestaande documenten gewoon zichtbaar blijven.
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS is_visible_to_students boolean NOT NULL DEFAULT true;
