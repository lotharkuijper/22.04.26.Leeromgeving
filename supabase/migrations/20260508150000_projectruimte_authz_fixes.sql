-- Task #78 vervolg: drie autorisatie-/integriteitsfixes na architect-review.
-- 1) pr_is_course_teacher() respecteerde p_course_id niet — elke docent kreeg
--    write-access op course_personas van iedere cursus. Nu binden we docent-
--    rol aan effectief course_members-lidmaatschap (of admin/superuser).
-- 2) projects-tabel RLS verbreden zodat studenten projecten in cursussen waar
--    ze lid van zijn óók kunnen zien (niet alleen is_public=true). Anders
--    mislukt /projects voor studenten met course-gebonden projecten.
-- 3) group_chat_messages UPDATE-policy: alleen reactions mogen door andere
--    leden gewijzigd worden; body alleen door de auteur.

-- 1. pr_is_course_teacher: course-scoped
CREATE OR REPLACE FUNCTION pr_is_course_teacher(p_course_id uuid) RETURNS boolean AS $$
  SELECT pr_is_admin() OR EXISTS (
    SELECT 1
      FROM profiles p
      JOIN course_members cm ON cm.user_id = p.id
     WHERE p.id = auth.uid()
       AND p.role = 'docent'
       AND cm.course_id = p_course_id
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 2. projects SELECT verbreden: bestaande policy "Students can read public
--    projects" blijft, voeg eigen course-scoped policy toe.
DROP POLICY IF EXISTS projects_course_member_select ON projects;
CREATE POLICY projects_course_member_select ON projects FOR SELECT TO authenticated
  USING (
    pr_is_admin()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'docent')
    OR (course_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM course_members cm
       WHERE cm.course_id = projects.course_id AND cm.user_id = auth.uid()
    ))
  );

-- 3. group_chat_messages: scheid update door auteur (mag alles) van update door
--    medeleden (mag alleen reactions). Postgres RLS staat geen kolom-level
--    beperking direct toe; we splitsen op USING/WITH CHECK met een trigger die
--    body-wijzigingen door niet-auteur weigert.
DROP POLICY IF EXISTS gcm_update ON group_chat_messages;
CREATE POLICY gcm_update ON group_chat_messages FOR UPDATE TO authenticated
  USING (pr_is_group_member(group_id))
  WITH CHECK (pr_is_group_member(group_id));

CREATE OR REPLACE FUNCTION gcm_protect_body() RETURNS trigger AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body AND OLD.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Alleen de auteur mag het bericht wijzigen';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id mag niet gewijzigd worden';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'group_id mag niet gewijzigd worden';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gcm_protect_body_trg ON group_chat_messages;
CREATE TRIGGER gcm_protect_body_trg
  BEFORE UPDATE ON group_chat_messages
  FOR EACH ROW EXECUTE FUNCTION gcm_protect_body();
