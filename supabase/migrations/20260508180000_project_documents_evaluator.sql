-- Task #80: Projectdocumenten + verborgen rubrics + evaluator-persona's
-- 1. Tabel `project_documents` voor docent-uploads die voor het hele project
--    gelden (geen group/persona-binding). Studenten in elke groep van dat
--    project zien deze, en alle persona's krijgen de tekst als context.
-- 2. Kolom `persona_type` op `project_personas` ('conversational' | 'evaluator').
--    Evaluators verschijnen niet in de student-UI en accepteren geen
--    chat-berichten; ze worden alleen aangeroepen bij "Beoordeling opvragen".
-- 3. Kolom `is_hidden_rubric` op `project_persona_documents` voor
--    rubric-uploads die alleen door de bijbehorende evaluator-persona worden
--    gelezen en nooit aan studenten worden getoond.
-- 4. Eenmalige verhuizing: course_personas → project_personas voor het
--    project "Welzijn in Waterlandpleinbuurt" (idempotent), daarna die
--    course_personas verwijderen zodat de bibliotheek leeg start.

-- 1) project_documents
CREATE TABLE IF NOT EXISTS project_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  filename text NOT NULL,
  content_text text NOT NULL,
  byte_size integer,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS project_documents_project_idx
  ON project_documents(project_id, created_at DESC);

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;

-- Lees: project-leden (groepslid van een groep in dit project) of staff.
DROP POLICY IF EXISTS project_documents_select ON project_documents;
CREATE POLICY project_documents_select ON project_documents
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM project_group_members pgm
      JOIN project_groups pg ON pg.id = pgm.group_id
      WHERE pg.project_id = project_documents.project_id
        AND pgm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (p.role IN ('admin', 'docent') OR p.email = 'l.d.j.kuijper@vu.nl')
    )
  );

-- Schrijven loopt via service-role; RLS dicht voor authenticated.
DROP POLICY IF EXISTS project_documents_modify ON project_documents;
CREATE POLICY project_documents_modify ON project_documents
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- 2) persona_type
ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS persona_type text
    DEFAULT 'conversational'
    CHECK (persona_type IN ('conversational', 'evaluator'));

-- Bestaande course-bibliotheek krijgt ook een type-kolom — handig wanneer
-- een evaluator-persona uit een gekopieerde course-bibliotheek komt.
ALTER TABLE course_personas
  ADD COLUMN IF NOT EXISTS persona_type text
    DEFAULT 'conversational'
    CHECK (persona_type IN ('conversational', 'evaluator'));

-- 3) is_hidden_rubric op persona-documenten
ALTER TABLE project_persona_documents
  ADD COLUMN IF NOT EXISTS is_hidden_rubric boolean DEFAULT false;

-- RLS: studenten mogen verborgen rubric-rijen NIET zien. Staff wel.
DROP POLICY IF EXISTS ppd_select ON project_persona_documents;
CREATE POLICY ppd_select ON project_persona_documents
  FOR SELECT TO authenticated
  USING (
    (
      project_persona_documents.is_hidden_rubric IS NOT TRUE
      AND project_persona_documents.group_id IS NOT NULL
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

-- 4) Eenmalige verhuizing course_personas → project_personas voor Welzijn.
DO $$
DECLARE
  v_project_id uuid;
  v_course_id uuid;
BEGIN
  SELECT id, course_id INTO v_project_id, v_course_id
  FROM projects
  WHERE title ILIKE '%Welzijn%Waterlandplein%'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_project_id IS NULL OR v_course_id IS NULL THEN
    RAISE NOTICE 'Welzijn-project niet gevonden of zonder course_id; skip persona-migratie.';
    RETURN;
  END IF;

  -- Idempotent inserten: alleen wanneer (project_id, source_persona_id) nog
  -- niet bestaat. Hierdoor kan deze migratie rerunnen zonder duplicates.
  INSERT INTO project_personas
    (project_id, source_persona_id, name, avatar_emoji, system_prompt,
     rag_enabled, rag_folder_ids, visible_from_phase, sort_order, persona_type)
  SELECT v_project_id, cp.id, cp.name, cp.avatar_emoji, cp.system_prompt,
         cp.rag_enabled, cp.rag_folder_ids, cp.visible_from_phase,
         ROW_NUMBER() OVER (ORDER BY cp.is_default DESC, cp.created_at) - 1,
         COALESCE(cp.persona_type, 'conversational')
  FROM course_personas cp
  WHERE cp.course_id = v_course_id
    AND NOT EXISTS (
      SELECT 1 FROM project_personas pp
      WHERE pp.project_id = v_project_id AND pp.source_persona_id = cp.id
    );

  -- Verwijder course_personas van die cursus zodat de bibliotheek leeg
  -- start; project-personas blijven bestaan via de kopie hierboven.
  DELETE FROM course_personas WHERE course_id = v_course_id;
END $$;
