-- Task #79 hardening: documenten zijn group-scoped (anders zien parallelle
-- groepen binnen hetzelfde project elkaars uploads in de persona-chat).
-- Bestaande rijen krijgen geen group_id; persona-chat skipt rijen zonder
-- group_id voor groep-specifieke context.

ALTER TABLE project_persona_documents
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ppd_group_persona_idx
  ON project_persona_documents(group_id, persona_id);

-- RLS: groepsleden mogen documenten van hún eigen groep zien; staff alles.
DROP POLICY IF EXISTS ppd_select ON project_persona_documents;
CREATE POLICY ppd_select ON project_persona_documents
  FOR SELECT TO authenticated
  USING (
    (
      project_persona_documents.group_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM project_group_members pgm
        WHERE pgm.group_id = project_persona_documents.group_id
          AND pgm.user_id = auth.uid()
      )
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (p.role IN ('admin', 'docent') OR p.email = 'l.d.j.kuijper@vu.nl')
    )
  );

-- Voorkom dubbele project_personas-kopieën van dezelfde course-persona.
CREATE UNIQUE INDEX IF NOT EXISTS project_personas_unique_source_idx
  ON project_personas(project_id, source_persona_id)
  WHERE source_persona_id IS NOT NULL;
