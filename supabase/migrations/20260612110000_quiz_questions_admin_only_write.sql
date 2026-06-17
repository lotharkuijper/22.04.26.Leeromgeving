-- Vergrendel de gedeelde vragenbank (quiz_questions) op write-niveau tot admins.
--
-- Waarom: de oude write-policy "Docenten and admin can manage questions" gaf
-- `profiles.role IN ('docent','admin')` schrijfrecht op de globaal-gedeelde
-- vragenpool. In deze app dragen docenten echter `profiles.role='student'` —
-- hun docentstatus is per cursus (`course_members.member_role`). De ItemBank-
-- import is sinds Task #278 in de UI al admin-only, en op datalaag-niveau is het
-- nu alleen toevallig admin-beperkt: niemand heeft `profiles.role='docent'`.
-- Dat is fragiel — zodra iemand ooit de legacy globale 'docent'-rol krijgt,
-- herwint die stil schrijfrecht op de gedeelde pool. Door de policy expliciet
-- tot `profiles.role = 'admin'` te beperken maken we de bedoeling hard en
-- verwijderen we de toevallige afhankelijkheid van de 'docent'-grant.
--
-- Alleen de write-kant (FOR ALL) verandert. De SELECT-policy blijft ongewijzigd:
-- studenten lezen validated vragen, staff (admin) leest alles zoals voorheen.
-- Server-side generatie/import draait via de service-role (supabaseAdmin) en
-- omzeilt RLS, dus die paden zijn onaangetast.

DROP POLICY IF EXISTS "Docenten and admin can manage questions" ON quiz_questions;

CREATE POLICY "Admins can manage questions"
  ON quiz_questions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
