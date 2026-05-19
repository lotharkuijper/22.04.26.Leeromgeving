-- Task #156: Studenten leveren projectproduct in via een Uploads-map per cursus
-- (naast RAG en Projectdata) + project_submissions-tabel voor de werkelijke
-- inleveringen. Per project één toggle (projects.submissions_enabled).
--
-- Architectuur:
--   - Uploads-map (folder_type='uploads', bucket_type='docs_general') hangt
--     onder elke cursus-folder. Studenten kunnen er zelf in bekijken; alleen
--     staff mag erin uploaden via de gewone document-flow (we voorkomen
--     daarmee dat een 'uploads' map zomaar de studenten-inleveringen overlapt).
--     De inleveringen zelf staan in project_submissions, niet in documents,
--     omdat ze altijd gebonden zijn aan een (project, groep).
--   - project_submissions: één rij per inlevering. Vervangen = nieuwe rij +
--     oudere rijen voor (project_id, group_id) verwijderen in dezelfde
--     transactie. Geen UNIQUE constraint zodat we later versie-historie
--     kunnen bewaren als de eisen veranderen.
--   - projects.submissions_enabled: per project aan/uit. Default false.
--     projects.submissions_deadline: gereserveerd voor toekomstige UI.

BEGIN;

-- 1) Projects: toggle + gereserveerde deadline.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS submissions_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS submissions_deadline timestamptz NULL;

-- 2) project_submissions: binaire inleveringen.
CREATE TABLE IF NOT EXISTS project_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text,
  file_bytes bytea,
  byte_size bigint DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_submissions_project_group_idx
  ON project_submissions(project_id, group_id, created_at DESC);

-- 3) RLS.
ALTER TABLE project_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_submissions_select ON project_submissions;
CREATE POLICY project_submissions_select ON project_submissions FOR SELECT
  TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent')
    OR pr_is_group_member(group_id)
  );

-- INSERT door eigen groepslid; server (service role) bypassed RLS bij staff-uploads.
DROP POLICY IF EXISTS project_submissions_insert ON project_submissions;
CREATE POLICY project_submissions_insert ON project_submissions FOR INSERT
  TO authenticated
  WITH CHECK (pr_is_group_member(group_id) AND uploaded_by = auth.uid());

-- DELETE alleen staff. Studenten 'vervangen' via de server-endpoint die
-- service-role gebruikt om oudere rijen op te ruimen.
DROP POLICY IF EXISTS project_submissions_delete ON project_submissions;
CREATE POLICY project_submissions_delete ON project_submissions FOR DELETE
  TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent')
  );

-- 4) Backfill: maak een 'Uploads'-submap aan onder elke bestaande cursusmap
--    die er nog geen heeft, en koppel die aan de cursus.
DO $$
DECLARE
  rec RECORD;
  v_uploads_id uuid;
  v_course_id  uuid;
BEGIN
  FOR rec IN
    SELECT df.id AS course_folder_id, df.name AS course_folder_name
      FROM document_folders df
     WHERE df.folder_type = 'course'
       AND df.is_root = false
  LOOP
    -- Reeds een Uploads-submap?
    SELECT id INTO v_uploads_id
      FROM document_folders
     WHERE parent_folder_id = rec.course_folder_id
       AND folder_type = 'uploads'
     LIMIT 1;

    IF v_uploads_id IS NULL THEN
      INSERT INTO document_folders
        (name, description, parent_folder_id, folder_type, bucket_type, is_root)
      VALUES
        ('Uploads',
         format('Inleveringen voor %s', rec.course_folder_name),
         rec.course_folder_id,
         'uploads',
         'docs_general',
         false)
      RETURNING id INTO v_uploads_id;

      INSERT INTO folder_permissions (folder_id, role, can_view, can_edit)
      VALUES
        (v_uploads_id, 'admin',   true, true),
        (v_uploads_id, 'docent',  true, true),
        (v_uploads_id, 'student', true, false)
      ON CONFLICT DO NOTHING;
    END IF;

    -- Koppel aan de bijbehorende cursus (zoek via bestaande RAG-koppeling).
    SELECT cfa.course_id INTO v_course_id
      FROM course_folder_assignments cfa
      JOIN document_folders df ON df.id = cfa.folder_id
     WHERE df.parent_folder_id = rec.course_folder_id
       AND df.folder_type = 'rag_sources'
     LIMIT 1;

    IF v_course_id IS NOT NULL THEN
      INSERT INTO course_folder_assignments (course_id, folder_id)
      VALUES (v_course_id, v_uploads_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;
