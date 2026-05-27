-- Task #167 / Fase 2: persona-relaties met blijvende staat.
-- Per (project, groep, persona) één rij met `score` (-10..+10) en
-- `history` (jsonb-array van events). Wordt gevoed door Fase 1's
-- relationship_delta én door staff-correcties; geïnjecteerd in de
-- systeemprompt zodat persona's hun toon aanpassen.

BEGIN;

CREATE TABLE IF NOT EXISTS project_persona_relationships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id)         ON DELETE CASCADE,
  group_id    uuid NOT NULL REFERENCES project_groups(id)   ON DELETE CASCADE,
  persona_id  uuid NOT NULL REFERENCES project_personas(id) ON DELETE CASCADE,
  score       integer NOT NULL DEFAULT 0
                CHECK (score BETWEEN -10 AND 10),
  history     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ppr_project_group_persona
  ON project_persona_relationships (project_id, group_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_ppr_group   ON project_persona_relationships (group_id);
CREATE INDEX IF NOT EXISTS idx_ppr_persona ON project_persona_relationships (persona_id);

ALTER TABLE project_persona_relationships ENABLE ROW LEVEL SECURITY;

-- Lezen: groepsleden + staff van de cursus van het project (zelfde pattern
-- als project_document_reviews uit Fase 1).
DROP POLICY IF EXISTS ppr_select ON project_persona_relationships;
CREATE POLICY ppr_select ON project_persona_relationships
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm
       WHERE pgm.group_id = project_persona_relationships.group_id
         AND pgm.user_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups pg
        JOIN projects p ON p.id = pg.project_id
        LEFT JOIN course_members cm
               ON cm.course_id = p.course_id AND cm.user_id = auth.uid()
        LEFT JOIN profiles pr ON pr.id = auth.uid()
       WHERE pg.id = project_persona_relationships.group_id
         AND (
              pr.role = 'admin'
           OR pr.email = 'l.d.j.kuijper@vu.nl'
           OR cm.member_role = 'teacher'
         )
    )
  );

-- Schrijven uitsluitend via service role (server endpoints).

COMMIT;
