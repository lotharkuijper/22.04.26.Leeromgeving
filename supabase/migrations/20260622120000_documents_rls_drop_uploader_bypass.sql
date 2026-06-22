-- Task #334 — verscherp documents/document_chunks-RLS: verwijder de
-- `uploaded_by = auth.uid()`-omzeiling.
--
-- De vorige migratie (20260622100000) liet de oorspronkelijke uploader een
-- document blijven UPDATEN/VERWIJDEREN, óók nadat die persoon zijn docentrol
-- voor de betreffende cursus had verloren. Dat doorbreekt de strikte
-- per-cursus-afbakening ("admin OF docent van DÉZE cursus"): een gedegradeerde
-- (oud-)docent mag niets meer in de cursus kunnen schrijven.
--
-- Na deze migratie geldt voor schrijven uitsluitend: admin OF actuele docent van
-- de cursus waaraan de map van het document is gekoppeld. Uploaden zelf (INSERT)
-- was al correct afgebakend en blijft ongewijzigd.

-- ── documents UPDATE/DELETE ────────────────────────────────────────────────
DROP POLICY IF EXISTS "documents_update_admin_or_course_teacher" ON documents;
CREATE POLICY "documents_update_admin_or_course_teacher" ON documents
  FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  )
  WITH CHECK (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

DROP POLICY IF EXISTS "documents_delete_admin_or_course_teacher" ON documents;
CREATE POLICY "documents_delete_admin_or_course_teacher" ON documents
  FOR DELETE TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

-- ── document_chunks INSERT/DELETE (spiegelt de documents-afbakening) ────────
DROP POLICY IF EXISTS "document_chunks_insert_admin_or_course_teacher" ON document_chunks;
CREATE POLICY "document_chunks_insert_admin_or_course_teacher" ON document_chunks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_chunks.document_id
         AND (
           is_admin()
           OR is_course_teacher(auth.uid(), folder_course_id(d.folder_id))
         )
    )
  );

DROP POLICY IF EXISTS "document_chunks_delete_admin_or_course_teacher" ON document_chunks;
CREATE POLICY "document_chunks_delete_admin_or_course_teacher" ON document_chunks
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_chunks.document_id
         AND (
           is_admin()
           OR is_course_teacher(auth.uid(), folder_course_id(d.folder_id))
         )
    )
  );
