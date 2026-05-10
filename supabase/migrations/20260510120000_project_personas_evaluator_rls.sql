-- Verberg evaluator-persona's voor studenten op DB-niveau zodat directe
-- Supabase-queries (buiten de gecureerde API om) deze rijen niet meer
-- kunnen ophalen. Staff (admin/docent/superuser) ziet alle persona's.
DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas
  FOR SELECT TO authenticated
  USING (
    -- Staff/superuser: alles
    pr_is_admin()
    OR EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND (profiles.role = 'docent' OR profiles.email = 'l.d.j.kuijper@vu.nl')
    )
    -- Studenten: alleen niet-evaluator-persona's van projecten waar ze lid van zijn
    OR (
      COALESCE(persona_type, 'conversational') <> 'evaluator'
      AND EXISTS (
        SELECT 1 FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
        WHERE g.project_id = project_personas.project_id
          AND m.user_id = auth.uid()
      )
    )
  );
