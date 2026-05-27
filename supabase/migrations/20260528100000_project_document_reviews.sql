-- Task #166 / Fase 1: project_document_reviews als first-class concept.
-- Per (project_document × evaluator-persona × group) schrijven we het oordeel
-- van de persona over een geüpload student-document op: aanvaard / onder
-- voorwaarden / afgewezen + motivatie + (optioneel) relationship_delta dat
-- Fase 2 later kan oppakken zonder backfill.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_document_verdict') THEN
    CREATE TYPE project_document_verdict AS ENUM ('accepted', 'conditional', 'rejected');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS project_document_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
  persona_id          uuid NOT NULL REFERENCES project_personas(id) ON DELETE CASCADE,
  group_id            uuid NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE,
  verdict             project_document_verdict NOT NULL,
  reasoning           text NOT NULL,
  relationship_delta  integer NOT NULL DEFAULT 0
                       CHECK (relationship_delta BETWEEN -5 AND 5),
  requested_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  raw_llm_response    jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdr_doc        ON project_document_reviews (document_id);
CREATE INDEX IF NOT EXISTS idx_pdr_doc_group  ON project_document_reviews (document_id, group_id);
CREATE INDEX IF NOT EXISTS idx_pdr_group      ON project_document_reviews (group_id);
CREATE INDEX IF NOT EXISTS idx_pdr_persona    ON project_document_reviews (persona_id);

ALTER TABLE project_document_reviews ENABLE ROW LEVEL SECURITY;

-- Lezen: groepsleden + staff van de cursus van het project.
DROP POLICY IF EXISTS pdr_select ON project_document_reviews;
CREATE POLICY pdr_select ON project_document_reviews
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm
       WHERE pgm.group_id = project_document_reviews.group_id
         AND pgm.user_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups pg
        JOIN projects p ON p.id = pg.project_id
        LEFT JOIN course_members cm
               ON cm.course_id = p.course_id AND cm.user_id = auth.uid()
        LEFT JOIN profiles pr ON pr.id = auth.uid()
       WHERE pg.id = project_document_reviews.group_id
         AND (
              pr.role = 'admin'
           OR pr.email = 'l.d.j.kuijper@vu.nl'
           OR cm.member_role = 'teacher'
         )
    )
  );

-- Schrijven enkel via service role (server endpoint). Geen INSERT/UPDATE/DELETE
-- policies voor authenticated users: de service role omzeilt RLS toch.

COMMIT;
