-- Task: Cursus-info header op Dashboard.
-- Eén informatieblok per cursus: een stuk opgemaakte tekst (markdown) plus
-- gekoppelde, downloadbare bestanden. Studenten/docenten zien dit bovenaan
-- het Dashboard van de actieve cursus. Beheer biedt een tabblad "Cursus-info".

BEGIN;

-- Eén rij per cursus met de cursus-info-tekst (markdown).
CREATE TABLE IF NOT EXISTS course_info (
  course_id   uuid PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  updated_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Koppeltabel: verbindt cursus-info aan bestaande document-rijen, met
-- sorteervolgorde voor de weergave op het Dashboard.
CREATE TABLE IF NOT EXISTS course_info_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_course_info_documents_course ON course_info_documents (course_id);
CREATE INDEX IF NOT EXISTS idx_course_info_documents_document ON course_info_documents (document_id);

ALTER TABLE course_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_info_documents ENABLE ROW LEVEL SECURITY;

-- Lezen: cursusleden + staff (admin/superuser/teacher van de cursus).
-- Schrijven verloopt uitsluitend via de server (service-role omzeilt RLS);
-- er zijn daarom geen INSERT/UPDATE/DELETE policies voor authenticated users.
DROP POLICY IF EXISTS course_info_select ON course_info;
CREATE POLICY course_info_select ON course_info
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM course_members cm
       WHERE cm.course_id = course_info.course_id
         AND cm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles pr
       WHERE pr.id = auth.uid()
         AND (pr.role = 'admin' OR pr.email = 'l.d.j.kuijper@vu.nl')
    )
  );

DROP POLICY IF EXISTS course_info_documents_select ON course_info_documents;
CREATE POLICY course_info_documents_select ON course_info_documents
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM course_members cm
       WHERE cm.course_id = course_info_documents.course_id
         AND cm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles pr
       WHERE pr.id = auth.uid()
         AND (pr.role = 'admin' OR pr.email = 'l.d.j.kuijper@vu.nl')
    )
  );

COMMIT;
