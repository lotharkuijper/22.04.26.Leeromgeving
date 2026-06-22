-- Task #334 — Verstreng de SELECT op quiz_sources_mix tot admin OF docent van de
-- cursus. Dit is door docenten beheerde mix-configuratie (geen student-zichtbare
-- content): de client leest de tabel niet rechtstreeks (quizgeneratie draait
-- server-side met de service-role), dus de eerdere "elk cursuslid mag lezen"-tak
-- gaf studenten onnodig direct leestoegang tot docent-config. Schrijven was al
-- admin OF course teacher; we laten dat ongemoeid.

DROP POLICY IF EXISTS quiz_sources_mix_read_member_or_course_teacher ON public.quiz_sources_mix;

CREATE POLICY quiz_sources_mix_read_admin_or_course_teacher
  ON public.quiz_sources_mix
  FOR SELECT
  USING (is_admin() OR is_course_teacher(auth.uid(), course_id));
