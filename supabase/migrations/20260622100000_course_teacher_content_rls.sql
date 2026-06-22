-- Task #334: Docent-rechten per cursus voor cursusinrichting.
--
-- De globale 'docent'-rol is afgeschaft (alle docenten staan op 'student';
-- lesgeven loopt per cursus via course_members.member_role='teacher'). Heel
-- veel content-RLS hangt nog op profiles.role IN ('docent','admin'), waardoor
-- docenten vastlopen (o.a. RAG-upload: "new row violates row-level security
-- policy"). We vervangen die checks consequent door "admin OF docent van DEZE
-- cursus", met de bestaande helper is_course_teacher als enige bron van waarheid.
--
-- Scoping-model:
--  * Tabellen met course_id  → is_course_teacher(auth.uid(), course_id).
--  * documents/folders/storage → cursus via course_folder_assignments
--    (folder_course_id / storage_path_course helpers).
--  * Echt globale tabellen zonder cursus-koppeling (concepts, datasets,
--    quiz_sets) → admin OF is_teacher_anywhere() (faithful herstel van het oude
--    "elke docent"-gedrag; er is geen cursus om op te scopen).
--  * quiz_questions blijft admin-only schrijven (gedeelde ItemBank-pool).

BEGIN;

-- ── Helpers ────────────────────────────────────────────────────────────────

-- Cursus van een map via de cursus-map-koppeling (NULL = niet gekoppeld).
CREATE OR REPLACE FUNCTION folder_course_id(p_folder uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT course_id
    FROM course_folder_assignments
   WHERE folder_id = p_folder
   LIMIT 1;
$$;

-- Cursus van een storage-object: eerste padsegment = folder-id (defensief cast).
CREATE OR REPLACE FUNCTION storage_path_course(p_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  seg text;
  fid uuid;
BEGIN
  seg := split_part(p_name, '/', 1);
  BEGIN
    fid := seg::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  RETURN (SELECT course_id FROM course_folder_assignments WHERE folder_id = fid LIMIT 1);
END;
$$;

-- Is de gebruiker docent in minstens één cursus? (Voor echt globale tabellen
-- zonder cursus-kolom: herstelt het oude "elke docent mag"-gedrag.)
CREATE OR REPLACE FUNCTION is_teacher_anywhere(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_members
     WHERE user_id = p_user AND member_role = 'teacher'
  );
$$;

-- ── documents ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Docenten and admin can insert documents" ON documents;
CREATE POLICY "documents_insert_admin_or_course_teacher" ON documents
  FOR INSERT TO authenticated
  WITH CHECK (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

DROP POLICY IF EXISTS "Docenten and admin can update their own documents" ON documents;
CREATE POLICY "documents_update_admin_or_course_teacher" ON documents
  FOR UPDATE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  )
  WITH CHECK (
    uploaded_by = auth.uid()
    OR is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

DROP POLICY IF EXISTS "Uploader or admin can delete documents" ON documents;
CREATE POLICY "documents_delete_admin_or_course_teacher" ON documents
  FOR DELETE TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

-- ── document_chunks (scope via parent document's folder course) ─────────────
DROP POLICY IF EXISTS "System can insert chunks" ON document_chunks;
CREATE POLICY "document_chunks_insert_admin_or_course_teacher" ON document_chunks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_chunks.document_id
         AND (
           d.uploaded_by = auth.uid()
           OR is_admin()
           OR is_course_teacher(auth.uid(), folder_course_id(d.folder_id))
         )
    )
  );

DROP POLICY IF EXISTS "System can delete chunks" ON document_chunks;
CREATE POLICY "document_chunks_delete_admin_or_course_teacher" ON document_chunks
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_chunks.document_id
         AND (
           d.uploaded_by = auth.uid()
           OR is_admin()
           OR is_course_teacher(auth.uid(), folder_course_id(d.folder_id))
         )
    )
  );

-- ── document_folders ───────────────────────────────────────────────────────
-- INSERT: een nieuwe map is nog niet aan een cursus gekoppeld, dus scope op
-- "admin of docent ergens". De cursus-koppeling (course_folder_assignments)
-- loopt via de server (service-role).
DROP POLICY IF EXISTS "Admins and docents can create folders" ON document_folders;
CREATE POLICY "document_folders_insert_admin_or_teacher" ON document_folders
  FOR INSERT TO authenticated
  WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );

DROP POLICY IF EXISTS "Admins and docents can update folders" ON document_folders;
CREATE POLICY "document_folders_update_admin_or_course_teacher" ON document_folders
  FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR created_by = auth.uid()
    OR is_course_teacher(auth.uid(), folder_course_id(id))
  )
  WITH CHECK (
    is_admin()
    OR created_by = auth.uid()
    OR is_course_teacher(auth.uid(), folder_course_id(id))
  );

DROP POLICY IF EXISTS "Admins can delete folders" ON document_folders;
CREATE POLICY "document_folders_delete_admin_or_course_teacher" ON document_folders
  FOR DELETE TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(id))
  );

-- ── folder_rag_assignments ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins can manage all RAG assignments" ON folder_rag_assignments;
CREATE POLICY "folder_rag_assignments_admin_or_course_teacher" ON folder_rag_assignments
  FOR ALL TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  )
  WITH CHECK (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
  );

-- ── concept_itembank_sections (course_id) ──────────────────────────────────
DROP POLICY IF EXISTS "concept_itembank_sections_admin_all" ON concept_itembank_sections;
CREATE POLICY "concept_itembank_sections_write_admin_or_course_teacher" ON concept_itembank_sections
  FOR ALL TO authenticated
  USING (
    is_admin() OR is_course_teacher(auth.uid(), concept_itembank_sections.course_id)
  )
  WITH CHECK (
    is_admin() OR is_course_teacher(auth.uid(), concept_itembank_sections.course_id)
  );

DROP POLICY IF EXISTS "concept_itembank_sections_read_admin_docent" ON concept_itembank_sections;
CREATE POLICY "concept_itembank_sections_read_admin_or_course_teacher" ON concept_itembank_sections
  FOR SELECT TO authenticated
  USING (
    is_admin() OR is_course_teacher(auth.uid(), concept_itembank_sections.course_id)
  );

-- ── concept_rag_sources (course_id) ────────────────────────────────────────
DROP POLICY IF EXISTS "concept_rag_sources_admin_all" ON concept_rag_sources;
CREATE POLICY "concept_rag_sources_write_admin_or_course_teacher" ON concept_rag_sources
  FOR ALL TO authenticated
  USING (
    is_admin() OR is_course_teacher(auth.uid(), concept_rag_sources.course_id)
  )
  WITH CHECK (
    is_admin() OR is_course_teacher(auth.uid(), concept_rag_sources.course_id)
  );

DROP POLICY IF EXISTS "concept_rag_sources_read_admin_docent" ON concept_rag_sources;
CREATE POLICY "concept_rag_sources_read_admin_or_course_teacher" ON concept_rag_sources
  FOR SELECT TO authenticated
  USING (
    is_admin() OR is_course_teacher(auth.uid(), concept_rag_sources.course_id)
  );

-- ── quiz_sources_mix (course_id) ───────────────────────────────────────────
DROP POLICY IF EXISTS "quiz_sources_mix_admin_all" ON quiz_sources_mix;
CREATE POLICY "quiz_sources_mix_write_admin_or_course_teacher" ON quiz_sources_mix
  FOR ALL TO authenticated
  USING (
    is_admin() OR is_course_teacher(auth.uid(), quiz_sources_mix.course_id)
  )
  WITH CHECK (
    is_admin() OR is_course_teacher(auth.uid(), quiz_sources_mix.course_id)
  );

-- Lezen: admin, docent van de cursus, of een lid van de cursus (de client-side
-- quiz-generator fallback gebruikt de mix).
DROP POLICY IF EXISTS "quiz_sources_mix_read_course_member" ON quiz_sources_mix;
CREATE POLICY "quiz_sources_mix_read_member_or_course_teacher" ON quiz_sources_mix
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), quiz_sources_mix.course_id)
    OR EXISTS (
      SELECT 1 FROM course_members cm
       WHERE cm.user_id = auth.uid() AND cm.course_id = quiz_sources_mix.course_id
    )
  );

-- ── concepts (GEEN course_id; globaal via key_points-marker) ────────────────
DROP POLICY IF EXISTS "Docenten and admin can manage concepts" ON concepts;
DROP POLICY IF EXISTS "Docents and admins can add concepts" ON concepts;
DROP POLICY IF EXISTS "Admins and docents can update concepts" ON concepts;

CREATE POLICY "concepts_insert_admin_or_teacher" ON concepts
  FOR INSERT TO authenticated
  WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );
CREATE POLICY "concepts_update_admin_or_teacher" ON concepts
  FOR UPDATE TO authenticated
  USING ( is_admin() OR is_teacher_anywhere(auth.uid()) )
  WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );
CREATE POLICY "concepts_delete_admin_or_teacher" ON concepts
  FOR DELETE TO authenticated
  USING ( is_admin() OR is_teacher_anywhere(auth.uid()) );

-- Lees-policy "Everyone can view approved concepts" hangt nog op docent-rol voor
-- de staf-tak; herschrijf zodat docenten ook niet-goedgekeurde begrippen zien.
DROP POLICY IF EXISTS "Everyone can view approved concepts" ON concepts;
CREATE POLICY "concepts_read_approved_or_staff" ON concepts
  FOR SELECT TO authenticated
  USING (
    review_status = 'approved'::concept_review_status
    OR is_admin()
    OR is_teacher_anywhere(auth.uid())
  );

-- ── datasets (GEEN course-koppeling in het schema; echt globaal) ────────────
DROP POLICY IF EXISTS "Docenten and admin can manage datasets" ON datasets;
CREATE POLICY "datasets_write_admin_or_teacher" ON datasets
  FOR ALL TO authenticated
  USING ( is_admin() OR is_teacher_anywhere(auth.uid()) )
  WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );

-- ── quiz_sets (GEEN course_id; globaal) ────────────────────────────────────
DROP POLICY IF EXISTS "Docenten and admin can manage quiz sets" ON quiz_sets;
CREATE POLICY "quiz_sets_write_admin_or_teacher" ON quiz_sets
  FOR ALL TO authenticated
  USING ( is_admin() OR is_teacher_anywhere(auth.uid()) )
  WITH CHECK ( is_admin() OR is_teacher_anywhere(auth.uid()) );

DROP POLICY IF EXISTS "Students can read public quiz sets" ON quiz_sets;
CREATE POLICY "quiz_sets_read_public_or_staff" ON quiz_sets
  FOR SELECT TO authenticated
  USING (
    is_public = true
    OR is_admin()
    OR is_teacher_anywhere(auth.uid())
  );

-- ── quiz_questions (gedeelde ItemBank; schrijven blijft admin-only) ─────────
-- Alleen de staf-leestak van de docent-rol losweken zodat docenten ook
-- niet-gevalideerde items kunnen zien. Schrijven blijft via "Admins can manage
-- questions" (ongewijzigd, admin-only).
DROP POLICY IF EXISTS "Students can read validated questions" ON quiz_questions;
CREATE POLICY "quiz_questions_read_validated_or_staff" ON quiz_questions
  FOR SELECT TO authenticated
  USING (
    validation_status = 'validated'
    OR is_admin()
    OR is_teacher_anywhere(auth.uid())
  );

COMMIT;
