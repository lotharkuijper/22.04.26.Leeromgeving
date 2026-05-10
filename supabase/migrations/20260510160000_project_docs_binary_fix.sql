-- ============================================================
-- 1) Fix infinite RLS-recursie: document_folders ↔ folder_permissions
--    verwijzen naar elkaar in hun SELECT-policies.
--    Oplossing: vereenvoudig folder_permissions SELECT policy
--    zodat hij niet meer door document_folders hoeft te lopen.
-- ============================================================
DROP POLICY IF EXISTS "Users can view permissions for their accessible folders" ON folder_permissions;
CREATE POLICY "Users can view permissions for their accessible folders"
  ON folder_permissions FOR SELECT TO authenticated
  USING (
    -- Admins/docenten zien alle rechten; studenten zien rechten van
    -- folders die ze mogen bekijken (alleen de rol-check, geen join
    -- terug naar document_folders om de recursie te doorbreken).
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND (profiles.role IN ('admin', 'docent')
             OR folder_permissions.role = profiles.role)
    )
  );

-- ============================================================
-- 2) Voeg file_bytes en mime_type toe aan documents-tabel.
--    file_path krijgt een default lege string zodat we binaire
--    bestanden kunnen invoegen zonder nep storage-paden.
-- ============================================================
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_bytes bytea,
  ADD COLUMN IF NOT EXISTS mime_type  text;

ALTER TABLE documents
  ALTER COLUMN file_path SET DEFAULT '';

-- ============================================================
-- 3) document_ref_id in project_documents: koppelt binaire
--    project-uploads aan hun rij in de documents-tabel.
-- ============================================================
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS document_ref_id uuid REFERENCES documents(id) ON DELETE SET NULL;
