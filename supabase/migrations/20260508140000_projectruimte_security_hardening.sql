-- Task #78 (vervolg): RLS-hardening + checkpoint-idempotentie.
-- Architect-review wees op te brede SELECT-policies en het ontbreken van
-- dedupe op checkpoint-writes. Deze migratie:
-- 1) Beperkt course_personas/project_personas SELECT tot groepsleden +
--    docenten/admins (i.p.v. iedere ingelogde user).
-- 2) Voegt request_id toe aan group_checkpoints met unique-constraint per
--    groep, zodat client-side retries idempotent zijn.

-- 1a. Helper: heeft de huidige user toegang tot een cursus via
--     course_member-rol of course_collaborators? Bestaat al niet —
--     we gebruiken de ruwe profiles.role join om student-toegang te bepalen.
--     Voor MVP definiëren we toegang als: lid van een project_group binnen
--     een project van die cursus, OF docent/admin.
CREATE OR REPLACE FUNCTION pr_user_has_course_access(p_course_id uuid) RETURNS boolean AS $$
  SELECT pr_is_admin()
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent')
      OR EXISTS (
        SELECT 1
          FROM project_group_members m
          JOIN project_groups g ON g.id = m.group_id
          JOIN projects p       ON p.id = g.project_id
         WHERE m.user_id = auth.uid()
           AND p.course_id = p_course_id
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 1b. course_personas: SELECT alleen voor docenten/admins of users met
--     toegang tot de cursus.
DROP POLICY IF EXISTS course_personas_select ON course_personas;
CREATE POLICY course_personas_select ON course_personas FOR SELECT TO authenticated
  USING (pr_user_has_course_access(course_id));

-- 1c. project_personas: SELECT alleen als je lid bent van een groep in dit
--     project, of docent/admin van de cursus van dit project.
DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent')
    OR EXISTS (
      SELECT 1
        FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
    )
  );

-- 2. Checkpoint-idempotentie: client stuurt een UUID bij elke retry; dezelfde
--    UUID binnen dezelfde groep mag maar één keer slagen.
ALTER TABLE group_checkpoints
  ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS group_checkpoints_request_id_idx
  ON group_checkpoints(group_id, request_id) WHERE request_id IS NOT NULL;
