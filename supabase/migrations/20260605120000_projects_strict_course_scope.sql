-- Projecten zijn strikt cursus-gebonden. De eerdere RLS gaf ELKE globale docent
-- (profiles.role='docent') toegang tot ALLE projecten, ongeacht cursus, plus een
-- is_public-brede leesrechten-policy. Daardoor kon bijvoorbeeld iemand uit de
-- cursus "Multilevel Analyse" het MenS1-project "Waterlandpleinbuurt" zien of
-- beheren. Toegang hoort uitsluitend te lopen via cursus-lidmaatschap
-- (course_members) van de cursus van het project, via admin/superuser, of via
-- groepslidmaatschap binnen het project zelf. Delen naar een andere cursus
-- gebeurt door het project te kopiëren — niet door brede leesrechten.

-- 1. pr_user_has_course_access: vervang de blanket docent-grant door echt
--    cursus-lidmaatschap. course_members bevat zowel docenten als studenten van
--    de cursus, dus dit dekt beide rollen correct. Admin en de
--    groepslidmaatschap-fallback blijven behouden.
CREATE OR REPLACE FUNCTION pr_user_has_course_access(p_course_id uuid) RETURNS boolean AS $$
  SELECT pr_is_admin()
      OR EXISTS (
        SELECT 1 FROM course_members cm
         WHERE cm.user_id = auth.uid() AND cm.course_id = p_course_id
      )
      OR EXISTS (
        SELECT 1
          FROM project_group_members m
          JOIN project_groups g ON g.id = m.group_id
          JOIN projects p       ON p.id = g.project_id
         WHERE m.user_id = auth.uid()
           AND p.course_id = p_course_id
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 2. projects: verwijder de drie te brede policies en herdefinieer strikt
--    cursus-gebonden.
DROP POLICY IF EXISTS "Docenten and admin can manage projects" ON projects;
DROP POLICY IF EXISTS "Students can read public projects" ON projects;
DROP POLICY IF EXISTS projects_course_member_select ON projects;

-- 2a. Lezen: docent van de cursus van dit project, lid van die cursus, admin, of
--     groepslid van een project binnen die cursus (via pr_user_has_course_access).
CREATE POLICY projects_course_member_select ON projects FOR SELECT TO authenticated
  USING (
    pr_is_course_teacher(course_id)
    OR (course_id IS NOT NULL AND pr_user_has_course_access(course_id))
  );

-- 2b. Beheren (insert/update/delete): alleen docent van de cursus (of admin).
--     WITH CHECK dwingt af dat een nieuw/gewijzigd project bij een cursus hoort
--     waar de docent daadwerkelijk lid van is.
CREATE POLICY projects_course_teacher_manage ON projects FOR ALL TO authenticated
  USING (pr_is_course_teacher(course_id))
  WITH CHECK (pr_is_course_teacher(course_id));

-- 3. project_personas SELECT: vervang de blanket docent-grant door docent van de
--    cursus van dit project, zodat persona-definities van een project niet aan
--    docenten van andere cursussen lekken.
DROP POLICY IF EXISTS project_personas_select ON project_personas;
CREATE POLICY project_personas_select ON project_personas FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (
      SELECT 1 FROM projects p
       WHERE p.id = project_personas.project_id
         AND pr_is_course_teacher(p.course_id)
    )
    OR EXISTS (
      SELECT 1
        FROM project_groups g
        JOIN project_group_members m ON m.group_id = g.id
       WHERE g.project_id = project_personas.project_id
         AND m.user_id = auth.uid()
    )
  );
