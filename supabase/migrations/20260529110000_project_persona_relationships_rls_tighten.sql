-- Task #167 / Fase 2 — RLS verstrengen na code-review.
-- Studenten zagen via directe Supabase-queries de exacte score + history;
-- de API maskeerde dit al, maar de tabel-policy moet hetzelfde doen.
-- Nieuwe regel: SELECT alleen voor staff (admin/superuser/teacher van de
-- bijbehorende cursus). Studenten lezen uitsluitend via de server-endpoints
-- (`GET .../relationships`) die met service-role draaien en zelf filteren.

BEGIN;

DROP POLICY IF EXISTS ppr_select ON project_persona_relationships;
CREATE POLICY ppr_select ON project_persona_relationships
  FOR SELECT USING (
    EXISTS (
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

COMMIT;
