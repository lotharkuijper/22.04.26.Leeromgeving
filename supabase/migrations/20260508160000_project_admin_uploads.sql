-- Task #79: Project-beheer + chatbot-uploads
-- Voegt 'goals' en 'min_group_size' toe aan projects en maakt een tabel
-- voor persona-uploads (tekstdocumenten die de chatbot binnen een project
-- meekrijgt als context). Niets-breaking; alle kolommen IF NOT EXISTS.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS goals text,
  ADD COLUMN IF NOT EXISTS min_group_size integer DEFAULT 1;

-- Documenten per project-persona (alleen tekst — pdf/docx ondersteuning komt
-- later via een aparte parser). Beschikbaar voor de persona-chat als
-- aanvullende context naast RAG-cursusmateriaal.
CREATE TABLE IF NOT EXISTS project_persona_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  persona_id uuid REFERENCES project_personas(id) ON DELETE CASCADE NOT NULL,
  filename text NOT NULL,
  content_text text NOT NULL,
  byte_size integer,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS ppd_project_persona_idx
  ON project_persona_documents(project_id, persona_id);
CREATE INDEX IF NOT EXISTS ppd_uploaded_by_idx
  ON project_persona_documents(uploaded_by);

ALTER TABLE project_persona_documents ENABLE ROW LEVEL SECURITY;

-- Lees-toegang: project-leden (via project_groups + members) en staff.
DROP POLICY IF EXISTS ppd_select ON project_persona_documents;
CREATE POLICY ppd_select ON project_persona_documents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm
      JOIN project_groups pg ON pg.id = pgm.group_id
      WHERE pg.project_id = project_persona_documents.project_id
        AND pgm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (p.role IN ('admin', 'docent') OR p.email = 'l.d.j.kuijper@vu.nl')
    )
  );

-- Schrijven loopt via de server (service-role); RLS-insert/update blijft dicht.
DROP POLICY IF EXISTS ppd_modify ON project_persona_documents;
CREATE POLICY ppd_modify ON project_persona_documents
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
