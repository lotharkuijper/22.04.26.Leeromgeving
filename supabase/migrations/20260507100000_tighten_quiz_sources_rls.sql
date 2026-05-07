-- Migratie: verstrak RLS op de drie quiz-bronnen-tabellen (Task #59).
--
-- De oorspronkelijke SELECT-policies (uit 20260430160000) gaven elke
-- ingelogde gebruiker leesrecht op alle cursussen via de Supabase-client.
-- Dat is bedoeld als docent/admin-data en hoort niet rechtstreeks vanuit
-- de browser opvraagbaar te zijn voor een willekeurige student.
--
-- Server-routes draaien met de service-role key en omzeilen RLS sowieso.
-- We vervangen daarom de read-all-authenticated policies door policies
-- die alleen admins/docenten toegang geven (server-routes blijven werken;
-- studenten kunnen de tabellen niet meer rechtstreeks queryen).

-- concept_itembank_sections ---------------------------------------------------
DROP POLICY IF EXISTS "concept_itembank_sections_read_authenticated" ON concept_itembank_sections;

DROP POLICY IF EXISTS "concept_itembank_sections_read_admin_docent" ON concept_itembank_sections;
CREATE POLICY "concept_itembank_sections_read_admin_docent" ON concept_itembank_sections
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );

-- concept_rag_sources ---------------------------------------------------------
DROP POLICY IF EXISTS "concept_rag_sources_read_authenticated" ON concept_rag_sources;

DROP POLICY IF EXISTS "concept_rag_sources_read_admin_docent" ON concept_rag_sources;
CREATE POLICY "concept_rag_sources_read_admin_docent" ON concept_rag_sources
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
  );

-- quiz_sources_mix ------------------------------------------------------------
-- Hier mogen ook studenten de mix lezen voor cursussen waar ze lid van zijn,
-- omdat de quiz-generator (client-zijde fallback) deze waarde gebruikt.
DROP POLICY IF EXISTS "quiz_sources_mix_read_authenticated" ON quiz_sources_mix;

DROP POLICY IF EXISTS "quiz_sources_mix_read_course_member" ON quiz_sources_mix;
CREATE POLICY "quiz_sources_mix_read_course_member" ON quiz_sources_mix
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','docent'))
    OR EXISTS (
      SELECT 1 FROM course_members cm
      WHERE cm.user_id = auth.uid() AND cm.course_id = quiz_sources_mix.course_id
    )
  );
