/*
  # concept_evidence RLS verstrengen (Task #243)

  De oorspronkelijke leespolicy gaf élke geauthenticeerde gebruiker directe
  cross-course leestoegang tot `concept_evidence` via de Supabase API. Dat
  ondermijnt de cursus-isolatie, ook al filtert het server-endpoint al per
  cursus. We vervangen de policy door een cursus-scoped variant: alleen
  admins/superuser en leden van de betreffende cursus mogen rijen lezen.

  Schrijven gebeurt uitsluitend server-side via de service-role (die RLS
  omzeilt), dus er zijn geen INSERT/UPDATE/DELETE-policies voor authenticated.
*/

DROP POLICY IF EXISTS "concept_evidence_read_authenticated" ON concept_evidence;
DROP POLICY IF EXISTS "concept_evidence_admin_all" ON concept_evidence;

DROP POLICY IF EXISTS concept_evidence_select ON concept_evidence;
CREATE POLICY concept_evidence_select ON concept_evidence
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM profiles pr
       WHERE pr.id = auth.uid()
         AND (pr.role = 'admin' OR pr.email = 'l.d.j.kuijper@vu.nl')
    )
    OR EXISTS (
      SELECT 1 FROM course_members cm
       WHERE cm.course_id = concept_evidence.course_id
         AND cm.user_id = auth.uid()
    )
  );
