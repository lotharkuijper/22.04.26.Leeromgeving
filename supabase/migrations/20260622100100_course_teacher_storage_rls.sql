-- Task #334: storage-RLS per cursus voor docenten.
--
-- De rag_sources/datasets/docs_general buckets gaten upload/delete nog op de
-- afgeschafte globale 'docent'-rol, waardoor docenten een RLS-fout krijgen bij
-- het uploaden van RAG-documenten. We scopen op cursus via het eerste
-- padsegment (= folder-id) → course_folder_assignments (helper
-- storage_path_course). Lezen blijft open voor ingelogde gebruikers
-- (cursusmateriaal). Admin mag alles.

BEGIN;

-- rag_sources -----------------------------------------------------------------
DROP POLICY IF EXISTS "Docents and admins can upload to rag_sources" ON storage.objects;
CREATE POLICY "rag_sources_upload_admin_or_course_teacher"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'rag_sources'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

DROP POLICY IF EXISTS "Docents and admins can delete from rag_sources" ON storage.objects;
CREATE POLICY "rag_sources_delete_admin_or_course_teacher"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'rag_sources'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

-- datasets --------------------------------------------------------------------
DROP POLICY IF EXISTS "Docents and admins can upload to datasets" ON storage.objects;
CREATE POLICY "datasets_upload_admin_or_course_teacher"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'datasets'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

DROP POLICY IF EXISTS "Docents and admins can delete from datasets" ON storage.objects;
CREATE POLICY "datasets_delete_admin_or_course_teacher"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'datasets'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

-- docs_general ----------------------------------------------------------------
DROP POLICY IF EXISTS "Docents and admins can upload to docs_general" ON storage.objects;
CREATE POLICY "docs_general_upload_admin_or_course_teacher"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'docs_general'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

DROP POLICY IF EXISTS "Docents and admins can delete from docs_general" ON storage.objects;
CREATE POLICY "docs_general_delete_admin_or_course_teacher"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'docs_general'
    AND ( is_admin() OR is_course_teacher(auth.uid(), storage_path_course(name)) )
  );

COMMIT;
