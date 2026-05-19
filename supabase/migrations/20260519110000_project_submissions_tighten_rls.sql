-- Task #156 follow-up: RLS van project_submissions strakker scopen op cursus
-- (een docent uit een ándere cursus mag deze rows niet zien), plus een trigger
-- die afdwingt dat project_submissions.project_id daadwerkelijk overeenkomt
-- met project_groups.project_id van de bijbehorende groep.

BEGIN;

DROP POLICY IF EXISTS project_submissions_select ON project_submissions;
CREATE POLICY project_submissions_select ON project_submissions FOR SELECT
  TO authenticated
  USING (
    pr_is_admin()
    OR pr_is_group_member(group_id)
    OR EXISTS (
      SELECT 1
        FROM projects p
        JOIN course_members cm ON cm.course_id = p.course_id
       WHERE p.id = project_submissions.project_id
         AND cm.user_id = auth.uid()
         AND cm.role IN ('teacher', 'docent', 'admin')
    )
  );

DROP POLICY IF EXISTS project_submissions_delete ON project_submissions;
CREATE POLICY project_submissions_delete ON project_submissions FOR DELETE
  TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (
      SELECT 1
        FROM projects p
        JOIN course_members cm ON cm.course_id = p.course_id
       WHERE p.id = project_submissions.project_id
         AND cm.user_id = auth.uid()
         AND cm.role IN ('teacher', 'docent', 'admin')
    )
  );

-- Integriteit: zorg dat (project_id, group_id) consistent zijn — de groep moet
-- bij hetzelfde project horen. Voorkomt dat een rij ontstaat waarin het
-- project_id wijst naar een ander project dan dat van de groep.
CREATE OR REPLACE FUNCTION project_submissions_check_group_project()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_group_project uuid;
BEGIN
  SELECT project_id INTO v_group_project
    FROM project_groups WHERE id = NEW.group_id;
  IF v_group_project IS NULL THEN
    RAISE EXCEPTION 'project_submissions: groep % bestaat niet', NEW.group_id;
  END IF;
  IF v_group_project <> NEW.project_id THEN
    RAISE EXCEPTION 'project_submissions: project_id % komt niet overeen met project_id % van groep %',
      NEW.project_id, v_group_project, NEW.group_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS project_submissions_check_group_project_trg ON project_submissions;
CREATE TRIGGER project_submissions_check_group_project_trg
  BEFORE INSERT OR UPDATE OF project_id, group_id ON project_submissions
  FOR EACH ROW EXECUTE FUNCTION project_submissions_check_group_project();

COMMIT;
