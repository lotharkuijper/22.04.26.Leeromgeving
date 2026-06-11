-- Task #270: Cursus op "niet beschikbaar" zetten.
--
-- Doel: een docent/admin kan een cursus tijdelijk verbergen voor studenten
-- (bijv. tijdens onderhoud of opbouw) zonder hem te archiveren. We gebruiken
-- bewust een aparte boolean `student_visible` naast het bestaande `is_active`:
--   - is_active      = actief / gearchiveerd (bestaande betekenis, ongemoeid).
--   - student_visible = zichtbaar/selecteerbaar voor studenten ja/nee.
--
-- Standaard zijn alle (bestaande) cursussen zichtbaar, zodat de migratie niets
-- onbedoeld verbergt. De server detecteert de kolom defensief
-- (coursesHasStudentVisible) zodat een nog-niet-gemigreerde DB blijft werken.

BEGIN;

-- 1) Beschikbaarheidsvlag toevoegen (default true = zichtbaar).
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS student_visible boolean NOT NULL DEFAULT true;

-- 2) RLS herzien. De oude SELECT-policy liet iedere ingelogde gebruiker elke
--    actieve cursus zien (USING is_active = true). Die vervangen we door een
--    policy die:
--      a) studenten alleen beschikbare cursussen toont
--         (is_active = true AND student_visible = true), én
--      b) de docent(en) van een specifieke cursus die cursus áltijd laat zien,
--         ook als hij verborgen of inactief is, zodat zij eraan kunnen blijven
--         werken.
--    Admins/superuser vallen onder de bestaande "Admins can manage all
--    courses" FOR ALL-policy en houden volledige toegang.
--
--    is_course_teacher() is SECURITY DEFINER en bevraagt alleen course_members
--    (geen courses-self-reference), dus er is geen RLS-recursie.
DROP POLICY IF EXISTS "All authenticated users can view active courses" ON courses;

CREATE POLICY "Students see available courses, teachers see own"
  ON courses FOR SELECT
  TO authenticated
  USING (
    (is_active = true AND student_visible = true)
    OR is_course_teacher(auth.uid(), id)
  );

COMMIT;
