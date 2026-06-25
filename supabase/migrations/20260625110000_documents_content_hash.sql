-- Task #391: documents.content_hash maakt de website-import idempotent als
-- goedkope top-up. Bij her-import van een grote site (bijvoorbeeld nadat een
-- eerdere import door Azure-snelheidslimieten (HTTP 429) werd afgekapt) slaat de
-- server pagina's met ongewijzigde inhoud over in plaats van ze opnieuw te
-- embedden. De hash is een SHA-256 over de geschoonde paginatekst.
--
-- Defensief: de server detecteert deze kolom bij startup (detectDocumentsContentHash)
-- en valt zonder de kolom terug op het oude gedrag (altijd opnieuw embedden), zodat
-- een nog niet gemigreerde database blijft werken.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text;

-- Versnelt de idempotentie-lookup per web-bron binnen een RAG-map (folder + url).
CREATE INDEX IF NOT EXISTS documents_folder_path_idx
  ON documents (folder_id, file_path);
