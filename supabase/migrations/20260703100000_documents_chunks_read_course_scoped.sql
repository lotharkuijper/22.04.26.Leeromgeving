-- Task #412 (security-fix 3): schaf de over-permissieve leestoegang op
-- documents/document_chunks af.
--
-- De oorspronkelijke policies (20260324120601) lieten ELKE ingelogde gebruiker
-- ALLE documenten én chunks lezen (USING true). Daardoor kon een student van
-- cursus A het volledige RAG-bronmateriaal van cursus B (of van een verborgen/
-- gearchiveerde cursus) uitlezen — direct via de tabel of via de client-side
-- RPC match_document_chunks (die SECURITY INVOKER is en dus de RLS van de
-- aanroeper volgt).
--
-- Nieuw model (spiegelt het visibility-gebaseerde content-toegangsmodel,
-- canAccessCourseContent): een gebruiker mag een document/chunk lezen als
--   * admin/superuser (is_admin()), OF
--   * docent van de cursus waaraan de map van het document is gekoppeld
--     (is_course_teacher), OF
--   * de cursus openbaar is voor studenten: actief én student_visible
--     (course_content_is_public).
-- Documenten in een map die aan geen enkele cursus is gekoppeld
-- (folder_course_id = NULL) zijn hierna alleen voor admins leesbaar
-- (fail-closed). Docenten/admins beheren bronmateriaal sowieso via de
-- server-endpoints met service-role (RLS-bypass), dus dat pad blijft werken.

BEGIN;

-- Helper: is de cursus openbaar voor studenten (actief én zichtbaar)?
-- SECURITY DEFINER zodat de check onafhankelijk is van de courses-RLS van de
-- aanroeper (geen recursie, expliciete bedoeling). NULL-cursus → false.
CREATE OR REPLACE FUNCTION course_content_is_public(p_course uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM courses c
     WHERE c.id = p_course
       AND c.is_active = true
       AND c.student_visible = true
  );
$$;

-- ── documents SELECT ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "All authenticated users can read documents" ON documents;
CREATE POLICY "documents_read_staff_or_public_course" ON documents
  FOR SELECT TO authenticated
  USING (
    is_admin()
    OR is_course_teacher(auth.uid(), folder_course_id(folder_id))
    OR course_content_is_public(folder_course_id(folder_id))
  );

-- ── document_chunks SELECT (spiegelt de documents-afbakening) ────────────────
DROP POLICY IF EXISTS "All authenticated users can read chunks" ON document_chunks;
CREATE POLICY "document_chunks_read_staff_or_public_course" ON document_chunks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
       WHERE d.id = document_chunks.document_id
         AND (
           is_admin()
           OR is_course_teacher(auth.uid(), folder_course_id(d.folder_id))
           OR course_content_is_public(folder_course_id(d.folder_id))
         )
    )
  );

COMMIT;
