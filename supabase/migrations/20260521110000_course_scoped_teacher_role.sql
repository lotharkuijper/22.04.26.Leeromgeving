-- Task #165: Per-cursus docentrol via course_members.member_role
--
-- Doel: 'docent' is geen globale rol meer maar een rol per cursus.
-- - Admin/superuser blijft globaal almachtig.
-- - Bestaande globaal 'docent'-profielen worden teruggezet naar 'student';
--   beheerder wijst per cursus opnieuw aan via course_members.member_role.
-- - course_members krijgt een member_role 'student' | 'teacher' (default
--   'student'). Bestaande rijen blijven 'student' (gebruikerswens).
-- - profiles.role check-constraint wordt versoepeld zodat 'docent' nog
--   blijft accepteren (backward compat), maar de seed/default is 'student'.

BEGIN;

-- 1) Kolom toevoegen aan course_members
ALTER TABLE course_members
  ADD COLUMN IF NOT EXISTS member_role text NOT NULL DEFAULT 'student'
    CHECK (member_role IN ('student', 'teacher'));

-- 2) Index voor snelle "is deze user teacher in cursus X?"-checks
CREATE INDEX IF NOT EXISTS idx_course_members_user_role
  ON course_members(user_id, course_id, member_role);

-- 3) Backfill: alle bestaande course_members beginnen op 'student'.
--    (Beheerder promoveert per cursus opnieuw via de admin-UI.)
UPDATE course_members SET member_role = 'student' WHERE member_role IS NULL;

-- 4) Alle huidige globaal-docenten terugzetten naar student (behalve admin).
--    Admin/superuser blijft admin.
UPDATE profiles
   SET role = 'student'
 WHERE role = 'docent';

-- 5) Helper-functie: is gebruiker docent (teacher) in deze cursus?
--    Admins krijgen via app-laag al toegang; deze functie checkt puur
--    per-cursus lidmaatschap met member_role='teacher'.
CREATE OR REPLACE FUNCTION is_course_teacher(p_user uuid, p_course uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_members
     WHERE user_id = p_user
       AND course_id = p_course
       AND member_role = 'teacher'
  );
$$;

COMMIT;
