/*
  # student_course_levels (Task #296)

  Per student + cursus een zelfgekozen leerniveau (1..5, beginner→expert). De
  student bepaalt het niveau zelf; de bot adviseert alleen op aanvraag. Studenten
  hoeven geen `course_members`-rij te hebben (toegang is zichtbaarheids-gebaseerd),
  daarom bewaren we dit in een eigen tabel i.p.v. in `profiles` (dat enkel globale
  voorkeuren bevat zoals taal/laatst-actieve-cursus).

  RLS: een student leest/schrijft UITSLUITEND zijn/haar eigen rij. De server kan
  via de service-role lezen waar nodig (RLS-omzeiling).
*/

CREATE TABLE IF NOT EXISTS student_course_levels (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  level smallint NOT NULL DEFAULT 2 CHECK (level >= 1 AND level <= 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);

ALTER TABLE student_course_levels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS student_course_levels_select_own ON student_course_levels;
CREATE POLICY student_course_levels_select_own ON student_course_levels
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS student_course_levels_insert_own ON student_course_levels;
CREATE POLICY student_course_levels_insert_own ON student_course_levels
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS student_course_levels_update_own ON student_course_levels;
CREATE POLICY student_course_levels_update_own ON student_course_levels
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS student_course_levels_delete_own ON student_course_levels;
CREATE POLICY student_course_levels_delete_own ON student_course_levels
  FOR DELETE USING (auth.uid() = user_id);
